// The list of servers this client knows about.
//
// Desktop only. A browser build has exactly one server — the one that served it — so
// there is nothing to store and nothing to choose between.
//
// A server is identified by a generated id rather than by its address, so renaming it or
// moving it to a new hostname does not orphan its settings. The address is data ABOUT the
// server, not its identity.

import { createStorage, platform } from '../platform/index.js';
import { normaliseAddress, displayAddress } from './address.js';

const store = createStorage('servers');
const KEY = 'list';
const ACTIVE = 'active';

const newId = () => (crypto.randomUUID?.() ?? `s${Date.now()}${Math.random().toString(36).slice(2)}`);

export function listServers() {
    const list = store.get(KEY, []);
    return Array.isArray(list) ? list : [];
}

export function getServer(id) {
    return listServers().find((s) => s.id === id) ?? null;
}

export function activeServer() {
    if (!platform.canChooseServer) {
        // The browser build's single implicit server. Not persisted — it is whatever
        // origin served the page, and inventing a stored record for it would let the two
        // drift apart.
        const origin = platform.defaultOrigin();
        return { id: 'origin', origin, label: displayAddress(origin), implicit: true };
    }
    const id = store.get(ACTIVE, null);
    return getServer(id) ?? listServers()[0] ?? null;
}

function announce() {
    // Anything displaying which server we are on listens for this. Without it the topbar
    // kept whatever it rendered at boot, which on a first run was "no server" forever.
    try { window.dispatchEvent(new CustomEvent("weave:server-changed")); } catch { /* no DOM */ }
}

export function setActive(id) {
    store.set(ACTIVE, id);
    announce();
}

/**
 * Remember a server we have just successfully reached.
 *
 * Takes the discovery result rather than raw input, so nothing is saved until it has been
 * proven to be a Weave server we can talk to. A list full of addresses that have never
 * worked is worse than an empty one.
 */
export function rememberServer({ address, info }, { label = null } = {}) {
    const list = listServers();
    const existing = list.find((s) => s.origin === address.origin);

    const record = {
        id: existing?.id ?? newId(),
        origin: address.origin,
        // The server's own name is the better default: it is what its administrator chose
        // and what everyone else calls it. A custom label only exists to disambiguate two
        // servers that happen to share a name.
        label: label || existing?.label || info?.instance?.name || displayAddress(address.origin),
        lastSeen: {
            name: info?.instance?.name ?? null,
            version: info?.version ?? null,
            protocol: info?.protocol ?? null,
            registration: info?.instance?.registration ?? null,
            features: info?.features ?? [],
        },
        lastUsedAt: Date.now(),
    };

    const next = existing
        ? list.map((s) => (s.id === existing.id ? record : s))
        : [...list, record];

    store.set(KEY, next);
    store.set(ACTIVE, record.id);
    announce();
    return record;
}

export function renameServer(id, label) {
    store.set(KEY, listServers().map((s) => (s.id === id ? { ...s, label: label.trim() || s.label } : s)));
}

/**
 * Forget a server, and everything remembered about it.
 *
 * Its namespaced settings go too. Leaving them behind would mean re-adding a server later
 * silently resurrects preferences the user thought they had removed.
 */
export function forgetServer(id) {
    const next = listServers().filter((s) => s.id !== id);
    store.set(KEY, next);

    if (store.get(ACTIVE) === id) store.set(ACTIVE, next[0]?.id ?? null);
    announce();

    try {
        const prefix = `weave:server:${id}:`;
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(prefix)) localStorage.removeItem(key);
        }
    } catch {
        // Nothing here is worth failing a removal over.
    }
}

/** Per-server settings. This is the namespace that stops two servers colliding. */
export const settingsFor = (id) => createStorage(`server:${id}`);

/** Used by the "add server" form to reject a duplicate before contacting anything. */
export function findByAddress(input) {
    try {
        const { origin } = normaliseAddress(input);
        return listServers().find((s) => s.origin === origin) ?? null;
    } catch {
        return null;
    }
}
