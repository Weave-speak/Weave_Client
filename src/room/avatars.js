// Turning an avatar id into something an <img> can actually show.
//
// The pictures are behind the session like everything else on a Weave server, and an
// <img src> cannot carry an Authorization header — so a URL straight to /api/avatars/:id
// renders as a broken image and nothing says why. The bytes have to be fetched with the
// token and handed to the DOM as an object URL instead.
//
// Which makes this a cache by necessity rather than as an optimisation: the roster
// repaints on every presence change, and re-fetching everybody's face each time would be
// a request per person per repaint. An id names immutable bytes — the server generates a
// new one for every upload and never reuses it — so anything fetched once is good forever.

/**
 * @param {object}   api        the client for this server
 * @param {Function} onResolved called when a face arrives, so the caller can repaint
 */
export function createAvatarCache({ api, onResolved = () => {} }) {
    const urls = new Map();      // avatar id -> object URL
    const pending = new Set();   // ids being fetched right now
    // Ids that failed. Kept so a missing picture costs one request rather than one per
    // repaint forever — a 404 is a fact about the id, and the id never changes.
    const failed = new Set();

    function load(id) {
        if (pending.has(id) || failed.has(id) || urls.has(id)) return;
        pending.add(id);
        api.fetchBlob(`/api/avatars/${encodeURIComponent(id)}`)
            .then((blob) => {
                urls.set(id, URL.createObjectURL(blob));
                onResolved();
            })
            .catch(() => { failed.add(id); })
            .finally(() => pending.delete(id));
    }

    return {
        /**
         * The URL for this id, or null while it is still coming.
         *
         * Null is not a failure and must not be rendered as one: the initials are the
         * placeholder, so a face simply appears when it arrives rather than replacing a
         * spinner or a broken-image glyph.
         */
        urlFor(id) {
            if (!id) return null;
            const known = urls.get(id);
            if (known) return known;
            load(id);
            return null;
        },

        /** Forget one id, so the next look-up re-fetches. For a picture just replaced. */
        forget(id) {
            const url = urls.get(id);
            if (url) URL.revokeObjectURL(url);
            urls.delete(id);
            failed.delete(id);
        },

        /** Every object URL is a live reference to bytes; dropping the cache must free them. */
        destroy() {
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
            failed.clear();
        },

        get size() { return urls.size; },
    };
}

/**
 * Fold resolved picture URLs into a list of people.
 *
 * Kept out of the views, which are pure functions of state and must never fetch. The
 * resolution happens here, and a view only ever sees a URL that is already good.
 */
export const withAvatars = (people = [], cache) =>
    people.map((p) => (p.avatar ? { ...p, avatarUrl: cache.urlFor(p.avatar) } : p));
