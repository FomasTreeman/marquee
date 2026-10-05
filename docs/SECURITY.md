# Security

A launcher starts other programs, reads files another application wrote, and
talks to the internet. This document covers the limits on each.

Marquee is not:

- **A store.** It never downloads, installs or runs an installer. Nothing it
  fetches is executed (`docs/PLAN.md §5`).
- **An account.** No sign-in, server, telemetry or crash uploads. It contacts
  only Steam's public endpoints, SteamGridDB if you supply a key, and this
  repository's releases page for updates ([UPDATES.md](UPDATES.md)).
- **A privileged process.** No elevation, service, driver or scheduled task.
  On Windows it can register itself under `HKEY_CURRENT_USER\...\Run` to start
  with Windows. That is off by default, switched in Settings, and read back
  live so the toggle matches what Windows will do (`autostart.rs`).

## What it executes

Two paths, both in `src-tauri/src/run.rs`.

**Steam games** launch by `steam://rungameid/<appid>`. The appid must be ASCII
digits. `open_uri` then refuses any URI that is not `steam://` and contains a
character outside `[A-Za-z0-9/:._-]`. Windows opens the URI with
`ShellExecuteW`, which parses no command line. It used to use `cmd /C start`,
where `&`, `|`, `^`, `<`, `>` or `"` could become a command (BatBadBut,
CVE-2024-24576). The allowlist stays as a second lock for any future provider
that builds a URI from a name on disk, and is tested against those characters.

**Everything else** is a path the user chose in a native file dialog, spawned
with `Command::new(path)`, no arguments and no shell. "Look for it" only
suggests a path; the user confirms.

`shutdown` and `restart` in the menu are a closed enum mapped to fixed argument
vectors in `system.rs`.

## What it reads

Steam's `libraryfolders.vdf`, `appmanifest_*.acf` and `localconfig.vdf`, where
Steam put them, read-only. A malformed file is an error, never a panic, and a
failed scan shows a warning with the manual path still open.

## The `art://` protocol

The webview requests `art://localhost/<source>-<id>/<kind>`. `SourceKey::parse`
requires the source to be `steam` or `sgdb` and the id to be at most twelve
ASCII digits. `Kind::parse` accepts a closed set of three. The cache filename
is rebuilt from those values, so no part of the request reaches the filesystem
as text.

## Content Security Policy

Set in `tauri.conf.json`:

```
default-src 'self'; script-src 'self'; base-uri 'self'; form-action 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; font-src 'self';
img-src 'self' art: http://art.localhost data: https://*.steamstatic.com;
style-src 'self' 'unsafe-inline';
connect-src 'self' ipc: http://ipc.localhost https://store.steampowered.com
            https://steamcommunity.com https://*.steamstatic.com
```

- `base-uri` and `form-action` do not fall back to `default-src`, so they are
  set explicitly. An injected `<base>` tag would otherwise retarget every
  relative URL.
- `style-src` allows inline because the grid positions cards with inline
  `transform`. Inline scripts are not allowed.
- SteamGridDB is not in `connect-src`. Only Rust calls it.

## Tauri permissions

`src-tauri/capabilities/default.json` grants `core:default`,
`dialog:allow-open`, `updater:default` and `process:allow-restart`. There is no
filesystem, shell or HTTP plugin. Every other privileged operation is a named
`#[tauri::command]` that validates its own arguments.

## Credentials

Marquee has no credentials of its own and does not sign in to Steam.

The optional **SteamGridDB API key** is stored in plain text in the SQLite
database under the app's data directory, protected by that directory's file
permissions. The key is free, read-only, per-user, revocable in one click and
reaches only a public artwork catalogue; encrypting it would need a second key
stored beside it. **It is included in an exported profile**, so do not publish
a profile.

## The repository

- No secrets in the history. The update signing key lives in a password
  manager and the `release` environment. `*.key` is ignored and a ruleset
  refuses it.
- No personal paths in tracked files. The Steam fixtures in
  `src-tauri/tests/fixtures/` are anonymised to `/Users/example`.
- The database, logs and artwork cache live in the platform's app directories,
  never in the repository.
- Every GitHub Action is pinned to a commit SHA, and a check refuses a tag.

Some code is written by an agent from issue text, which is untrusted input.
[AUTOMATION.md](AUTOMATION.md) describes the limits: it cannot merge, cannot
push to `main`, and only a maintainer can start it.

## Reporting

Open an issue if it is not sensitive. If it is, use **Report a vulnerability**
under the Security tab, or open an issue saying only that you have something
sensitive to report.
