// Turning stored messages into a timeline.
//
// The server stores what was said and when. Everything else a reader needs — which day it
// was, whose message it is, whether it names you — is worked out here, once, rather than at
// render time. Pure, so the awkward cases can be tested without a clock or a DOM.

/** Local midnight for a timestamp, as the key days are grouped by. */
const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * How a day reads to a person.
 *
 * "Yesterday" beats a date, and a weekday beats a date for the last week — but only up to a
 * point, because "Tuesday" three weeks ago is worse than useless.
 */
export function dayLabel(ms, now = Date.now()) {
    const then = new Date(ms);
    const today = new Date(now);
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const daysAgo = Math.floor((midnight - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);

    if (daysAgo <= 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo < 7) return then.toLocaleDateString(undefined, { weekday: 'long' });
    if (then.getFullYear() === today.getFullYear()) {
        return then.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    }
    return then.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

const clockTime = (ms) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Which names in this text are real mentions of someone on this server.
 *
 * Resolved against the roster rather than trusted from the text, so nobody can fake being
 * mentioned — or fake mentioning you — just by typing an @.
 */
export function resolveMentions(body, usernames) {
    const known = new Set([...usernames].map((u) => String(u).toLowerCase()));
    const found = new Set();
    for (const [, name] of String(body ?? '').matchAll(/@([A-Za-z0-9._-]{1,32})/g)) {
        if (known.has(name.toLowerCase())) found.add(name);
    }
    return [...found];
}

/**
 * Records to timeline items, with day separators inserted.
 *
 * Sorted by (createdAt, id). The timestamp alone is not a total order — two messages can
 * share a millisecond, and when they do an unstable sort makes them swap places on every
 * re-render, which looks like the conversation rewriting itself.
 */
export function toTimelineItems(records = [], { users = new Map(), me = null, now = Date.now() } = {}) {
    const usernames = [...users.values()].map((u) => u.username);
    const sorted = [...records].sort((a, b) =>
        (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));

    const items = [];
    let lastDay = null;

    for (const record of sorted) {
        const day = dayKey(record.createdAt);
        if (day !== lastDay) {
            items.push({ kind: 'day', id: `day-${day}`, label: dayLabel(record.createdAt, now) });
            lastDay = day;
        }

        // A locally minted system line ("Alex started streaming") is already an item;
        // it needs the day separator logic above but none of the message shaping below.
        if (record.kind === 'system') {
            items.push({ ...record, at: clockTime(record.createdAt) });
            continue;
        }

        const author = users.get(record.userId);
        const mentions = resolveMentions(record.body, usernames);

        items.push({
            kind: 'message',
            id: record.id,
            at: clockTime(record.createdAt),
            author: author ?? {
                // Someone who has left the server still wrote what they wrote. The stored
                // author name is the only record of who that was.
                username: record.authorName ?? 'unknown',
                displayName: record.authorName ?? 'Unknown',
            },
            text: record.body,
            mentions,
            mentionsMe: Boolean(me?.username)
                && mentions.some((m) => m.toLowerCase() === me.username.toLowerCase()),
        });
    }

    return items;
}
