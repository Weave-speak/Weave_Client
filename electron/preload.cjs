// The bridge between the desktop shell and the page.
//
// Everything the renderer can do natively passes through here, and nothing else does. The
// renderer never receives `ipcRenderer` itself: handing over the raw object would let any
// script on the page invoke any channel the main process has ever registered, which is the
// same as having no boundary at all.
//
// So each capability is a named function with a fixed channel and a fixed shape. Adding one
// is a deliberate act, visible in a diff.
//
// CommonJS, because a sandboxed preload is not an ES module.

const { contextBridge, ipcRenderer } = require('electron');

/** Channels the main process may push on. Anything else is ignored. */
const PUSH = new Set(['weave:update']);

contextBridge.exposeInMainWorld('weaveNative', {
    /**
     * Session tokens, held in the OS credential store rather than in the page.
     *
     * Keyed per server: a client that can reach several servers must never carry one
     * server's credentials to another.
     */
    tokens: {
        available: true,
        get: (serverId) => ipcRenderer.invoke('weave:tokens.get', String(serverId)),
        set: (serverId, token) => ipcRenderer.invoke('weave:tokens.set', String(serverId), String(token)),
        clear: (serverId) => ipcRenderer.invoke('weave:tokens.clear', String(serverId)),
    },

    /**
     * Saved sign-in details for the "Remember me" box, held in the OS credential store.
     *
     * Separate from tokens: a token expires and can be revoked server-side, a saved password
     * cannot. Signing out should be able to drop one without the other.
     */
    credentials: {
        available: true,
        get: (serverId) => ipcRenderer.invoke('weave:credentials.get', String(serverId)),
        set: (serverId, username, password) =>
            ipcRenderer.invoke('weave:credentials.set', String(serverId), String(username), String(password)),
        clear: (serverId) => ipcRenderer.invoke('weave:credentials.clear', String(serverId)),
    },

    updates: {
        /** The current state, for a renderer that mounted after the check began. */
        state: () => ipcRenderer.invoke('weave:update.state'),
        /** Restart into the downloaded version. Refused unless one is actually ready. */
        install: () => ipcRenderer.invoke('weave:update.install'),
        /**
         * Subscribe to progress. Returns an unsubscribe function.
         *
         * The listener is wrapped so the Electron event object never reaches the page —
         * it carries a `sender` handle to the very thing this file exists to isolate.
         */
        onChange(handler) {
            if (typeof handler !== 'function') return () => {};
            const wrapped = (_event, payload) => handler(payload);
            ipcRenderer.on('weave:update', wrapped);
            return () => ipcRenderer.removeListener('weave:update', wrapped);
        },
    },

    share: {
        available: true,
        onPick: (cb) => {
            ipcRenderer.on('weave:share-pick', (_event, payload) => cb(payload));
        },
        answer: (nonce, choice) => {
            // The nonce scopes the reply to one request; a stale picker cannot answer a
            // newer one.
            ipcRenderer.send(`weave:share-answer:${String(nonce)}`, choice ?? {});
        },
    },

    links: {
        available: true,
        onDeepLink: (cb) => {
            ipcRenderer.on('weave:deep-link', (_event, url) => cb(String(url ?? '')));
        },
    },

    diagnostics: {
        /** The updater log, already redacted in the main process. */
        read: () => ipcRenderer.invoke('weave:diagnostics.read'),
        openFolder: () => ipcRenderer.invoke('weave:app.openLogFolder'),
    },

    app: {
        info: () => ipcRenderer.invoke('weave:app.info'),
    },

    /** Renderer lines land in the same file as the main process's, in order. */
    log: (level, message, meta) => {
        const allowed = ['error', 'warn', 'info', 'debug'];
        ipcRenderer.send('weave:log', allowed.includes(level) ? level : 'info', String(message), meta);
    },
});

// A guard rather than a comment: if a future edit exposes something outside the agreed
// channels, this is where it shows up.
Object.freeze(PUSH);
