//! Gamepad input.
//!
//! Deliberately NOT the browser Gamepad API, for three reasons that all bite:
//! support differs across the three webviews we ship on, it reports nothing
//! until the page has seen a user interaction, and it stops existing the
//! moment a game takes focus -- which is exactly when a launcher still needs
//! to know whether you held a button to come back.
//!
//! So a poll thread here owns the pad, normalises it to abstract actions, and
//! pushes those to the interface. The frontend never learns what a button is.
//!
//! Auto-repeat lives here too rather than in JavaScript. It is lower latency,
//! it keeps repeating while the webview is busy painting, and it means held
//! directions behave identically no matter what the interface is doing.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gilrs::{Axis, Button, EventType, Gilrs};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Tuned in the browser prototype and carried over unchanged -- these are
/// pad-feel numbers, and they were arrived at by using them on a sofa.
const REPEAT_DELAY: Duration = Duration::from_millis(380);
const REPEAT_RATE: Duration = Duration::from_millis(95);
const DEADZONE: f32 = 0.55;
const POLL: Duration = Duration::from_millis(4);

/// The abstract action stream. Everything downstream -- Rust or TypeScript --
/// speaks only these, so adding a second input source is additive.
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
    /// Open the sort menu. Left stick click, as on a console.
    Sort,
    /// Open the filter menu. Right stick click.
    Filter,
}

impl Action {
    /// Only directions and shoulders auto-repeat. A repeating confirm button
    /// launches a game twice.
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
    /// True when this came from auto-repeat rather than a fresh press, so the
    /// interface can suppress sounds or animation on held navigation.
    pub repeat: bool,
    /// Milliseconds since the input thread started. Paired with `clock_sync`
    /// this lets the frontend measure delivery latency against the budget in
    /// docs/PLAN.md §2.
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
        // The bumpers page the library. gilrs names them confusingly:
        // LeftTrigger is the *bumper* (L1, LB); LeftTrigger2 is the analogue
        // trigger (L2, LT).
        //
        // The triggers deliberately do not page. Mapping both to one action
        // sounded forgiving and was not: on Windows the analogue triggers are
        // reported as axes as well as buttons, so they emit constantly, and
        // sharing an action with the bumpers made the two interfere. A control
        // that is sometimes a page and sometimes nothing is worse than one
        // that does nothing at all.
        Button::LeftTrigger => Action::Lb,
        Button::RightTrigger => Action::Rb,
        Button::LeftThumb => Action::Sort,
        Button::RightThumb => Action::Filter,
        Button::Start => Action::Menu,
        // Select/Back adds a game. Not the main menu, despite sitting next to
        // Start -- that is Action::Menu.
        Button::Select => Action::Add,
        _ => return None,
    })
}

/// One held direction per axis. A stick pushed diagonally should not fire two
/// directions at once -- on a grid that reads as a diagonal jump nobody asked
/// for -- so the dominant axis wins.
struct AxisState {
    held: Option<Action>,
}

/// A button that is not being pressed by anybody.
///
/// Found on a DualSense over Bluetooth on macOS: gilrs reports BUTTON(5) and
/// BUTTON(6) -- the two bumpers -- pressing and releasing about seven times a
/// second, forever, with the controller sitting untouched on a desk. Clean
/// digital pairs, exactly 1.000 then 0.000, not analogue jitter.
///
/// The symptom is not "the bumpers misbehave". The two alternate, one pages
/// the library forward and the other back, so the grid ends where it started
/// and the bumpers appear to *do nothing at all* -- while a real press is one
/// event lost in a stream of noise. That took four rounds to find because
/// every layer above it was working perfectly.
///
/// Whatever the cause, a control that reports faster than a person can move it
/// is not reporting input. This mutes it, says so, and lets it back the moment
/// it goes quiet -- so a fast human tapping is muted for a moment at worst,
/// while a genuinely broken button stays out of the way.
struct Noise {
    /// Per *pad* and action: when the current burst started, when it was last
    /// seen, and how many presses are in it.
    ///
    /// Keyed by the pad as well as the action, which the first version was not
    /// -- and with two controllers plugged in that is the difference between
    /// ignoring one broken button and switching off somebody's other
    /// controller. A DualSense that spams its bumpers should cost the Xbox pad
    /// beside it nothing at all.
    seen: Vec<(usize, Action, Instant, Instant, u32)>,
}

