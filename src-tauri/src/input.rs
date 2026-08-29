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
use std::sync::Arc;
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
    MainMenu,
    /// Cycle the sort order.
    Sort,
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
        Button::LeftTrigger2 => Action::Sort,
        Button::Start => Action::Menu,
        Button::Select => Action::MainMenu,
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
#[derive(Default)]
pub struct Status {
    /// gilrs initialised. False means this machine has no gamepad support at
    /// all and the interface should say so.
    pub supported: AtomicBool,
    pub connected: AtomicUsize,
}

#[derive(Serialize)]
pub struct PadStatus {
    pub supported: bool,
    pub connected: usize,
}

#[tauri::command]
pub fn pad_status(status: tauri::State<'_, Arc<Status>>) -> PadStatus {
    PadStatus {
        supported: status.supported.load(Ordering::Relaxed),
        connected: status.connected.load(Ordering::Relaxed),
    }
}

/// Spawn the poll thread. Never panics and never fails the app: a machine with
/// no gamepad support, or a driver that refuses to initialise, logs once and
/// leaves the interface fully usable from the keyboard.
pub fn spawn(app: AppHandle, start: Instant) -> Arc<Status> {
    let status = Arc::new(Status::default());
    let shared = status.clone();

    std::thread::spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[input] no gamepad support on this machine: {e}. Keyboard only.");
                return;
            }
        };
        shared.supported.store(true, Ordering::Relaxed);
        let mut pads = 0usize;
        for (_id, pad) in gilrs.gamepads() {
            println!("[input] {} connected", pad.name());
            pads += 1;
        }
        shared.connected.store(pads, Ordering::Relaxed);

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
                        println!("[input] gamepad connected");
                    }
                    EventType::Disconnected => {
                        // Saturating, because a disconnect can arrive for a pad
                        // that was already gone when we enumerated at startup.
                        let _ = shared.connected.fetch_update(
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                            |n| Some(n.saturating_sub(1)),
                        );
                        println!("[input] gamepad disconnected");
                    }
                    _ => {}
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
    });

    status
}
