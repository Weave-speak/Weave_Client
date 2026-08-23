# Placeholders

Screens and controls that exist in the design and are visible in the app, but cannot work
yet. Each is shown rather than hidden, with the reason on screen, because the gaps are the
roadmap and hiding them makes the shape of the product invisible.

A control marked with a dot in the settings nav is one of these.

## Needs a server route

None of these need a schema change unless noted. The single biggest unlock is a
self-service `PATCH /api/me`, which covers the first three at once.

| Control | What is missing |
|---|---|
| **Display name** | No write route for the current user. `validateDisplayName` exists and is unused; `users.display_name` is already a column. Note `text-chat` denormalises the author name, so a rename will not rewrite history. |
| **Profile picture** | Uploads work (`POST /api/uploads`, crew level) but nothing writes `users.avatar`. Second problem: `GET /api/uploads/:id` is authenticated, so a plain `<img src>` gets a 401 — this needs either an unauthenticated avatar route or a fetch-and-blob in the client. |
| **Status** | No status concept anywhere — no column, no WebSocket message, nothing in the peer snapshot. Presence is shown instead. |
| **Hours woven** | Nothing accumulates time in a room. Needs a column or table plus an accumulator on the peer-leave hook. The join date works today and is shown. |
| **Security & Recovery** | `setPassword` and `setSecurityQuestion` exist but are only reachable from the unauthenticated recovery flow and from admin. Needs `POST /api/me/password` and `POST /api/me/security-question`, both re-verifying the current password. |
| **Sessions & Devices** | Sessions are stored with enough detail to list, but there is no crew-facing route. **This one needs a migration**: the primary key is `token_hash`, a secret that must never be served, so a session needs an opaque id before the client can refer to one. |
| **Your existing invites** | Creating an invite works today and is wired. Listing and revoking are admin-only, and `listInvites` is unfiltered — it returns every code on the server with who made it, so it cannot simply be relaxed. Needs `GET /api/me/invites` and `DELETE /api/me/invites/:code` scoped to the creator. |
| **Privacy & Blocking** | Nothing exists. Needs a table, routes, and — the load-bearing part — enforcement at every delivery point: chat send and history, the voice consume path, and the roster. A client-side hide is cosmetic on a server that still ships the bytes. |

## Needs a module

| Control | What is missing |
|---|---|
| **Join and leave sounds** | The `personas` module ships disabled. Once an admin enables it, everything a crew member needs is already crew level. Two caveats: uploading sounds is admin-only so a fresh library is empty, and the preview route is authenticated so playback needs a blob URL rather than `<audio src>`. |
| **Report a Bug** | No module and no endpoint. The client half is already built — `weaveNative.diagnostics.read()` returns a pre-redacted updater log — but there is nowhere to send it. Redaction must stay on the reporter's machine and be previewable before anything leaves. |

## Needs the desktop shell

| Control | What is missing |
|---|---|
| **Global push-to-talk** | In-window push-to-talk works today. A hotkey that fires while Weave is unfocused needs `globalShortcut` and a preload bridge method — and `globalShortcut` reports press but not release, so true hold-to-talk needs a native key hook rather than just a new IPC channel. |

## Deliberately not built yet

| Control | Why |
|---|---|
| **Notifications** | Weave does not track unread messages or mentions, so there is nothing to notify anyone about. Device-local toggles would work today; they would just have no source of truth to react to. |
| **Themes** | One palette, defined in `src/styles/tokens.css`. A light theme is a later piece of work; the token layer is what will make it cheap. |
| **Camera and screen share** | Voice first. The producer slots (`screen`, `webcam`, `screen-audio`) are already in the protocol. |

## What does work

Recorded so the list above is not mistaken for the whole picture: sign out (properly —
revoking the session server-side), the AFK exemption (account level, confirmed against the
server), noise suppression, echo cancellation, automatic gain, microphone selection,
in-window push-to-talk with a rebindable key, the still-background switch, creating an
invite, and the join date.
