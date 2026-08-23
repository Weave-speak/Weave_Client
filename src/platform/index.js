// The platform adapter.
//
// One codebase, two modes. Everything that genuinely differs between running in a browser
// and running in a desktop shell is behind this interface, so the rest of the app never
// asks which it is.
//
// The difference that matters most is not cosmetic. In BROWSER mode the app was served BY
// the server it talks to, so the address is `location.origin` and cannot be changed —
// a page served over https physically cannot connect to a different http server, and
// pointing it at another https server would fail CORS on the credentialed routes anyway.
// In DESKTOP mode there is no origin to inherit: the app ships blank and must be told.
//
// So server management is not "hidden" in browser mode. It does not exist there.

/* global __WEAVE_TARGET__, __WEAVE_VERSION__ */

export const TARGET = typeof __WEAVE_TARGET__ === 'string' ? __WEAVE_TARGET__ : 'browser';
export const VERSION = typeof __WEAVE_VERSION__ === 'string' ? __WEAVE_VERSION__ : '0.0.0';

export const isDesktop = TARGET === 'desktop';
export const isBrowser = !isDesktop;

/**
 * Storage.
 *
 * Namespaced per server, always. The previous client used flat keys like `weave.micGate`
 * and keyed per-user volumes by bare nickname, which was fine when a client could only
 * ever reach one server. A client that can reach several would have silently applied one
 * server's settings to another, and muted "dan" everywhere because you muted a different
 * "dan" somewhere else.
 */
export function createStorage(scope) {
    const prefix = scope ? `weave:${scope}:` : 'weave:';
    return {
        get(key, fallback = null) {
            try {
                const raw = localStorage.getItem(prefix + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(prefix + key, JSON.stringify(value));
            } catch {
                // Quota or a private window. Losing a preference is not worth an error.
            }
        },
        remove(key) {
            try { localStorage.removeItem(prefix + key); } catch { /* as above */ }
        },
    };
}

/**
 * Where a session token lives.
 *
 * In the browser it stays in memory only — a token in localStorage is readable by any
 * script that gets onto the page, and the server issues a fresh one on every sign-in
 * anyway. Desktop overrides this with the OS credential store, which is the whole reason
 * "stay signed in" is a desktop-only option.
 */
function memoryTokenStore() {
    let token = null;
    return {
        available: false,
        async get() { return token; },
        async set(value) { token = value; },
        async clear() { token = null; },
    };
}

const browserPlatform = {
    target: 'browser',
    version: VERSION,

    // The server that served this page. Not configurable, and not presented as if it were.
    canChooseServer: false,
    defaultOrigin: () => window.location.origin,

    tokens: memoryTokenStore(),

    /** Browsers do not tell a page whether it is online in any trustworthy way, but this
     *  is still better than nothing for an obviously-offline machine. */
    isOnline: () => navigator.onLine !== false,
};

const desktopPlatform = {
    ...browserPlatform,
    target: 'desktop',
    canChooseServer: true,
    defaultOrigin: () => null,

    // Replaced at runtime by the Electron preload bridge when it is present. Until the
    // shell exists this falls back to memory, so the web build of the desktop UI still runs
    // in a normal browser during development.
    tokens: (typeof window !== 'undefined' && window.weaveNative?.tokens)
        ? window.weaveNative.tokens
        : memoryTokenStore(),
};

export const platform = isDesktop ? desktopPlatform : browserPlatform;
