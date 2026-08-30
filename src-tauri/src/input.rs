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
}

#[tauri::command]
pub fn pad_status(status: tauri::State<'_, Arc<Status>>) -> PadStatus {
    PadStatus {
        supported: status.supported.load(Ordering::Relaxed),
        connected: status.connected.load(Ordering::Relaxed),
        backend: BACKEND,
        devices: status.devices.lock().map(|d| d.clone()).unwrap_or_default(),
        failure: status.failure.lock().ok().and_then(|f| f.clone()),
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

        let mut held: Option<(Action, Instant)> = None;
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
                    EventType::ButtonPressed(b, _) => {
                        if let Some(a) = button_action(b) {
                            emit(a, false);
                            if a.repeats() {
                                held = Some((a, Instant::now() + REPEAT_DELAY));
                            }
                        }
                    }
                    EventType::ButtonReleased(b, _) => {
                        if let Some(a) = button_action(b) {
                            if matches!(held, Some((h, _)) if h == a) {
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
                                emit(a, false);
                                held = Some((a, Instant::now() + REPEAT_DELAY));
                            }
                            None => {
                                // Released back inside the deadzone: stop any
                                // repeat this stick owned.
                                if xs.held.is_none()
                                    && ys.held.is_none()
                                    && matches!(held, Some((h, _)) if h.repeats())
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

            if let Some((action, due)) = held {
                let now = Instant::now();
                if now >= due {
                    emit(action, true);
                    held = Some((action, now + REPEAT_RATE));
                }
            }

            std::thread::sleep(POLL);
        }
    }
}
