# Changelog

All notable changes to Weave Client are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-08-23

### Added
- Voice. The microphone is produced to the SFU on joining a room that allows it, everyone
  else's audio is consumed automatically, mute works, and the weaving background's pace is
  driven by how loud the room actually is.
- A voice notice above the composer, shown only when there is something to say: a blocked
  microphone, a room with voice disabled, a recovery in progress, or a give-up.

### Fixed
- One person signed in on two machines occupied a room twice in the room list, while the
  member list correctly showed them once.

### Notes
- Verified against the live server with a synthetic 440 Hz track: produce, forward, consume
  and play, with the received tone measured at 422 Hz — the same signal, one FFT bin wide.
- Video and screen share are not wired yet.

## [0.1.4] - 2026-08-23

### Added
- The room. Signing in now opens the real four-column application against your server
  rather than a placeholder: live channel list with occupancy, member list grouped by
  presence, message history, sending and receiving, room switching, mute, and the animated
  background driven by whoever is actually in the room with you.

### Notes
- Users and peers are modelled separately. Users are accounts and come from HTTP; peers are
  live connections and come from the socket. One person signed in twice is one row in the
  member list and two peers, which is what stops the ghosts the previous client had.
- Voice, video and screen share are not wired yet — the room is the frame they mount into.

## [0.1.3] - 2026-08-23

### Fixed
- Nothing persisted between launches. The renderer was served from `file://`, which has an
  opaque origin, and Chromium refuses storage to opaque origins — every `localStorage` call
  threw. The storage helper catches and returns a fallback by design, so the app silently
  forgot every server and setting on close. It is now served from a registered `weave://`
  scheme with a real, secure origin.
- Pressing Enter on the sign-in form opened server settings instead of signing in. The gear
  icon is a `<button>` with no `type`, which defaults to `submit`, and it sat above the
  Sign In button — so Enter fired the first submit control in the form.

### Added
- A "Remember me next time" box. Credentials go to the OS credential store, encrypted with
  a key bound to this Windows account, never to a plain file. Saved only after the details
  have been shown to work, so a typo is not persisted; unticking clears what was saved.
- The sign-in fields keep what you typed when you visit server settings and come back. In
  memory for the session only, never stored, cleared on success.

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
