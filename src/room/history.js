// Paging back through history.
//
// The pattern every serious chat client uses — Discord pages by snowflake id, Telegram by
// message id, WhatsApp reads local storage in slices — is the same idea: fetch the newest
// page, then follow a CURSOR backwards as the reader scrolls, never an OFFSET. An offset
// shifts under you as new messages arrive, repeating some and skipping others.
//
// Our cursor is (createdAt, id): the timestamp is the marker, the id breaks ties, because
// two messages in the same millisecond are routine and a bare-timestamp cursor silently
// loses one of them. The server owns that guarantee; this module owns the client's
// bookkeeping — what to ask for next, and when to stop asking.

/** One page. About three screens of a large window, so a scroll-up rarely waits twice. */
export const PAGE_SIZE = 50;

/** How close to the top, in pixels, counts as "about to need more". */
export const TOP_THRESHOLD_PX = 240;

/** A fresh channel: nothing fetched, everything still to ask for. */
export const freshHistory = () => ({ nextBefore: null, nextBeforeId: null, done: false, busy: false });

/**
 * Fold a server response into the bookkeeping.
 *
 * The server sends `nextBefore`/`nextBeforeId` only when a full page came back; nulls mean
 * the well is dry. `done` latches — a channel that reported its beginning stays reported.
 */
export function advanceHistory(entry, { nextBefore = null, nextBeforeId = null } = {}) {
    const done = nextBefore == null || nextBeforeId == null;
    return {
        ...entry,
        busy: false,
        nextBefore: done ? entry.nextBefore : nextBefore,
        nextBeforeId: done ? entry.nextBeforeId : nextBeforeId,
        done: entry.done || done,
    };
}

/** The query string for the next page, oldest-known-message backwards. */
export function nextPageQuery(entry, limit = PAGE_SIZE) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (entry?.nextBefore != null) {
        params.set('before', String(entry.nextBefore));
        params.set('beforeId', String(entry.nextBeforeId));
    }
    return params.toString();
}

/** Whether a scroll position warrants fetching the page before this one. */
export function shouldLoadOlder(entry, scrollTop) {
    if (!entry || entry.busy || entry.done) return false;
    if (entry.nextBefore == null) return false;   // no cursor yet: the first page is not in
    return scrollTop < TOP_THRESHOLD_PX;
}

/**
 * Older messages joining what is already held, deduplicated.
 *
 * Duplicates are not hypothetical: the page boundary can overlap a message that also
 * arrived live over the socket. The id decides; first sighting wins.
 */
export function mergeOlder(existing = [], older = []) {
    const seen = new Set(existing.map((m) => m.id));
    return [...older.filter((m) => !seen.has(m.id)), ...existing];
}
