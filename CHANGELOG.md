# Changelog

All notable changes to Weave Client are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-23

### Fixed
- Pressing "Restart now" for an update showed an installer progress window and then left
  the app closed. `quitAndInstall()` defaults to a visible install and to not relaunching;
  both are now set explicitly. The quit-time path was already silent.

### Added
- `scripts/predict-delta.mjs`, which reports how large the next update will actually be by
  comparing two blockmaps, and fails a release if the delta exceeds 10% — the signal that
  something recompressed the payload rather than that the code changed a lot.
- The updater now logs how many bytes it actually transferred against the full installer
  size, so whether a differential update worked is a number rather than an assumption.
- `docs/releasing.md`, including the four pipeline rules that silently turn every user's
  next update into a full download.

## [0.1.1] - 2026-08-23

### Fixed
- Sign in and register failed with "current is not defined". Scoping session tokens per
  server changed two call sites that referenced a variable which only existed in a
  different branch of the same file. It parsed, it built, and all 115 tests passed, because
  the broken line only runs when somebody actually signs in.

### Added
- ESLint, running before the test suite and in CI. `no-undef` catches the class of bug
  above in milliseconds; the rule set is deliberately narrow — things that are wrong, not
  matters of taste.

## [Unreleased]

### Added
- Platform adapter: one source tree, two builds. `WEAVE_TARGET=browser` inherits the
  origin that served it; `WEAVE_TARGET=desktop` ships blank and is pointed at a server.
  Server management is compiled out of the browser build rather than hidden in it.
- Address parsing that accepts a bare hostname, `host:port`, an explicit scheme, a pasted
  `wss://` URL, or a URL copied out of a browser. Defaults to HTTPS, except for addresses
  that are obviously on a private network, where plain HTTP is the common case.
- Server discovery against `GET /api/server-info` with protocol *range* negotiation, so a
  newer client does not refuse a server it could have talked to. Distinguishes timeout,
  wrong software, incompatible version and unfinished setup; everything a browser cannot
  distinguish gets one honest message rather than a specific guess.
- Multi-server list for the desktop build, with per-server namespaced settings. A server
  is only remembered once it has answered.
- Sign in, register with an invite code, and a three-step password reset built on a
  security question. No email is involved at any point.

### Notes
- The room — voice, screen share, chat — is not built yet. Signing in currently lands on
  a placeholder confirming the whole chain works.
