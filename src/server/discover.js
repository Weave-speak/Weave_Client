// Finding out whether there is a Weave server at an address, and whether we can talk to it.
//
// The honest constraint that shapes this file: in a browser, `fetch` rejects with the same
// opaque TypeError for DNS failure, connection refused, TLS failure, a CORS rejection and
// mixed-content blocking. They are genuinely indistinguishable from JavaScript. Inventing
// five separate error messages for them would be fiction, and the user would be told
// something specific and wrong — worse than being told something vague and true.
//
// So there is ONE "could not reach it" outcome with a short list of likely causes, and the
// distinctions that CAN be made honestly — timeout, wrong software, incompatible version,
// unfinished setup — each get their own.
//
// A desktop build can do better, because Node-level errors carry a code. Where a platform
// supplies one, it is used to sharpen the message.

import { normaliseAddress, AddressError } from './address.js';

/** Long enough for a slow home connection, short enough not to feel broken. */
const TIMEOUT_MS = 8000;

export const OUTCOME = Object.freeze({
    OK: 'ok',
    BAD_ADDRESS: 'bad_address',
    UNREACHABLE: 'unreachable',
    TIMEOUT: 'timeout',
    NOT_WEAVE: 'not_weave',
    INCOMPATIBLE: 'incompatible',
    NEEDS_SETUP: 'needs_setup',
});

/** The protocol range this client speaks. Bump MAX on a breaking wire change. */
export const CLIENT_PROTOCOL = Object.freeze({ MIN: 1, MAX: 1 });

/**
 * Ask an address whether it is a Weave server we can use.
 *
 * Never throws for an expected failure — the outcome IS the result. Callers render
 * `message` directly.
 */
export async function discover(input, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    let address;
    try {
        address = normaliseAddress(input);
    } catch (err) {
        if (err instanceof AddressError) {
            return { outcome: OUTCOME.BAD_ADDRESS, message: err.message };
        }
        throw err;
    }

    let response;
    try {
        response = await fetchImpl(`${address.origin}/api/server-info`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
            // No credentials: this runs before anyone has signed in, and the endpoint is
            // deliberately unauthenticated so a client can decide before it commits.
            credentials: 'omit',
            cache: 'no-store',
        });
    } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            return {
                outcome: OUTCOME.TIMEOUT,
                address,
                message: `${address.hostname} didn't respond. It may be offline, or a firewall may be blocking it.`,
            };
        }
        return { outcome: OUTCOME.UNREACHABLE, address, message: unreachableMessage(address, err), cause: err };
    }

    if (!response.ok) {
        return {
            outcome: OUTCOME.NOT_WEAVE,
            address,
            message: `Something answered at ${address.hostname}, but it isn't a Weave server `
                + `(it returned ${response.status}).`,
        };
    }

    let info;
    try {
        info = await response.json();
    } catch {
        return {
            outcome: OUTCOME.NOT_WEAVE,
            address,
            message: `Something answered at ${address.hostname}, but it isn't a Weave server.`,
        };
    }

    if (info?.product !== 'weave' || !info?.protocol) {
        return {
            outcome: OUTCOME.NOT_WEAVE,
            address,
            message: `Something answered at ${address.hostname}, but it isn't a Weave server.`,
        };
    }

    // Range overlap, never equality. Equality is what produces the failure where a
    // slightly newer client refuses a server that would have worked perfectly well.
    const agreed = Math.min(CLIENT_PROTOCOL.MAX, info.protocol.max);
    if (agreed < Math.max(CLIENT_PROTOCOL.MIN, info.protocol.min)) {
        const appIsOlder = CLIENT_PROTOCOL.MAX < info.protocol.min;
        return {
            outcome: OUTCOME.INCOMPATIBLE,
            address,
            info,
            message: appIsOlder
                ? `This app is too old for ${info.instance?.name ?? 'that server'}. Update the app and try again.`
                : `${info.instance?.name ?? 'That server'} is too old for this app. `
                  + 'Ask whoever runs it to update it.',
            detail: `App speaks protocol ${CLIENT_PROTOCOL.MIN}–${CLIENT_PROTOCOL.MAX}; `
                + `server speaks ${info.protocol.min}–${info.protocol.max}.`,
        };
    }

    if (info.setupRequired) {
        return {
            outcome: OUTCOME.NEEDS_SETUP,
            address,
            info,
            message: `${info.instance?.name ?? 'That server'} is running but has no administrator yet. `
                + 'Whoever set it up needs to finish first-run setup before anyone can sign in.',
        };
    }

    return { outcome: OUTCOME.OK, address, info, protocol: agreed };
}

/**
 * The single unreachable message, plus whatever the platform can honestly add.
 *
 * In a browser `err` carries nothing useful. In Electron the underlying Node error has a
 * code, so the desktop build can say which of these it actually was.
 */
function unreachableMessage(address, err) {
    const code = err?.cause?.code ?? err?.code;

    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return `${address.hostname} doesn't resolve. Check the address for a typo.`;
        case 'ECONNREFUSED':
            return `Nothing is listening at ${address.host}. Check the server is running and the port is right.`;
        case 'ECONNRESET':
            return `${address.hostname} closed the connection. It may not be speaking HTTP${address.secure ? 'S' : ''} on that port.`;
        case 'CERT_HAS_EXPIRED':
            return `${address.hostname} has an expired certificate.`;
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            return `${address.hostname} is using a certificate this app can't verify. `
                + 'It needs a certificate from a recognised authority.';
        default:
            break;
    }

    // The browser case, and any code we do not recognise.
    //
    // In a browser this single outcome genuinely covers DNS failure, connection refused,
    // TLS failure, a CORS rejection and mixed-content blocking — fetch reports all five
    // identically. That includes "you reached a real website that simply isn't Weave",
    // which is why that possibility is named here rather than getting a message of its
    // own it could never reliably earn.
    return `Couldn't reach a Weave server at ${address.host}. It may be offline or `
        + "unreachable from here, or the address may point at something that isn't Weave.";
}
