# Weave Client

The client for [Weave Server](https://github.com/Weave-speak/Weave_Server) — self-hosted
voice, video and text chat for small groups.

One source tree, two builds:

| Build | How it gets its server | Ships |
|---|---|---|
| **browser** | The origin that served it | With the server, at `/` |
| **desktop** | You point it at one | As an installable app |

> **Status: early development.** The authentication surface works end to end against a
> real server. The room — voice, screen share, chat — is the next piece of work.

## The difference between the two builds

It is not cosmetic, and it is the reason `src/platform/` exists.

In **browser** mode the app was served *by* the server it talks to, so the address is
`location.origin` and cannot be changed. A page served over HTTPS physically cannot
connect to a different HTTP server, and pointing it at another HTTPS server would fail
CORS on the credentialed routes anyway. Server management is therefore not hidden in the
browser build — **it does not exist there**, and is compiled out.

In **desktop** mode there is no origin to inherit. The app ships blank and must be told
where to go, so it carries a server list, a gear menu, and the discovery flow.

## Ships blank, connects anywhere

The desktop build has no server baked into it. On first run it asks for an address and
accepts what people actually type:

```
weave.example.com                 a bare hostname          -> https
weave.local:8443                  host and port            -> http, it is a LAN name
https://weave.example.com         an explicit scheme       -> honoured, always
wss://weave.example.com           pasted from docs         -> converted to its origin
https://weave.example.com/admin   copied from a browser    -> path discarded
```

Before anything is saved it asks the address `GET /api/server-info`, checks it is a Weave
server, and negotiates a protocol range — an overlap, never an equality, so a slightly
newer client does not refuse a server that would have worked. Nothing enters the server
list until it has been proven reachable; a list full of addresses that have never worked
is worse than an empty one.

## Principles

- **Touch nothing on the user's machine we don't have to.** No drivers, no injection, no
  registry writes beyond an opt-in autostart, no global state we do not restore.
- **Settings are namespaced per server.** A client that can reach several servers must
  never apply one server's preferences to another.
- **Say only what is true.** In a browser, `fetch` reports DNS failure, connection
  refused, TLS failure, CORS and mixed content identically. So there is one honest
  "couldn't reach it" message naming those possibilities, rather than five specific
  messages that would each be wrong four times out of five. Where the desktop build has a
  real error code, it says more.

## Develop

```bash
npm ci
npm run dev                      # browser build, http://localhost:5173
WEAVE_TARGET=desktop npm run dev # desktop build, with the server list
npm test
```

The dev server runs on its own origin and talks to a real Weave server cross-origin —
the same path the desktop build takes in production. That is deliberate: it exercises
CORS during development instead of discovering it at release.

## Build

```bash
npm run build                      # -> dist/            served by a Weave server
WEAVE_TARGET=desktop npm run build # -> dist-electron/renderer
```

## Licence

[MIT](LICENSE). The client is deliberately more permissive than the AGPL-3.0 server: a
protocol needs clients, and nobody should have to open-source an app to talk to a Weave
server.
