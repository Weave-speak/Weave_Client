// Mention autocomplete.
//
// Typing "@" in the composer offers the people it could mean, because nobody should have
// to remember exact spelling to address someone standing right there. The pieces here are
// pure — where the token starts, who matches, what inserting does to the text — so the
// whole behaviour is testable without a DOM. The popover itself is wired in index.js.

/** Usernames are at most this long, so a "query" past it is just a sentence with an @ in it. */
const MAX_QUERY = 32;

/**
 * The @-token under the caret, if the caret is in one.
 *
 * An @ counts only at the start of a word — "einstein@example" is an email address, not two
 * mentions. The query runs from the @ to the caret and must not contain whitespace; the
 * moment a space is typed the token is finished and the offer withdraws.
 */
export function mentionQuery(text, caret) {
    const upTo = String(text ?? '').slice(0, caret ?? 0);
    const at = upTo.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && !/\s/.test(upTo[at - 1])) return null;

    const query = upTo.slice(at + 1);
    if (query.length > MAX_QUERY || /\s/.test(query)) return null;
    return { start: at, query };
}

/**
 * Who the query could mean, most likely first.
 *
 * Prefix matches beat substring matches; within a rank, the people in THIS room come
 * first, then anyone online, then everyone else — the person you are addressing is
 * usually the person in front of you.
 */
export function matchMentions(query, people = [], { roomId = null, exclude = null, limit = 6 } = {}) {
    const q = String(query ?? '').toLowerCase();

    const rank = (person) => {
        const names = [person.username, person.displayName].filter(Boolean).map((n) => String(n).toLowerCase());
        if (!q) return names.length ? 2 : -1;
        let best = -1;
        for (const name of names) {
            if (name.startsWith(q)) return 0;
            if (name.includes(q)) best = 2;
        }
        return best;
    };

    const presenceOrder = { live: 0, away: 1, offline: 2 };

    return people
        .filter((p) => p.username && p.username !== exclude)
        .map((p) => ({ p, r: rank(p) }))
        .filter(({ r }) => r >= 0)
        .sort((a, b) =>
            (a.r - b.r)
            || ((a.p.roomId === roomId ? 0 : 1) - (b.p.roomId === roomId ? 0 : 1))
            || ((presenceOrder[a.p.presence] ?? 2) - (presenceOrder[b.p.presence] ?? 2))
            || String(a.p.username).localeCompare(String(b.p.username)))
        .slice(0, limit)
        .map(({ p }) => p);
}

/** Replace the @-token with the chosen mention, and say where the caret lands. */
export function insertMention(text, start, caret, username) {
    const before = String(text ?? '').slice(0, start);
    const after = String(text ?? '').slice(caret);
    const mention = `@${username} `;
    return { text: before + mention + after, caret: (before + mention).length };
}
