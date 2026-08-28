# Weave Client — context for Claude

The desktop and browser client for [Weave](https://github.com/Weave-speak/Weave_Server),
a self-hosted voice/text app. **MIT**, deliberately more permissive than the AGPL server:
a protocol needs clients, and nobody should have to open-source their app to talk to a
Weave server. One source tree, two builds — browser (`npm run build`) and Electron desktop
(`npm run build:desktop`).

Current release: **0.1.40**. Windows installers are published to GitHub Releases, unsigned,
so SmartScreen warns until a certificate exists.

## Commands

```bash
npm run dev            # vite, browser build
npm run electron:dev   # the desktop shell
npm test               # eslint + node --test  (must be green before a release)
npm run pack           # build an installer without publishing
npm run release        # version must already be bumped, committed and tagged
```

## Layout

```
electron/          the desktop shell — Node/main process
  main.js          entry point; what electron-builder launches
  app.js           window, IPC, screen-capture handler, updater wiring
  preload.cjs      the ONLY bridge between shell and renderer

src/               the app — shared by both builds
  main.js          renderer entry
  net/link.js      websocket, heartbeat, reconnect, link state
  media/           voice.js (mediasoup: produce/consume, mute, deafen, screen share)
                   chain.js gate-worklet.js mute-policy.js presets.js
  room/            index.js — the big one, ~2.1k lines: stage, chat, controls, WS events
                   stage-paint.js state.js shell.js messages.js history.js
                   embeds.js mentions.js icons.js
    views/         stage.js sidebar.js rail.js timeline.js parts.js — PURE markup
  auth/ rooms/ server/ settings/ ui/ updates/
  styles/          tokens.css ← the design system; a raw hex elsewhere is a bug

test/              26 files, plain `node --test`
scripts/           ensure-release · finish-release · predict-delta · make-installer-art
dev/               component sandboxes (shell.html, background.html, fixtures.js)
docs/releasing.md  the four rules that silently break delta updates — READ before releasing
dist-electron/     build output. Generated. Never edit.
```

The installer is per-user NSIS, so the app lands wherever the user chose at install time
(`resources/app.asar` inside it) and updates reinstall silently into that same directory.
Per-user data lives in
`%APPDATA%\Weave` — `tokens.dat` and `credentials.dat` hold sessions and logins, `logs/`
holds the app log. Fatal startup errors go to `%TEMP%\weave\startup-crash.log`.

## Which file

| Question | File |
|---|---|
| Audio, video, screen share, deafen | `src/media/voice.js` |
| Reconnect, heartbeat, "link is degraded" | `src/net/link.js` |
| Anything on screen in a room | `src/room/index.js` |
| Markup only, no behaviour | `src/room/views/*` |
| Native window, IPC, capture picker, updates | `electron/app.js` |
| Colors, spacing, radii | `src/styles/tokens.css` |

## Conventions

- **Views are pure functions of state.** They return markup and never touch `srcObject`,
  the DOM, or the network. That is what lets the whole layout be asserted on in tests with
  no browser and no socket — there is no jsdom here, and adding one would be a step back.
- **Tests follow the same rule.** Where logic is worth testing, extract it as a pure
  function (see `src/room/stage-paint.js`) rather than reaching for a DOM shim.
- **Comments say why, not what.** The codebase explains reasoning and records what was
  ruled out; match that voice rather than annotating syntax.
- Commit messages are full prose explaining the reasoning, not one-liners. See
  `git log` for the house style.

## Things that have already cost a day

- **Electron cannot decline a display-media request cleanly.** `callback({})` throws
  `TypeError: Video was requested, but no video stream was provided` from the native
  binding — undocumented, and it killed the app on every cancelled share. The throw is
  cosmetic: the request completes and the renderer's `getDisplayMedia()` rejects with
  `AbortError`. Swallow it on the decline path only. Note a cancel arrives under two names
  — a browser's own picker gives `NotAllowedError`, ours gives `AbortError`.
- **Repainting the stage ejects a fullscreen viewer.** `paintStage()` writes `innerHTML`,
  and detaching the fullscreen element is how a browser is told to leave fullscreen. The
  pong carries the room's producer truth every 25 s, so an unconditional repaint dropped
  people out of fullscreen on a timer. `stage-paint.js` now decides; do not bypass it.
- **`x ??= await f()` is not concurrency-safe.** Two callers both see null and both create
  a transport. This caused a real "audio is not arriving" bug; fixed in 0.1.35.
- **When nobody can hear anything, dump the ICE candidates first.** A `0.0.0.0` candidate
  broke every LAN client, and no amount of reading signalling code would have shown it.
- **Processed mic tracks can be silently empty in Chromium** (worklet + MediaStreamSource).
  Always verify a track carries audio rather than assuming the graph works.
- **Deltas are fragile.** An update is ~1 MB against a ~108 MB installer because
  electron-updater diffs blockmaps. `npm run predict-delta` fails the release if that
  ratio degrades — usually a changed build machine or bumped toolchain.

## Releasing

Bump `version` in `package.json` (a one-line edit — do not reformat the file), commit,
tag `vX.Y.Z`, push both, then `npm run release` with `GH_TOKEN` in the environment. The
tag must be pushed explicitly: `--follow-tags` skips lightweight tags. `ensure-release.mjs`
creates the GitHub release first, deliberately, so electron-builder's concurrent
publishers do not each create one and split the assets across two releases sharing a tag.
