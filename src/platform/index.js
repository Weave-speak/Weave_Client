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
    const held = new Map();
    return {
        available: false,
        async get(serverId) { return held.get(String(serverId)) ?? null; },
        async set(serverId, token) { held.set(String(serverId), token); return false; },
        async clear(serverId) { held.delete(String(serverId)); return false; },
    };
}

/**
 * Whether the origin that served this page is itself a Weave server. `null` until checked.
 *
 * The browser build normally inherits its server from wherever it was served, and that is
 * the right default — it is the only server such a page can reach. But the assumption is
 * not guaranteed. A development server, a static host, or a misconfigured deployment can
 * all serve this page without being a Weave server at all, and when that happens the app
 * would otherwise show a sign-in form aimed at something that cannot answer, with no way to
 * point it anywhere else. That is a dead end, so the build asks rather than assuming.
 */
let originIsWeave = null;

/** Recorded once at boot, after the browser build probes its own origin. */
export function noteOriginIsWeave(value) {
    originIsWeave = value === true;
}

/**
 * Updates.
 *
 * A browser build is updated by reloading the page, so there is nothing to report and
 * nothing to install. It says so rather than throwing: the login screen asks about update
 * state on every boot, and a capability that throws when absent turns "no updater here"
 * into an error the user has to see.
 */
const noUpdates = {
    available: false,
    async state() { return { status: 'unsupported' }; },
    async install() { return false; },
    onChange() { return () => {}; },
};

/**
 * Saved sign-in details.
 *
 * The browser build deliberately has none. A browser already has a password manager, it is
 * better than anything we would write, and the user already trusts it — competing with it
 * by keeping a second copy of their password in localStorage would be strictly worse.
 * `available: false` is what makes the "Remember me" box absent there rather than broken.
 */
const noCredentials = {
    available: false,
    async get() { return null; },
    async set() { return false; },
    async clear() { return false; },
};

const browserPlatform = {
    target: 'browser',
    version: VERSION,

    credentials: noCredentials,

    updates: noUpdates,
    diagnostics: { available: false, async read() { return null; }, async openFolder() {} },
    links: { available: false, onDeepLink() {} },
    // In a browser the browser's own picker appears inside getDisplayMedia; onPick
    // simply never fires.
    share: { available: false, onPick() {}, answer() {} },

    // The server that served this page. Not configurable and not presented as if it were —
    // but only once it has actually answered as a Weave server.
    get canChooseServer() { return originIsWeave === false; },
    /** true, false, or null while the probe is still in flight. */
    get servedByWeave() { return originIsWeave; },
    defaultOrigin: () => window.location.origin,

    tokens: memoryTokenStore(),

    /** Browsers do not tell a page whether it is online in any trustworthy way, but this
     *  is still better than nothing for an obviously-offline machine. */
    isOnline: () => navigator.onLine !== false,
};

const desktopPlatform = {
    ...browserPlatform,
    target: 'desktop',
    // A desktop app ships blank: there is no origin to inherit, so there is nothing to probe
    // and the answer is always yes.
    canChooseServer: true,
    servedByWeave: false,
    defaultOrigin: () => null,

    // Replaced at runtime by the Electron preload bridge when it is present. Until the
    // shell exists this falls back to memory, so the web build of the desktop UI still runs
    // in a normal browser during development.
    tokens: (typeof window !== 'undefined' && window.weaveNative?.tokens)
        ? window.weaveNative.tokens
        : memoryTokenStore(),

    credentials: (typeof window !== 'undefined' && window.weaveNative?.credentials)
        ? window.weaveNative.credentials
        : noCredentials,

    // Present only when the Electron bridge is. Running the desktop UI in a plain browser
    // during development is a supported thing to do, and it must not explode.
    updates: (typeof window !== 'undefined' && window.weaveNative?.updates)
        ? { available: true, ...window.weaveNative.updates }
        : noUpdates,

    share: (typeof window !== 'undefined' && window.weaveNative?.share)
        ? { available: true, ...window.weaveNative.share }
        : { available: false, onPick() {}, answer() {} },
    links: (typeof window !== 'undefined' && window.weaveNative?.links)
        ? { available: true, ...window.weaveNative.links }
        : { available: false, onDeepLink() {} },
    diagnostics: (typeof window !== 'undefined' && window.weaveNative?.diagnostics)
        ? { available: true, ...window.weaveNative.diagnostics }
        : { available: false, async read() { return null; }, async openFolder() {} },
};

export const platform = isDesktop ? desktopPlatform : browserPlatform;
