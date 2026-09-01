# Changelog

All notable changes to Weave Client are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.51] - 2026-09-01

### Fixed
- **Voices stuttered and dropped to barely audible, and never quite for the same person.**
  The microphone was asking Opus to suppress its own silence — DTX — which stops sending
  during whatever the encoder judges to be a gap and clips the front of the next word
  coming back out of one. That is what the stutter was. It has been on since long before
  anyone started reporting this, which is why it never lined up with any particular
  release, and it hurts worst on exactly the connections that were already struggling.

  It is off now, and it costs nothing to lose: the noise gate already decides when you are
  not talking, against a threshold you can see and set, so DTX was doing a job nothing
  needed done. Your microphone is also announced to the encoder as speech rather than left
  to be guessed at, and kept full-band instead of being allowed to quietly narrow.

  Four releases in a row once tried to improve this path by reasoning about it and each
  made something worse, so none of this is reasoned either: it is what the Weave web app
  sends, which is the thing people compare us to when they say voice is better over there.
  A server new enough to carry voice at 96 kb/s helps further still, since a browser left
  to itself settles around 32 kb/s; against an older one the fixes above stand on their own.

### Added
- **Sound optimisation**, in Settings → Voice & Audio, off unless you turn it on. It evens
  out a loud voice so nobody blasts the room, and cuts the low rumble and hum that cheap
  microphones pick up and then spend bitrate carrying. Off, your voice takes exactly the
  path it always has. It applies the moment you switch it, mid-sentence and without a gap.

### Changed
- **You can turn somebody up as well as down.** The volume slider on a person, and the one
  on a stream, now reach 200% instead of stopping at 100% — which is as far as the browser
  would let an audio element go, so quiet talkers had no fix at all. Incoming sound is
  routed through the same audio engine the meters already use to get past that ceiling,
  and falls back to the old path by itself if that engine is ever unavailable.

- The noise gate no longer flickers on the end of a sentence. It opened and closed on one
  number, so a voice trailing off and resting on the line chattered it several times a
  second; it now takes a slightly quieter level to close than it did to open.

- A microphone that goes silent because the browser suspended our audio engine — the window
  going to the background, the system moving audio focus elsewhere — is noticed and
  restarted, rather than staying silent while everything reports success.

## [0.1.50] - 2026-08-31

### Fixed
- **The zoom slider did nothing when cropping a profile picture.** It moved, and the
  picture stayed exactly where it was. Zoom was being measured against the image's own
  pixels rather than against the size of the crop circle, so on anything as large as a
  photograph every position of the slider asked for more than the maximum and landed on the
  same one. It now means what it looks like it means: at the left the picture fills the
  circle, and it grows smoothly to four times that at the right.

- **Your new picture did not appear on the Settings → My Profile card.** It showed up
  everywhere else — the room list, the bottom bar — while the one screen you chose it on
  carried on showing your initials. It now appears there too, both straight after saving
  and when you next open Settings.

### Removed
- The Display Name box in Settings → My Profile. It could not be typed into and existed
  only to explain that changing your name is not possible yet; your name is already on the
  card above it. If it becomes changeable, the field returns as one that works.

## [0.1.49] - 2026-08-31

### Changed
- **Being moved to the away room now depends on whether you are at your computer.** The
  desktop app reports how long your keyboard and mouse have gone untouched — across every
  application, not just Weave — and the server uses that instead of guessing from whether
  you have been talking. Working quietly in another window no longer looks like having left.

  Talking still counts. Whichever happened more recently — speaking, or touching your
  machine — is what you are judged on, because either one means you are there.

  Watching somebody's screen share inside Weave counts as being present too, however long
  you go without touching anything. A video playing in a different application still cannot
  be seen: to the operating system that looks the same as an empty chair, so the timeout is
  what protects you there.

  Nothing here reaches a server older than **0.1.21** — those carry on measuring microphone
  silence exactly as before — and nothing is reported at all when Weave is running in a
  browser, because a web page cannot see input to other windows.

