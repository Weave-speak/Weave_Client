// Object URLs for bytes that sit behind the session: pictures in the chat, join sounds.
//
// An <img src> cannot carry an Authorization header, so each of these is fetched with the
// token and handed to the DOM as an object URL — and an object URL is a live reference to
// the whole blob for as long as nobody revokes it. The first version of this was a bare Map
// that never did: every picture anybody scrolled past stayed in memory until the app was
// closed, and signing out did not release them either. On a server where people post
// screenshots that is the app's memory growing by a few megabytes per picture, for ever.
//
// So this is a cache with a budget. What makes it more than an LRU is that a URL cannot be
// revoked just because it is old: a picture still on screen keeps working after its URL is
// revoked, but the lightbox opens by handing that same `src` to a NEW element, which would
// then load nothing. The caller therefore says which URLs are in use, and those are never
// evicted, whatever the budget says. Going over budget is a better failure than a picture
// that will not open.
//
// No DOM and no network in here — the three things it needs are handed in — so the policy
// can be tested as plain values.

/** Enough for a few screens of screenshots; a fraction of what an evening used to hold. */
export const BLOB_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {(blob: Blob) => string} [opts.create]  URL.createObjectURL, injectable for tests
 * @param {(url: string) => void} [opts.revoke]   URL.revokeObjectURL, likewise
 * @param {(url: string) => boolean} [opts.inUse] whether something on screen still shows it
 */
export function createBlobUrls({
    maxBytes = BLOB_BUDGET_BYTES,
    create = (blob) => URL.createObjectURL(blob),
    revoke = (url) => URL.revokeObjectURL(url),
    inUse = () => false,
} = {}) {
    // key -> { url, bytes }. A Map iterates in insertion order, and get() re-inserts, so the
    // first entry is always the one that has gone longest without being asked for.
    const held = new Map();
    let total = 0;

    /**
     * Back under budget, oldest first. `keep` is the key just inserted: it is about to be
     * handed to an element that `inUse` cannot see yet, and when everything older is on
     * screen it is the only candidate left — revoking it would return a dead URL.
     */
    function evict(keep) {
        if (total <= maxBytes) return;
        for (const [key, entry] of held) {
            if (total <= maxBytes) return;
            if (key === keep || inUse(entry.url)) continue;
            held.delete(key);
            total -= entry.bytes;
            revoke(entry.url);
        }
    }

    return {
        /** The URL held for this key, or undefined. Asking counts as using it. */
        get(key) {
            const entry = held.get(key);
            if (!entry) return undefined;
            held.delete(key);
            held.set(key, entry);
            return entry.url;
        },

        /**
         * Hold these bytes under this key and return their URL.
         *
         * Two fetches for one key can both land — the same picture in the timeline and in a
         * bubble's card. The first URL is already in an element, so it stays and the second
         * blob is simply dropped.
         */
        put(key, blob) {
            const known = held.get(key);
            if (known) return known.url;
            const entry = { url: create(blob), bytes: Number(blob?.size) || 0 };
            held.set(key, entry);
            total += entry.bytes;
            evict(key);
            return entry.url;
        },

        /** Release everything. For signing out, when nothing is on screen to break. */
        destroy() {
            for (const entry of held.values()) revoke(entry.url);
            held.clear();
            total = 0;
        },

        get size() { return held.size; },
        get bytes() { return total; },
    };
}
