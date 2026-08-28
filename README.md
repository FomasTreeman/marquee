# Marquee

A cross-platform, controller-first game launcher. One grid, every store, pitch
black, cover art doing the work.

Windows, Linux and macOS. Tauri v2 — a Rust core with a web frontend, so the
interface is CSS and the parsers are memory-safe.

**Nothing is built yet.** This repository currently contains one document:

- **[docs/PLAN.md](docs/PLAN.md)** — scope, stack, architecture, phasing, and
  the risks worth knowing before starting.

Steam is the only automated integration. Everything else — Epic, GOG, EA,
Ubisoft, emulators — is added by pointing at the executable, which is one code
path instead of five undocumented ones. See §5 of the plan for why that trade
is a good one and what it costs.

The design comes from [`../playnite_clean/web`](../playnite_clean/web), a
working prototype treated as the specification rather than a mockup. Sibling
projects `playnite_clean` and `heroic_clean` apply the same design as themes for
existing launchers; this is the same design with no host to fight.

Priorities, in the order they break ties: **performance, stability, UI.**

Private. Licence deferred.
