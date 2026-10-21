# Placeholders

Screens and controls that exist in the design and are visible in the app, but cannot work
yet. Each is shown rather than hidden, with the reason on screen, because the gaps are the
roadmap and hiding them makes the shape of the product invisible.

A control marked with a dot in the settings nav is one of these.

## Needs a server route

None of these need a schema change unless noted. (Display name, profile picture and status
used to head this list; the server's `PATCH /api/me` and avatar routes made all three real,
behind the `profile` and `profile.display-name` features.)

| Control | What is missing |
|---|---|
| **Hours woven** | Nothing accumulates time in a room. Needs a column or table plus an accumulator on the peer-leave hook. The join date works today and is shown. |
| **Your existing invites** | Creating an invite works today and is wired. Listing and revoking are admin-only, and `listInvites` is unfiltered — it returns every code on the server with who made it, so it cannot simply be relaxed. Needs `GET /api/me/invites` and `DELETE /api/me/invites/:code` scoped to the creator. |
| **Privacy & Blocking** | Nothing exists. Needs a table, routes, and — the load-bearing part — enforcement at every delivery point: chat send and history, the voice consume path, and the roster. A client-side hide is cosmetic on a server that still ships the bytes. |

## Needs the desktop shell

| Control | What is missing |
|---|---|
| **Global push-to-talk** | In-window push-to-talk works today, and so does a global push-to-MUTE toggle (`globalShortcut`, 0.1.69). Hold-to-talk while Weave is unfocused is the missing half: `globalShortcut` reports press but not release, so it needs a native key hook rather than just a new IPC channel. |

## Deliberately not built yet

| Control | Why |
|---|---|
| **Desktop notifications** | The Notifications screen has the message sounds; pop-ups outside the window do not exist yet. Unread and mention state is server-side now, so this is purely a client piece of work. |
| **Themes** | One palette, defined in `src/styles/tokens.css`. A light theme is a later piece of work; the token layer is what will make it cheap. |

## What does work

Recorded so the list above is not mistaken for the whole picture: sign out (properly —
revoking the session server-side), the AFK exemption (account level, confirmed against the
server), noise suppression, echo cancellation, automatic gain, microphone selection,
in-window push-to-talk with a rebindable key, the still-background switch, creating an
invite, the join date, and join/leave sounds (picking one, previewing it, admin add/remove/
default, and actually hearing it when someone arrives or leaves — the `sounds` module
still ships disabled, same as before, but everything behind the flag now works).

Ported from the web app since: slash commands (`/roll`, `/flip`, offered as you type a
slash), priority speaker (per listener, from the right-click menu), "Test my setup" in Voice
& Audio, the message chime and the Notifications screen that switches it, faces and
grouping in the timeline, pasting a screenshot, dismissable link previews, and What's New
after an update.