### Fixed
- The status panel behind your own name was laid out wrongly: "Online" and "Away" appeared
  on a line of their own beneath their dot, with the tick stranded off to the right. The dot,
  the label and the tick now sit on one line as intended, with the description underneath.

## [0.1.48] - 2026-08-31

### Added
- **A profile picture.** Settings → My Profile now has an upload button. Pick an image and
  it opens in a circular frame — drag it to choose what sits inside the circle, use the
  slider to zoom, then save. What you see in the frame is exactly what gets stored: the
  crop happens here on your machine, and only the finished square is sent.

  It then appears wherever you do — the room list, the bottom bar, your messages. Remove
  takes it away again and puts your initials back.

- **A status, behind your own name.** Clicking your profile in the bottom bar now opens a
  small panel: Online or Away, with a tick on the one you are on, and Settings underneath.
  The dot beside your name changes to match, and so does the one everybody else sees.

  Your choice is remembered by the server, so it survives closing the app. It is also a
  separate thing from being moved to the away room for going quiet — that is about where
  you are, this is about whether you want to be disturbed, and neither undoes the other any
  more.

### Changed
- The dot beside somebody in a room means something now. It used to say only that they were
  connected, which everyone in the list is anyway; it now shows what that person has said
  about themselves.

- Settings is one click further away, reached from the panel behind your name rather than
  directly. That is the trade for status living somewhere you will actually use it — buried
  in a preferences dialog, a status is one nobody sets and nobody trusts.

### Requires
- A server running **0.1.20** or newer. Against an older one the upload button and the
  status options are simply not shown, rather than shown and failing.

## [0.1.47] - 2026-08-31

### Added
- **Right-click somebody in a room.** Until now a person in the sidebar was text: the pointer
  turned into a cursor for selecting words, dragging across the list highlighted names, and
  there was nothing you could do with any of it. A right-click now opens a menu with the two
  controls you actually want — mute them just for you, and set how loudly you hear them.
  Neither leaves your machine. Nobody else is affected and nobody is told.

  Per-person volume already existed, but only reached the person you were watching on the
  video stage. It now reaches anybody in the room, whether they are on camera or not.

- **For administrators, two more entries below a divider.** Server mute silences somebody in
  a way they cannot undo — five minutes, an hour, or until you lift it — and Kick disconnects
  them and holds the door for a minute. Kick asks twice before it does anything, because a
  menu that opens under your pointer is a bad place to keep a one-click ejection.

- **Drag somebody into another room.** Administrators can pick a person up from the sidebar
  and drop them in a different voice room. Only rooms you can stand in light up as you pass
  over them, so a text strand is never offered as somewhere to put a person.

### Changed
- Being server-muted says so. Your microphone button goes dark with the reason and, when it
  is a timed mute, the time it ends; the room says the same thing above the composer. Before,
  a muted person had a button that looked live and did nothing — which reads as a broken app
  rather than as a moderation decision. Somebody else's forced mute is marked differently to
  their own in the sidebar, because choosing not to speak and not being allowed to are not
  the same fact.

- Being kicked shows what happened and comes back on its own once the minute is up, standing
  in no room rather than dropping you back into the one you were removed from.

## [0.1.46] - 2026-08-30

### Fixed
- Screen shares of games stuttered, and the cause was our own frame rate cap rather than
  anything on the network. A quality setting of 30fps was applied as a hard ceiling, which
  makes the capture run on a fixed timer — and a game drawing 70 frames a second into a
  30-per-second grid puts two frames in one slot and one in the next, over and over. Nothing
  was being lost. The stagger was manufactured before the picture ever left the machine.

  The rate you pick is now a target rather than a ceiling, and a share settles on the nearest
  rate the source divides into evenly. A 70fps game streams at 35 — two whole frames each
  time, evenly spaced — where before it stumbled along at a nominal 30. A 144fps game streams
  at 28.8, a 50fps one at 25. There is nothing to configure: it measures what you are actually
  sharing a few seconds in, and looks again as you play, because a game's frame rate moves
  between a menu and a firefight.

