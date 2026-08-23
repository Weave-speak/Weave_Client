# Contributing to Weave Client

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line:

```bash
git commit -s -m "Add a thing"
```

This certifies the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or have the right to submit it, and that you are contributing
it under this project's licence (MIT). CI rejects unsigned commits.

## Before you start

Open an issue for anything larger than a bug fix. A short conversation beforehand is much
cheaper than a rejected pull request.

## Architecture in one paragraph

One source tree builds two apps. `src/platform/` is the only place allowed to know which
one is running; everything else asks the platform rather than sniffing for Electron or
checking a user agent. `src/server/` turns a typed address into a proven-reachable server
and remembers it. `src/auth/` is the sign-in surface. Anything that differs between
browser and desktop belongs behind the platform adapter — if you find yourself writing
`if (window.electron)`, that is the signal you are in the wrong file.

## Style

Match the surrounding code. It is plain modern JavaScript with ES modules — no
TypeScript, no framework, no state library. Views are functions that return HTML strings;
behaviour is attached separately. This is small enough that a framework would cost more
than it saves.

Comments explain **why**, not what. A comment that restates the code is noise; a comment
recording the bug that made a line necessary is worth its weight.

## Two rules that are specific to a client

**Say only what is true.** Error messages are the product here. A browser cannot tell DNS
failure from a TLS failure from a CORS rejection — `fetch` reports all of them
identically — so do not write a message that claims to know which it was. One honest
message naming the possibilities beats five specific ones that are each usually wrong.

**Namespace anything you persist.** Settings, volumes, mutes, tokens: all of it is keyed
per server. A client that can reach several servers must never carry one server's state
into another. `settingsFor(serverId)` exists for this; use it rather than
`localStorage` directly.

## Touch nothing you don't have to

This app runs on someone else's computer. No drivers, no injection into other processes,
no registry writes beyond an opt-in autostart, no global system state changed without
restoring it. A feature that requires any of those needs a conversation first.

## Tests

`npm test` runs the Node test runner over `test/`. Address parsing, discovery and the
server store are pure and must stay tested — they are where a wrong answer is silent.
UI behaviour is checked by hand for now; describe the manual check in the pull request.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Never commit

Real hostnames, IP addresses, tokens, or anything identifying a specific deployment —
including in comments, examples and test fixtures. Use `example.com`, `203.0.113.10`
(TEST-NET-3) and obvious placeholders. This client is meant to connect to *any* Weave
server; a particular one appearing in the source is always a mistake. CI greps for it,
but that is a backstop, not a substitute for care.
