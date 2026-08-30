# Security

Written before making the repository public, and kept as the answer to "what
can this thing actually do".

## What Marquee is, in security terms

A launcher is a program whose entire job is **starting other programs**, on a
machine where it can **read files another application wrote**, while **talking
to the internet**. That is three of the more interesting capabilities a desktop
app can hold, and it holds all of them by design. So the question is never
"does it have dangerous powers" — it does — but "what bounds them".

Three things it deliberately is not:

- **Not a store.** It never downloads a game, installs one, or runs an
  installer. Nothing it fetches is executed. See `docs/PLAN.md §5`.
- **Not an account.** No sign-in, no server, no telemetry, no crash uploads.
  Nothing leaves the machine except requests to Steam's public endpoints and,
  if you supply a key, SteamGridDB.
- **Not a privileged process.** No elevation, no service, no driver, no
  scheduled task, no auto-start. Closing it stops it entirely.

## What it executes, and how

Exactly two paths, both in `src-tauri/src/run.rs`:

**Steam games** launch by URI — `steam://rungameid/<appid>` — handed to the
platform. The appid is checked to be ASCII digits before the URI is built, and
`open_uri` then refuses any URI that is not `steam://` *and* contains any
character outside `[A-Za-z0-9/:._-]`.

That second check exists because of how Windows opens a URI. There is no Win32
call available here that takes a URI directly without another dependency, so it
goes through `cmd /C start` — and **cmd.exe re-parses its command line after
Rust has quoted it**. Rust's quoting targets `CreateProcess`, not `cmd`, so a
`&`, `|`, `^`, `<`, `>` or `"` surviving into an argument stops being an
argument and becomes a command. That is the BatBadBut class of bug,
CVE-2024-24576.

Nothing builds such a URI today. The allowlist is the second lock, for whoever
adds a provider later and constructs a URI from a name read off the disk. It is
tested against the metacharacters that matter.

**Everything else** is a path the user chose in a native file dialog, spawned
with `Command::new(path)` and no arguments. No shell is involved, so nothing in
the path is interpreted. Marquee never guesses at an executable and runs it:
"Look for it" only ever *suggests*, and the user confirms.

The machine actions in the main menu (`shutdown`, `restart`) are a closed enum
parsed from a string, mapped to fixed argument vectors in `system.rs`. The
interface cannot express a command that is not already in that match.

## What it reads

Steam's own files, where Steam put them: `libraryfolders.vdf`,
`appmanifest_*.acf`, `localconfig.vdf`. Read-only, always — Marquee never
writes into another application's directory. The parser is fuzz-shaped rather
than trusting: a truncated or malformed file is an error, never a panic, and a
failed scan degrades to a visible warning with the manual path still open.

## The custom `art://` protocol

The webview asks for `art://localhost/<source>-<id>/<kind>` and Rust answers
with bytes from the on-disk cache or the CDN.

**No part of the request reaches the filesystem as text.** `SourceKey::parse`
requires the source to be exactly `steam` or `sgdb` and the id to be at most
twelve ASCII digits; `Kind::parse` is a closed set of three. The cache filename
is then *rebuilt* from those validated values. There is no path to traverse
with, because there is no path in the request.

## Content Security Policy

Set in `tauri.conf.json`, and tighter than the default:

```
default-src 'self'; script-src 'self'; base-uri 'self'; form-action 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; font-src 'self';
img-src 'self' art: http://art.localhost data: https://*.steamstatic.com;
style-src 'self' 'unsafe-inline';
connect-src 'self' ipc: http://ipc.localhost https://store.steampowered.com
            https://steamcommunity.com https://*.steamstatic.com
```

Two notes:

- **`base-uri` and `form-action` do not fall back to `default-src`.** They were
  missing, and `default-src 'self'` looks like it covers them. Without
  `base-uri`, one injected `<base>` tag retargets every relative URL on the
  page.
- **`style-src` allows inline.** The interface sets element styles directly —
  the grid positions cards by `transform`, which is the whole performance
  story. Inline *scripts* are not allowed, which is the half that matters.

Third-party network access is deliberately **not** in `connect-src`.
SteamGridDB is only ever called from Rust; the webview cannot reach it.

## Tauri permissions

`src-tauri/capabilities/default.json` grants `core:default` and
`dialog:allow-open`. That is the entire surface: no filesystem plugin, no
shell plugin, no HTTP plugin. Every privileged operation goes through a named
`#[tauri::command]` that validates its own arguments.

## Credentials

**Marquee has no credentials of its own and never asks for a password.** It
does not sign in to Steam; it reads files Steam already wrote.

The one secret it can hold is an optional **SteamGridDB API key**, which the
user creates on their own account and pastes into Settings. It is stored in
plain text in the SQLite database under the app's data directory, protected by
nothing beyond the file permissions of that directory.

That is a deliberate, stated trade-off rather than an oversight. The key is
free, read-only, per-user, revocable in one click, and grants access to nothing
but a public artwork catalogue. Encrypting it locally would need a key of its
own, and a key stored beside the thing it encrypts is theatre. **It is included
in an exported profile**, which is what makes a profile work on a new machine —
so treat an exported profile as mildly sensitive and do not put one in a public
place.

## Making the repository public

Checked before publishing:

- No secrets anywhere in the history. The word "secret" appears only in this
  file and in the updater documentation.
- No personal paths or identifiers in tracked files. The Steam fixtures under
  `src-tauri/tests/fixtures/` are anonymised to `/Users/example`.
- Nothing user-specific is tracked: the database, logs and artwork cache all
  live in the platform's app directories, and `.gitignore` covers the rest.

## Reporting something

Open an issue if it is not sensitive. If it is, say so in the issue without the
details and we will find somewhere better than a public thread.