- Shared audio sounded far worse than it should have. Nothing was setting a bitrate for it, so
  it fell back to the browser engine's own default of around 32 kb/s — and then split even
  that across two channels, well under what music or a game's soundtrack needs to survive at
  all. It is now encoded at 256 kb/s, which is Opus's own recommended ceiling for stereo music
  and a rounding error beside the video it travels with.

  This is not the voice bitrate that 0.1.45 handed back to server operators, and that decision
  stands: your microphone is untouched and still follows the server. A screen's system audio is
  a different slot with a different job, and the server has only one value to give both —
  raising it there to suit shared music would drag every microphone up with it for nothing.

### Known
- Shared system audio is still carried as one channel rather than two. Echo cancellation has to
  stay on for it, because the capture is your machine's whole output mix and that mix contains
  the call — without it, everyone hears their own voice returned through your stream — and
  cancelling echo downmixes to mono as a side effect. Sharing one application's audio instead
  of the whole mix is the real answer, and it is a larger piece of work.

## [0.1.45] - 2026-08-29

### Changed
- Voice encoding is back to exactly what 0.1.40 did. Four releases tried to improve it and
  each one made something worse — a mismatched audio clock, then retransmission that made
  distant callers sound fast-forwarded, then a general loss of quality that no single
  explanation covered. That last one is the point: when three explanations in a row have
  been wrong, the right move is to return to the version people were happy with rather
  than reason a fourth time.

  So the microphone is captured and encoded the way it was before any of this started.
  Nothing is pinned, nothing is forced, and Opus is left to make its own decisions about
  bandwidth under pressure — which it is good at, and which being told otherwise prevented.

- Raising the voice bitrate is now something a server operator turns on and listens to,
  rather than a guess baked into a release. It is genuinely worth having, and it will come
  back on by default once somebody has compared the two by ear.

### Kept
- Every actual bug fix from 0.1.41 onwards stays: the noise gate no longer kills stereo
  microphones, quality settings survive a restart, a dead connection is noticed and
  repaired instead of silently staying dead, shared audio no longer echoes the room back
  to itself, and screen shares are not black.

## [0.1.44] - 2026-08-29

### Fixed
- Callers on another continent sounded fast-forwarded and crackly. 0.1.41 asked for Opus
  retransmission, which mediasoup-client otherwise strips. Retransmission costs a full
  round trip, so the receiver holds its jitter buffer open waiting for a repeat of any
  lost packet — and then plays the audio slightly fast to catch back up, which is exactly
  what "fast-forwarded" is. Nothing was ever coming: the server does not retransmit audio,
  so the waiting bought nothing at all.

  Over a short hop the delay is small enough to go unnoticed, which is why this only ever
  showed up for people calling from far away. Removed. Forward error correction, which
  costs no round trip because the redundancy travels inside the next packet, still does
  the loss resilience — and it helps a distant caller just as much as a near one.

## [0.1.43] - 2026-08-29

### Fixed
- Voice crackled and popped. 0.1.41 pinned the audio graph to 48 kHz and asked the
  microphone for a 10 ms buffer, both to save Opus a resample it never needed saving from.
  The sample rate asked of a microphone is only a request — a device that runs at 44.1 kHz
  carries on doing so — while the graph was pinned regardless, and feeding a 44.1 kHz
  microphone into a 48 kHz graph is the mismatch that clicks. The 10 ms buffer then left no
  headroom for a machine doing anything else, and each underrun is heard as a pop.

  Both are gone. Capture and the graph follow the hardware, as they did before, so they
  always agree. The resample this was avoiding is inaudible; the crackling was not.

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
