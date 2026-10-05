//! Gamepad input, polled here and sent to the frontend as abstract actions.
//!
//! Not the browser Gamepad API: support varies between webviews, it is silent
//! until a user interaction, and it stops when a game takes focus. Auto-repeat
//! also lives here so it keeps running while the webview is busy.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gilrs::{Axis, Button, EventType, Gilrs};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Tuned by hand with a pad.
const REPEAT_DELAY: Duration = Duration::from_millis(380);
const REPEAT_RATE: Duration = Duration::from_millis(95);
const DEADZONE: f32 = 0.55;
const POLL: Duration = Duration::from_millis(4);

/// The only input vocabulary the rest of the app sees.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Up,
    Down,
    Left,
    Right,
    A,
    B,
    X,
    Y,
    Lb,
    Rb,
    Menu,
    Add,
    /// Open the sort menu (left stick click).
    Sort,
    /// Open the library search field (right stick click).
    Search,
}

impl Action {
    /// Only directions and bumpers repeat; a repeating confirm launches twice.
    fn repeats(self) -> bool {
        matches!(
            self,
            Action::Up | Action::Down | Action::Left | Action::Right | Action::Lb | Action::Rb
        )
    }
}

#[derive(Clone, Serialize)]
pub struct InputEvent {
    pub action: Action,
    /// From auto-repeat rather than a fresh press.
    pub repeat: bool,
    /// Milliseconds since the input thread started, for measuring latency
    /// with `clock_sync`.
    pub t: f64,
}

fn button_action(b: Button) -> Option<Action> {
    Some(match b {
        Button::DPadUp => Action::Up,
        Button::DPadDown => Action::Down,
        Button::DPadLeft => Action::Left,
        Button::DPadRight => Action::Right,
        Button::South => Action::A,
        Button::East => Action::B,
        Button::West => Action::X,
        Button::North => Action::Y,
        // gilrs's LeftTrigger is the bumper; LeftTrigger2 is the analogue
        // trigger. Triggers are unmapped because on Windows they also report as
        // axes and emit constantly, which interfered with the bumpers.
        Button::LeftTrigger => Action::Lb,
        Button::RightTrigger => Action::Rb,
        Button::LeftThumb => Action::Sort,
        Button::RightThumb => Action::Search,
        Button::Start => Action::Menu,
        Button::Select => Action::Add,
        _ => return None,
    })
}

/// The direction currently held on one stick axis.
struct AxisState {
    held: Option<Action>,
}

/// Mutes a control that reports faster than a hand can press it. A DualSense
/// over Bluetooth on macOS phantom-presses both bumpers about seven times a
/// second, so paging cancelled itself out and the bumpers looked dead.
struct Noise {
    /// (pad, action, burst start, last seen, presses). Keyed by pad so one
    /// noisy controller does not mute the same button on another.
    seen: Vec<(usize, Action, Instant, Instant, u32)>,
}

/// Presses per second that no hand sustains for long.
const NOISE_RATE: f64 = 5.0;
/// Presses needed before the rate is trusted.
const NOISE_PRESSES: u32 = 20;
/// Silence after which a burst is over.
const NOISE_QUIET: Duration = Duration::from_secs(2);

impl Noise {
    fn new() -> Self {
        Noise { seen: Vec::new() }
    }

    /// True if this press should be ignored. Judged on rate, because a fixed
    /// window let continuous noise through each time the window reset.
    fn muted(&mut self, pad: usize, action: Action, now: Instant) -> bool {
        let existing = self
            .seen
            .iter_mut()
            .find(|(p, a, ..)| *p == pad && *a == action);
        let Some(slot) = existing else {
            self.seen.push((pad, action, now, now, 1));
            return false;
        };
        let (_, _, first, last, count) = slot;

        if now.duration_since(*last) > NOISE_QUIET {
            *first = now;
            *last = now;
            *count = 1;
            return false;
        }
        *last = now;
        *count += 1;

        if *count < NOISE_PRESSES {
            return false;
        }
        let elapsed = now.duration_since(*first).as_secs_f64();
        elapsed > 0.0 && f64::from(*count) / elapsed > NOISE_RATE
    }