/// A rate no hand sustains. Someone tapping hard manages six or seven presses
/// a second in a burst; nobody holds five a second for seconds on end.
const NOISE_RATE: f64 = 5.0;
/// Enough presses to be sure of the rate rather than reacting to a flurry.
const NOISE_PRESSES: u32 = 20;
/// Silence long enough to conclude whatever it was has stopped.
const NOISE_QUIET: Duration = Duration::from_secs(2);

impl Noise {
    fn new() -> Self {
        Noise { seen: Vec::new() }
    }

    /// True if this press should be ignored.
    ///
    /// Judged on rate rather than on a count in a fixed window. A window that
    /// resets on its own boundary lets a button hammering continuously slip
    /// through every time the boundary passes, which is exactly what the first
    /// version of this did.
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

        // A gap a person would leave means the burst is over, whatever it was.
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

    /// Whether this press is the one that crosses the line, so the warning is
    /// written once rather than several times a second.
    fn just_crossed(&self, pad: usize, action: Action) -> bool {
        self.seen
            .iter()
            .any(|(p, a, _, _, c)| *p == pad && *a == action && *c == NOISE_PRESSES)
    }

    /// What is currently being ignored, for the diagnostics in Settings.
    /// A control that has been switched off should say so somewhere a person
    /// can find without reading a log file.
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

/// What is auto-repeating, and what started it.
///
/// The origin is the whole point. Repeat used to be a bare
/// `Option<(Action, Instant)>` cleared by *any* axis settling back to centre
/// -- and on Windows the analogue triggers are axes as well as buttons, so
/// they emit constantly even at rest. Holding a bumper to page through the
/// library therefore stopped repeating the moment a trigger twitched, which
/// from the sofa is a shoulder button that works intermittently for no
/// visible reason.
///
/// A stick's repeat is cancelled by the stick going quiet. A button's repeat
/// is cancelled by the button coming up, and by nothing else.
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

/// Live state of the input subsystem, shared with the interface.
///
/// A launcher whose whole premise is a controller has to be able to say "no
/// controller detected" rather than simply not responding, so this is read by
/// a command rather than kept private to the thread.
///
/// It carries a diagnosis as well as a count, because "no controller" has
/// several very different causes -- the backend refused to start, it started
/// and saw nothing, or it saw a device it could not map -- and the person on
/// the sofa cannot tell them apart from the silence.
#[derive(Default)]
pub struct Status {
    /// The backend initialised. False means this machine has no gamepad
    /// support at all and the interface should say so.
    pub supported: AtomicBool,
    pub connected: AtomicUsize,
    /// One line per device the backend enumerated, in its own words.
    pub devices: Mutex<Vec<String>>,
    /// Why there is no input, when there is a reason worth repeating.
    pub failure: Mutex<Option<String>>,
    /// Controls currently being ignored for reporting faster than a hand can
    /// move them. Switching a control off silently is the same class of
    /// mistake as the bug it was added to fix.
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

/// The platform API actually in play.
///
/// Worth stating exactly, because it decides which devices can be seen at all
/// and it is the first thing to check when a pad does not work. On Windows
/// this is Windows.Gaming.Input -- gilrs enables its `wgi` backend by default,
/// not `xinput`. That distinction matters: WGI enumerates through
/// RawGameController, which sees any HID game controller, while XInput sees
/// Xbox-compatible devices only. Marquee previously said XInput here and told
/// people with PlayStation pads to install DS4Windows, which was wrong.
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
    /// Every device the backend enumerated, named. Empty is itself an answer:
    /// the backend is running and this machine genuinely has no pad attached.
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

/// Spawn the poll thread. Never panics and never fails the app: a machine with
/// no gamepad support, or a driver that refuses to initialise, logs once and
/// leaves the interface fully usable from the keyboard.
pub fn spawn(app: AppHandle, start: Instant) -> Arc<Status> {
    let status = Arc::new(Status::default());
    let shared = status.clone();

    std::thread::spawn(move || {
        // gilrs unwraps internally while registering its WinRT event handlers,
        // so a failure on Windows arrives as a panic rather than an Err. A
        // panic in a spawned thread kills that thread alone, prints to a stderr
        // nobody is reading, and leaves the app running perfectly well with no
        // gamepad and nothing in the log. That is indistinguishable from "the
        // controller is not plugged in", which is the report we actually got.
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
                "the gamepad thread stopped: {why}. {BACKEND} is unavailable,                  so the interface is keyboard and mouse only."
            ));
        }
    });

    status
}

