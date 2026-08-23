# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Weave-speak/Weave_Client/security/advisories/new)
on this repository. If that is unavailable to you, open a normal issue saying only that
you have a security report and asking for a contact address — no details.

Please include: what you found, how to reproduce it, which version you tested, and what
an attacker could achieve. A working proof of concept helps but is not required.

You will get an acknowledgement within 7 days. We aim to ship a fix or give you a
timeline within 30 days, and we will credit you in the advisory unless you prefer not.

## Supported versions

During initial development, only the latest release receives security fixes.

## Scope

In scope: token handling and storage, the server-discovery and address-parsing path,
anything rendering server-supplied content, the Electron shell's process boundaries and
update mechanism, and any way one configured server could reach another's stored state.

Out of scope: vulnerabilities in a server the client connects to (report those against
[Weave_Server](https://github.com/Weave-speak/Weave_Server)), and anything requiring an
attacker to already control the user's machine.

## Notes for anyone reviewing this client

- **Tokens are not written to disk in the browser build.** They live in memory only,
  because anything in `localStorage` is readable by any script that reaches the page.
  The desktop build uses the OS credential store, which is the entire reason "stay signed
  in" is a desktop-only option.
- **Per-server namespacing is a security boundary,** not a tidiness measure. One server
  must never be able to influence what the client does when talking to another.
- **Self-signed certificates are deliberately not supported.** Accepting them means
  building a "trust this anyway" path, and that path is the vulnerability.