    /// Whether this press crossed the threshold, so the warning is logged once.
    fn just_crossed(&self, pad: usize, action: Action) -> bool {
        self.seen
            .iter()
            .any(|(p, a, _, _, c)| *p == pad && *a == action && *c == NOISE_PRESSES)
    }

    /// What is currently being ignored, shown in Settings.
    fn silenced(&self, now: Instant) -> Vec<Action> {
        let mut out: Vec<Action> = self
            .seen
            .iter()
            .filter(|(_, _, first, last, c)| {
                *c >= NOISE_PRESSES
                    && now.duration_since(*last) <= NOISE_QUIET
                    && f64::from(*c) / now.duration_since(*first).as_secs_f64().max(0.001)
                        > NOISE_RATE
            })
            .map(|(_, a, ..)| *a)
            .collect();
        out.dedup();
        out
    }
}

/// What is auto-repeating, and what started it. Only a stick's repeat ends
/// when the sticks rest: Windows triggers twitch as axes and cut bumper repeat.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Repeat {
    action: Action,
    due: Instant,
    from_stick: bool,
}

impl Repeat {
    fn from_button(action: Action, now: Instant) -> Self {
        Repeat {
            action,
            due: now + REPEAT_DELAY,
            from_stick: false,
        }
    }
    fn from_stick(action: Action, now: Instant) -> Self {
        Repeat {
            action,
            due: now + REPEAT_DELAY,
            from_stick: true,
        }
    }
    /// Whether the sticks going quiet should end this.
    fn ends_with_the_sticks(&self) -> bool {
        self.from_stick
    }
    /// Whether releasing `action` should end this.
    fn ends_with_button(&self, action: Action) -> bool {
        !self.from_stick && self.action == action
    }
}

impl AxisState {
    fn update(&mut self, value: f32, neg: Action, pos: Action) -> Option<Action> {
        let next = if value <= -DEADZONE {
            Some(neg)
        } else if value >= DEADZONE {
            Some(pos)
        } else {
            None
        };
        if next != self.held {
            self.held = next;
            return next;
        }
        None
    }
}

/// Live input state for the interface. Carries a diagnosis as well as a count,
/// since "no controller" can mean no backend, no devices or an unmapped device.
#[derive(Default)]
pub struct Status {
    /// False means this machine has no gamepad support at all.
    pub supported: AtomicBool,
    pub connected: AtomicUsize,
    /// One line per device the backend enumerated.
    pub devices: Mutex<Vec<String>>,
    /// Why there is no input, when there is a reason worth repeating.
    pub failure: Mutex<Option<String>>,
    /// Controls muted as noise, so the muting is visible.
    pub silenced: Mutex<Vec<String>>,
}

impl Status {
    fn fail(&self, why: String) {
        crate::log_error!("input", "{why}");
        if let Ok(mut slot) = self.failure.lock() {
            *slot = Some(why);
        }
    }
}

/// The platform API in use. On Windows gilrs defaults to WGI, not XInput, so
/// any HID pad is visible; claiming XInput once sent users to DS4Windows.
pub const BACKEND: &str = if cfg!(target_os = "windows") {
    "Windows.Gaming.Input"
} else if cfg!(target_os = "macos") {
    "IOKit"
} else {
    "evdev"
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadStatus {
    pub supported: bool,
    pub connected: usize,
    pub backend: &'static str,
    /// Empty means the backend is running and found no pad.
    pub devices: Vec<String>,
    pub failure: Option<String>,
    pub silenced: Vec<String>,
}

#[tauri::command]
pub fn pad_status(status: tauri::State<'_, Arc<Status>>) -> PadStatus {
    PadStatus {
        supported: status.supported.load(Ordering::Relaxed),
        connected: status.connected.load(Ordering::Relaxed),
        backend: BACKEND,
        devices: status.devices.lock().map(|d| d.clone()).unwrap_or_default(),
        failure: status.failure.lock().ok().and_then(|f| f.clone()),
        silenced: status
            .silenced
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default(),
    }
}

/// Spawn the poll thread. A missing or failing backend logs once and leaves
/// the app usable from the keyboard.
pub fn spawn(app: AppHandle, start: Instant) -> Arc<Status> {
    let status = Arc::new(Status::default());
    let shared = status.clone();

    std::thread::spawn(move || {
        // gilrs panics on WinRT setup failures, and a thread panic otherwise
        // vanishes, looking exactly like an unplugged controller.
        let inner = shared.clone();
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || run(app, start, inner)));
        if let Err(payload) = outcome {
            let why = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "no message".into());
            shared.fail(format!(
                "the gamepad thread stopped: {why}. {BACKEND} is unavailable, \
                 so the interface is keyboard and mouse only."
            ));
        }
    });

    status
}

