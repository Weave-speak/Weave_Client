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
 * How long a timeline may get before its oldest end is let go, and what is kept.
 *
 * Paging only ever ADDED: a room somebody sat in for a week held every message of that week,
 * and every one of them was a row in the DOM, re-laid-out on each arrival. Nothing is lost
 * by letting the top go — it is exactly what scrolling up fetches — so past the first figure
 * the list is cut back to the second. The gap between them is there so that it happens once
 * every couple of hundred messages rather than on every one.
 */
export const TRIM_ABOVE = 400;
export const TRIM_KEEP = 200;

/**
 * Whether a channel's held messages should be cut back now.
 *
 * Never while its reader is scrolled up — the rows that would go are the ones they are
 * reading, or about to — and never while an older page is in flight, whose reply would land
 * on a list that no longer reaches back to meet it. A channel nobody is looking at has no
 * reader to disturb.
 */
export function shouldTrim({ length = 0, onScreen = false, atBottom = false, busy = false } = {}) {
    if (busy || length <= TRIM_ABOVE) return false;
    return !onScreen || atBottom;
}

/**
 * Point the paging cursor at the oldest message still held, after a trim.
 *
 * Without this the cursor still names the oldest message EVER fetched, so scrolling up
 * would ask for the page before that one and leave a hole where the trimmed rows were. And
 * `done` has to be cleared for the same reason it latches: the beginning of the room is no
 * longer what is on screen.
 */
export function rewindHistory(entry, oldest) {
    if (!oldest || oldest.createdAt == null || oldest.id == null) return entry ?? freshHistory();
    return {
        ...(entry ?? freshHistory()),
        nextBefore: oldest.createdAt,
        nextBeforeId: oldest.id,
        done: false,
    };
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