fn run(app: AppHandle, start: Instant, shared: Arc<Status>) {
    {
        let backend = BACKEND;

        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                shared.fail(format!(
                    "no gamepad support via {backend}: {e}. Keyboard and mouse only."
                ));
                return;
            }
        };
        shared.supported.store(true, Ordering::Relaxed);
        let mut pads = 0usize;
        let mut seen: Vec<String> = Vec::new();
        for (_id, pad) in gilrs.gamepads() {
            // Recorded verbatim as well as logged. "No controller" has several
            // causes that feel identical from the sofa, and the difference
            // between "nothing enumerated" and "enumerated but unmapped" is the
            // whole diagnosis. Settings shows this list.
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
            crate::log_info!("input", "{line} (via {backend})");
            seen.push(line);
            pads += 1;
        }
        if let Ok(mut d) = shared.devices.lock() {
            *d = seen;
        }
        shared.connected.store(pads, Ordering::Relaxed);

        // Whether to complain about there being no pad, and when.
        //
        // Not at startup: gilrs enumerates before the platform has finished
        // reporting devices, so a connected pad shows as absent for a few
        // milliseconds and then arrives as a Connected event. Warning
        // immediately produced "no gamepad seen" followed 11 ms later by
        // "gamepad connected", which is worse than saying nothing.
        let decide_at = Instant::now() + Duration::from_secs(3);
        let mut reported = false;

        let mut held: Option<Repeat> = None;
        let mut noise = Noise::new();
        let mut last_published = Instant::now();
        let mut xs = AxisState { held: None };
        let mut ys = AxisState { held: None };

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
                            // Every press, at debug. Unmapped buttons were
                            // already logged, which answers "did anything
                            // arrive" but not "did the *bumper* arrive" -- the
                            // question that cost four rounds of guessing.
                            // Repeats are excluded, so this is bounded by how
                            // fast a person can press.
                            crate::log_debug!("input", "{b:?} -> {a:?}");
                            emit(a, false);
                            if a.repeats() {
                                held = Some(Repeat::from_button(a, now));
                            }
                        } else {
                            // A pad that sends buttons we do not understand
                            // looks exactly like a pad that sends nothing.
                            // Saying which is the entire difference between a
                            // fixable report and "the controller doesn't work".
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
                                // Deliberately not logged. A stick crossing
                                // the deadzone fires on every direction change
                                // while navigating, which is several a second
                                // for as long as someone is using the app --
                                // and a debug report drowned in those is the
                                // mistake `will retry 0` already made once.
                                // Buttons are logged; they are bounded by how
                                // fast a person can press.
                                emit(a, false);
                                held = Some(Repeat::from_stick(a, Instant::now()));
                            }
                            None => {
                                // Both sticks back inside the deadzone ends a
                                // repeat a stick started -- and only that. A
                                // bumper being held is none of this branch's
                                // business, which is what it used to get wrong.
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
                        // Saturating, because a disconnect can arrive for a pad
                        // that was already gone when we enumerated at startup.
                        let _ = shared.connected.fetch_update(
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                            |n| Some(n.saturating_sub(1)),
                        );
                        crate::log_info!("input", "gamepad disconnected");
                    }
                    _ => {}
                }
            }

            if !reported && Instant::now() >= decide_at {
                reported = true;
                if shared.connected.load(Ordering::Relaxed) == 0 {
                    // Deliberately not advice any more. This used to claim that
                    // XInput sees Xbox-compatible pads only and to recommend
                    // DS4Windows, which was wrong on both counts: the backend is
                    // Windows.Gaming.Input, and it enumerates through
                    // RawGameController, which sees any HID game controller.
                    // Guessing at a cause is worse than reporting the fact,
                    // because the guess is what gets acted on.
                    crate::log_warn!(
                        "input",
                        "no gamepad after 3s. {backend} started and enumerated nothing."
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

            // Publish what is being ignored, about once a second. Cheap, and
            // it means a control that has been switched off can be seen in
            // Settings rather than only in a log line that scrolled past.
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for a controller. GamepadId cannot be built outside gilrs,
    /// so the filter keys on the usize it converts into.
    const PAD: usize = 0;
    const OTHER_PAD: usize = 1;

    /// Captured from a real DualSense over Bluetooth on macOS, sitting
    /// untouched on a desk: gilrs reported both bumpers pressing and
    /// releasing about seven times a second, forever, as clean digital pairs.
    ///
    /// One tab forward, one tab back, alternating -- so the interface ended
    /// where it started and the bumpers appeared to do nothing whatsoever.
    #[test]
    fn a_button_reporting_faster_than_a_hand_is_muted() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        let mut muted_after = None;
        for i in 0..60u32 {
            // ~7 a second, which is what the log showed.
            let at = t0 + Duration::from_millis(140 * i as u64);
            if n.muted(PAD, Action::Lb, at) && muted_after.is_none() {
                muted_after = Some(i);
            }
        }
        let at = muted_after.expect("a button doing this must eventually be ignored");
        assert!(at <= NOISE_PRESSES + 1, "took {at} presses to notice");
    }

    /// Muting a real hand would be far worse than the bug. Someone paging
    /// through a long library taps hard and fast, and must never be ignored.
    #[test]
    fn a_person_pressing_normally_is_never_muted() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..40u32 {
            // Three a second, sustained for thirteen seconds. Brisk, human.
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
        // Unplugged, swapped, or simply stopped.
        let later = t0 + Duration::from_secs(30);
        assert!(
            !n.muted(PAD, Action::Lb, later),
            "a button that stopped must work again"
        );
    }

    /// The report this exists for: "ds5 perfect, xbox randomly stopped and now
    /// will not work at all".
    ///
    /// The DualSense spams its bumpers continuously. The first version of this
    /// filter keyed on the action alone, so the DualSense's noise switched
    /// those controls off for *every* pad plugged in -- ignoring one broken
    /// button by breaking somebody's other controller.
    #[test]
    fn a_noisy_pad_does_not_silence_the_one_next_to_it() {
        let mut n = Noise::new();
        let t0 = Instant::now();
        // The DualSense, doing what the log showed: seven a second, forever.
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
        // And it keeps working for every press after that.
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
        // The noise was on both bumpers, but A must keep working throughout --
        // an unusable pad is a worse outcome than a noisy one.
        let mut n = Noise::new();
        let t0 = Instant::now();
        for i in 0..40u32 {
            n.muted(PAD, Action::Lb, t0 + Duration::from_millis(140 * i as u64));
        }
        assert!(!n.muted(PAD, Action::A, t0 + Duration::from_millis(140 * 40)));
        assert!(!n.muted(PAD, Action::Up, t0 + Duration::from_millis(140 * 41)));
    }

    /// The bug this type exists for.
    ///
    /// Repeat used to be a bare tuple, cleared whenever the sticks settled
    /// back to centre. On Windows the analogue triggers are reported as axes
    /// as well as buttons, so they emit continuously even at rest -- which
    /// meant holding a bumper to page through the library stopped repeating
    /// the moment a trigger twitched. From the sofa that is a shoulder button
    /// that works intermittently for no visible reason.
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
        // A stick pushed down while a face button is tapped must keep moving.
        let held = Repeat::from_stick(Action::Down, Instant::now());
        assert!(!held.ends_with_button(Action::Down));
        assert!(!held.ends_with_button(Action::A));
    }

    /// Only the things you can hold down should repeat. A repeating confirm
    /// launches the game under the cursor over and over.
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
            Action::Filter,
        ] {
            assert!(!a.repeats(), "{a:?} must not repeat");
        }
    }

    /// The bumpers page. The triggers do not, deliberately: on Windows they
    /// arrive as axes as well as buttons, and sharing an action with the
    /// bumpers made the two interfere.
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
            (Button::RightThumb, Action::Filter),
            (Button::DPadUp, Action::Up),
            (Button::DPadDown, Action::Down),
            (Button::DPadLeft, Action::Left),
            (Button::DPadRight, Action::Right),
        ] {
            assert_eq!(button_action(b), Some(a), "{b:?}");
        }
    }

    /// A stick pushed diagonally must not fire two directions at once -- on a
    /// grid that reads as a diagonal jump nobody asked for.
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
