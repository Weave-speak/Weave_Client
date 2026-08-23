// Turning what someone typed into a URL we can actually use.
//
// The field asks for a "server address" and accepts a wide range of things, because the
// alternative is a form with a scheme dropdown, a host field and a port field — three
// chances to get it wrong instead of one. Everything below exists to make one field
// forgiving without being unpredictable.

export class AddressError extends Error {}

/** Addresses we are willing to reach over plain HTTP without being asked twice. */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|.+\.local|.+\.internal|.+\.home\.arpa)$/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

const isPrivate = (host) => PRIVATE_HOST.test(host) || PRIVATE_IPV4.test(host);

/**
 * Normalise a typed address into a base URL.
 *
 * Accepts, in order of how often people actually do it:
 *   weave.example.com              a bare hostname
 *   weave.local:8443               host and port
 *   https://weave.example.com      an explicit scheme
 *   http://192.168.0.50:3002       plain HTTP on a LAN
 *   https://weave.example.com/admin  a URL copied out of a browser
 *
 * Scheme rules. An explicit scheme is always honoured — typing http:// is how you insist.
 * Without one we default to https, EXCEPT for addresses that are obviously on a private
 * network, where a self-hoster running plain HTTP is the common case and https would
 * simply fail. A public hostname is never silently downgraded.
 */
export function normaliseAddress(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new AddressError('Enter a server address.');

    // People paste "wss://" because they have seen it in documentation. It is not wrong so
    // much as one layer down: the app needs an HTTP origin and derives the socket from it.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        ? raw.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
        : null;

    let url;
    if (withScheme) {
        try {
            url = new URL(withScheme);
        } catch {
            throw new AddressError(`"${raw}" is not a valid address.`);
        }
    } else {
        // No scheme. Parse against a placeholder so the URL class does the host/port work,
        // then decide the scheme from what it found.
        let probe;
        try {
            probe = new URL(`https://${raw}`);
        } catch {
            throw new AddressError(`"${raw}" is not a valid address.`);
        }
        const scheme = isPrivate(probe.hostname) ? 'http' : 'https';
        url = new URL(`${scheme}://${raw}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AddressError('A server address must start with http:// or https://');
    }
    if (!url.hostname) throw new AddressError(`"${raw}" is not a valid address.`);

    // A path is discarded rather than rejected. Someone who copies
    // https://weave.example.com/admin out of their browser meant the server, not that page,
    // and telling them off for it helps nobody.
    return {
        origin: url.origin,
        host: url.host,
        hostname: url.hostname,
        secure: url.protocol === 'https:',
        private: isPrivate(url.hostname),
        // The websocket URL is derived, never typed.
        socket: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`,
    };
}

/** How the address should read back to a human: short, and without a redundant scheme. */
export function displayAddress(origin) {
    try {
        const url = new URL(origin);
        const port = url.port && url.port !== '443' && url.port !== '80' ? `:${url.port}` : '';
        return `${url.hostname}${port}`;
    } catch {
        return origin;
    }
}
