// weave:// deep links.
//
// The OS hands the app a URL when someone clicks "Open in Weave" on an invite page. That
// string crossed a machine boundary and arrived from a BROWSER — the least trusted input
// this client takes — so parsing is strict allow-list, and everything else is null: no
// throwing, no partial results, no "probably meant".
//
//   weave://join?server=<host or origin>&code=<invite code>

/** Invite codes are short base32-ish tokens; anything else is not a code. */
const CODE_RE = /^[A-Za-z0-9-]{4,64}$/;

export function parseDeepLink(raw) {
    let url;
    try {
        url = new URL(String(raw ?? ''));
    } catch {
        return null;
    }
    if (url.protocol !== 'weave:') return null;

    // weave://join → host "join"; weave:/join → pathname. Accept both spellings, nothing else.
    const verb = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase();
    if (verb !== 'join') return null;

    const server = url.searchParams.get('server')?.trim() ?? '';
    const code = url.searchParams.get('code')?.trim().toUpperCase() ?? '';
    if (!server || server.length > 200) return null;
    if (!CODE_RE.test(code)) return null;

    // The server value feeds the same normaliseAddress path a typed address does — the
    // parser only refuses the obviously hostile shapes here.
    if (/[\s<>"'`\\]/.test(server)) return null;

    return { verb: 'join', server, code };
}
