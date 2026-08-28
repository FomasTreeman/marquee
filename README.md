# Marquee

A cross-platform, controller-first game launcher. One grid, every store, pitch
black, cover art doing the work.

Windows, Linux and macOS. Tauri v2 — a Rust core with a web frontend, so the
interface is CSS and the parsers are memory-safe.

**Nothing is built yet.** This repository currently contains one document:

- **[docs/PLAN.md](docs/PLAN.md)** — scope, stack, architecture, the store
  integration tiers, phasing, and the risks worth knowing before starting.

The design comes from [`../playnite_clean/web`](../playnite_clean/web), a
working prototype that is treated as the specification rather than a mockup.
Sibling projects `playnite_clean` and `heroic_clean` apply the same design as
themes for existing launchers; this is the same design with no host to fight.

Priorities, in the order they break ties: **performance, stability, UI.**

MIT.
