# Changelog

All notable changes to Weave Client are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.42] - 2026-08-28

### Fixed
- Screen shares were black. 0.1.41 asked for VP9 with spatial layers, which negotiated and
  connected perfectly — the share was produced, both viewers consumed it, the server log
  was clean — and then no frame ever decoded. Back to the codec that worked. VP9 is still
  the right choice for screen text and the server still offers it; it returns when it has
  been tested between two real machines rather than reasoned about.
- Everyone watching a screen share heard themselves through it. 0.1.41 turned off echo
  cancellation on the shared-audio capture, on the grounds that it degrades music. It does
  — but that capture is the machine's whole output mix, and the mix contains the call, so
  echo cancellation was also the only thing stopping everyone's voices being picked up and
  sent back to them. It stays on.

  Noise suppression and automatic gain stay off, since neither had anything to do with the
  loop and both flatten music. The cost is that shared audio is mono again: the echo
  canceller downmixes. Getting stereo back needs the shared application's audio captured
  on its own rather than the whole system mix, which is a feature rather than a setting.

## [0.1.41] - 2026-08-28

### Fixed
- Some microphones produced complete silence, on some machines only, with nothing reported
  anywhere. If your capture device presented two channels — many USB interfaces, line
  inputs, and several headset drivers do — the noise gate crashed on the first block of
  audio and was never run again. Everything went on reporting success while nothing was
  sent. If you have ever been told you sounded fine one day and were inaudible the next,
  this was probably why.
- Stream quality, camera quality, input gain and the noise gate all reverted every time you
  restarted, and again every time you opened Settings. They were saved correctly and then
  discarded on the way back in, so choosing 1080p60 quietly left you on 1080p30 for ever.
- Shared system audio was being run through the processing meant for a microphone. Echo
  cancellation was subtracting the audio being shared, noise suppression was treating
  sustained music as noise, and automatic gain was flattening everything to one volume.
  Shared audio is now captured untouched, and in stereo — it was only ever stereo in name.
- Losing one direction of audio no longer means reconnecting by hand. A connection that
  stopped carrying media went unnoticed: it was only acted on when the browser gave up
  entirely, which it often never did, so the room simply stopped hearing you — or you
  stopped hearing them — with nothing on screen to say so. It is now noticed and repaired,
  and while that is happening the connection indicator says so.
- After a failed reconnection attempt, the microphone stayed off for the rest of the
  session with nothing left to notice. A listener who never turned their microphone on
  could also exhaust the reconnection budget over a session's ordinary hiccups and be told
  to rejoin the room for something everyone else survived.

### Added
- Voice is encoded at 64 kb/s rather than roughly 32, and shared system audio at 128 in
  stereo. This is most of the difference between "muffled" and "clear".
- Screen shares use VP9 where the server offers it, which is considerably sharper on text
  and carries several quality layers at once, so one viewer on a poor connection no longer
  drags the picture down for everybody.
- A camera frame rate setting, which was already being read but could never be set.
- The camera's quality ladder now follows the resolution you chose. Picking 1080p used to
  give a 1080p picture squeezed into a 720p budget, which looked worse than 720p.

## [0.1.8] - 2026-08-23

### Added
- A room browser, reached from the search icon beside the server name. Cards show who is in
  each room by face rather than by number, with a live-only filter, and clicking one takes
  you there. It stays live while open, so the counts cannot go stale under you.

### Notes
- Room descriptions and capacities appear in the design but the server stores neither, so
  they are absent rather than invented. A fabricated "2 of 40" would look authoritative and
  mean nothing.

## [0.1.7] - 2026-08-23

### Added
- Settings. The gear and your name in the corner both open it. Working today: noise
  suppression, echo cancellation, automatic gain, microphone selection, in-window
  push-to-talk with a rebindable key, a still-background switch, creating an invite, the
  AFK exemption, and your join date.
- Every control the server cannot support yet is shown with the reason on screen rather
  than hidden or silently disabled. Recorded in docs/placeholders.md.

### Fixed
- Signing out never told the server. The app defined `api.logout` and called it from
  nowhere, so quitting left a usable session behind for up to twelve hours. The power
  button in the corner did the same — it dropped the socket and rebooted the UI while the
  session stayed live.
- Join dates could show the wrong day. SQLite returns UTC timestamps with a space and no
  zone marker, which JavaScript parses as local time.

## [0.1.6] - 2026-08-23

### Added
- You can see who is talking. A ring appears around the avatar of anyone speaking, in both
  the room list and the member list, held briefly so it reads as a signal rather than
  strobing on every syllable.

### Fixed
- Audio levels are keyed per connection while people are keyed per account, so somebody
  signed in on two machines never matched and showed as silent while audibly talking. A
  person now carries every connection they have, and the loudest wins.

### Notes
- Paired with a server fix: a move between channels served by different SFU workers now
  rebuilds the media path instead of silently stranding it. Inert until the server runs more
  than one worker, which is not the default.

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