fn run(app: AppHandle, start: Instant, shared: Arc<Status>) {
    let mut gilrs = match Gilrs::new() {
        Ok(g) => g,
        Err(e) => {
            shared.fail(format!(
                "no gamepad support via {BACKEND}: {e}. Keyboard and mouse only."
            ));
            return;
        }
    };
    shared.supported.store(true, Ordering::Relaxed);
    let mut pads = 0usize;
    let mut seen: Vec<String> = Vec::new();
    for (_id, pad) in gilrs.gamepads() {
        // Shown in Settings: "enumerated but unmapped" differs from "nothing".
        let line = format!(
            "{} — {} mapping, {}",
            pad.name(),
            match pad.mapping_source() {
                gilrs::MappingSource::SdlMappings => "SDL",
                gilrs::MappingSource::Driver => "driver",
                gilrs::MappingSource::None => "no",
            },
            if pad.is_connected() {
                "connected"
            } else {
                "not connected"
            },
        );
        crate::log_info!("input", "{line} (via {BACKEND})");
        seen.push(line);
        pads += 1;
    }
    if let Ok(mut d) = shared.devices.lock() {
        *d = seen;
    }
    shared.connected.store(pads, Ordering::Relaxed);

    // Wait before warning of no pad: devices arrive as Connected events a few
    // milliseconds after startup enumeration.
    let decide_at = Instant::now() + Duration::from_secs(3);
    let mut reported = false;

    let mut held: Option<Repeat> = None;
    let mut noise = Noise::new();
    let mut last_published = Instant::now();
    let mut xs = AxisState { held: None };
    let mut ys = AxisState { held: None };

    // Both emits: the only listener is the webview, and a closed webview is
    // not an error.
    let emit = |action: Action, repeat: bool| {
        let _ = app.emit(
            "input",
            InputEvent {
                action,
                repeat,
                t: start.elapsed().as_secs_f64() * 1000.0,
            },
        );
    };

    loop {
        while let Some(ev) = gilrs.next_event() {
            match ev.event {
                EventType::ButtonPressed(b, code) => {
                    if let Some(a) = button_action(b) {
                        let now = Instant::now();
                        let pad = usize::from(ev.id);
                        if noise.muted(pad, a, now) {
                            if noise.just_crossed(pad, a) {
                                crate::log_warn!(
                                    "input",
                                    "{b:?} is reporting faster than anyone can press it \
                                     and is being ignored until it stops"
                                );
                            }
                            continue;
                        }
                        // Bounded by how fast a person presses; repeats are
                        // not logged.
                        crate::log_debug!("input", "{b:?} -> {a:?}");
                        emit(a, false);
                        if a.repeats() {
                            held = Some(Repeat::from_button(a, now));
                        }
                    } else {
                        // Otherwise unmapped buttons look like a dead pad.
                        let what = format!("{b:?} ({code})");
                        crate::log_warn!("input", "unmapped button {what}");
                        let _ = app.emit("input-unmapped", what);
                    }
                }
                EventType::ButtonReleased(b, _) => {
                    if let Some(a) = button_action(b) {
                        if matches!(held, Some(h) if h.ends_with_button(a)) {
                            held = None;
                        }
                    }
                }
                EventType::AxisChanged(axis, v, _) => {
                    let changed = match axis {
                        Axis::LeftStickX => xs.update(v, Action::Left, Action::Right),
                        Axis::LeftStickY => ys.update(v, Action::Down, Action::Up),
                        _ => None,
                    };
                    match changed {
                        Some(a) => {
                            // Not logged: sticks fire several times a
                            // second and would drown the debug log.
                            emit(a, false);
                            held = Some(Repeat::from_stick(a, Instant::now()));
                        }
                        None => {
                            // Ends a stick's repeat only, never a bumper's.
                            if xs.held.is_none()
                                && ys.held.is_none()
                                && matches!(held, Some(h) if h.ends_with_the_sticks())
                            {
                                held = None;
                            }
                        }
                    }
                }
                EventType::Connected => {
                    shared.connected.fetch_add(1, Ordering::Relaxed);
                    crate::log_info!("input", "gamepad connected");
                }
                EventType::Disconnected => {
                    // Saturating: a disconnect can arrive for a pad never
                    // counted. try_update needs 1.95; the MSRV is 1.77.
                    #[allow(deprecated)]
                    let _ =
                        shared
                            .connected
                            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                                Some(n.saturating_sub(1))
                            });
                    crate::log_info!("input", "gamepad disconnected");
                }
                _ => {}
            }
        }

        if !reported && Instant::now() >= decide_at {
            reported = true;
            if shared.connected.load(Ordering::Relaxed) == 0 {
                // State the fact only; a guessed fix once sent users astray.
                crate::log_warn!(
                    "input",
                    "no gamepad after 3s. {BACKEND} started and enumerated nothing."
                );
            }
        }

        if let Some(r) = held {
            let now = Instant::now();
            if now >= r.due {
                emit(r.action, true);
                held = Some(Repeat {
                    due: now + REPEAT_RATE,
                    ..r
                });
            }
        }

        // Publish muted controls to Settings about once a second.
        if last_published.elapsed() >= Duration::from_secs(1) {
            last_published = Instant::now();
            let now = Instant::now();
            let names: Vec<String> = noise
                .silenced(now)
                .iter()
                .map(|a| format!("{a:?}"))
                .collect();
            if let Ok(mut slot) = shared.silenced.lock() {
                if *slot != names {
                    *slot = names;
                }
            }
        }

        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GamepadId cannot be built outside gilrs, so tests use its usize form.
    const PAD: usize = 0;
    const OTHER_PAD: usize = 1;

    /// The rate an idle DualSense over Bluetooth reported on macOS.
    #[test]
    fn a_button_reporting_faster_than_a_hand_is_muted() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        let mut muted_after = None;
        for i in 0..60u32 {
            let at = t0 + Duration::from_millis(140 * i as u64);
            if n.muted(PAD, Action::Lb, at) && muted_after.is_none() {
                muted_after = Some(i);
            }
        }
        let at = muted_after.expect("a button doing this must eventually be ignored");
        assert!(at <= NOISE_PRESSES + 1, "took {at} presses to notice");
    }

    #[test]
    fn a_person_pressing_normally_is_never_muted() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..40u32 {
            // Three a second for thirteen seconds.
            let at = t0 + Duration::from_millis(330 * i as u64);
            assert!(!n.muted(PAD, Action::Lb, at), "muted a hand at press {i}");
        }
    }

    #[test]
    fn a_muted_button_is_let_back_once_it_goes_quiet() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..40u32 {
            n.muted(PAD, Action::Lb, t0 + Duration::from_millis(140 * i as u64));
        }
        assert!(
            n.muted(PAD, Action::Lb, t0 + Duration::from_millis(140 * 40)),
            "still noisy"
        );
        let later = t0 + Duration::from_secs(30);
        assert!(
            !n.muted(PAD, Action::Lb, later),
            "a button that stopped must work again"
        );
    }

    /// Keying on the action alone once let a DualSense mute an Xbox pad.
    #[test]
    fn a_noisy_pad_does_not_silence_the_one_next_to_it() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..60u32 {
            n.muted(PAD, Action::Lb, t0 + Duration::from_millis(140 * i as u64));
        }
        let now = t0 + Duration::from_millis(140 * 60);
        assert!(
            n.muted(PAD, Action::Lb, now),
            "the noisy pad should be ignored"
        );
        assert!(
            !n.muted(OTHER_PAD, Action::Lb, now),
            "the other controller must be untouched"
        );
        for i in 1..10u32 {
            let at = now + Duration::from_millis(400 * i as u64);
            assert!(
                !n.muted(OTHER_PAD, Action::Lb, at),
                "press {i} on the other pad"
            );
        }
    }

    #[test]
    fn muting_one_button_does_not_mute_another() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..40u32 {
            n.muted(PAD, Action::Lb, t0 + Duration::from_millis(140 * i as u64));
        }
        assert!(!n.muted(PAD, Action::A, t0 + Duration::from_millis(140 * 40)));
        assert!(!n.muted(PAD, Action::Up, t0 + Duration::from_millis(140 * 41)));
    }

    /// Windows triggers report as twitching axes, which once cut bumper repeat.
    #[test]
    fn a_stick_going_quiet_does_not_cancel_a_held_bumper() {
        let held = Repeat::from_button(Action::Lb, Instant::now());
        assert!(
            !held.ends_with_the_sticks(),
            "a bumper's repeat is not the sticks' business"
        );
    }

    #[test]
    fn a_stick_going_quiet_does_cancel_a_held_direction() {
        let held = Repeat::from_stick(Action::Down, Instant::now());
        assert!(held.ends_with_the_sticks());
    }

    #[test]
    fn releasing_the_button_ends_its_own_repeat_and_no_other() {
        let held = Repeat::from_button(Action::Lb, Instant::now());
        assert!(held.ends_with_button(Action::Lb));
        assert!(
            !held.ends_with_button(Action::Rb),
            "the other bumper is unrelated"
        );
        assert!(!held.ends_with_button(Action::A));
    }

    #[test]
    fn releasing_a_button_never_ends_a_sticks_repeat() {
        let held = Repeat::from_stick(Action::Down, Instant::now());
        assert!(!held.ends_with_button(Action::Down));
        assert!(!held.ends_with_button(Action::A));
    }

    #[test]
    fn only_navigation_repeats() {
        for a in [
            Action::Up,
            Action::Down,
            Action::Left,
            Action::Right,
            Action::Lb,
            Action::Rb,
        ] {
            assert!(a.repeats(), "{a:?} should repeat");
        }
        for a in [
            Action::A,
            Action::B,
            Action::X,
            Action::Y,
            Action::Menu,
            Action::Add,
            Action::Sort,
            Action::Search,
        ] {
            assert!(!a.repeats(), "{a:?} must not repeat");
        }
    }

    #[test]
    fn the_bumpers_page_and_the_triggers_are_left_alone() {
        assert_eq!(button_action(Button::LeftTrigger), Some(Action::Lb));
        assert_eq!(button_action(Button::RightTrigger), Some(Action::Rb));
        assert_eq!(button_action(Button::LeftTrigger2), None);
        assert_eq!(button_action(Button::RightTrigger2), None);
    }

    #[test]
    fn every_face_button_and_menu_control_is_mapped() {
        for (b, a) in [
            (Button::South, Action::A),
            (Button::East, Action::B),
            (Button::West, Action::X),
            (Button::North, Action::Y),
            (Button::Start, Action::Menu),
            (Button::Select, Action::Add),
            (Button::LeftThumb, Action::Sort),
            (Button::RightThumb, Action::Search),
            (Button::DPadUp, Action::Up),
            (Button::DPadDown, Action::Down),
            (Button::DPadLeft, Action::Left),
            (Button::DPadRight, Action::Right),
        ] {
            assert_eq!(button_action(b), Some(a), "{b:?}");
        }
    }

    #[test]
    fn an_axis_reports_only_when_it_crosses_the_deadzone() {
        let mut ax = AxisState { held: None };
        assert_eq!(
            ax.update(0.2, Action::Left, Action::Right),
            None,
            "inside the deadzone"
        );
        assert_eq!(
            ax.update(0.9, Action::Left, Action::Right),
            Some(Action::Right)
        );
        assert_eq!(
            ax.update(0.95, Action::Left, Action::Right),
            None,
            "already held"
        );
        assert_eq!(
            ax.update(0.0, Action::Left, Action::Right),
            None,
            "released"
        );
        assert_eq!(
            ax.update(-0.9, Action::Left, Action::Right),
            Some(Action::Left)
        );
    }
}
