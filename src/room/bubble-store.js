// What the client knows about bubbles: which exist, which are floating, which have
// something you have not read, and the conversations it has fetched.
//
// A reducer over the server's frames, pure, so the throb — the one piece of state a person
// actually reads off a bubble — can be tested without a socket. The server is the authority
// on unread (it keeps read markers per account, across devices); this only keeps the
// screen in step between fetches.

export function emptyBubbles() {
    return {
        bubbles: new Map(),      // id -> { id, name, photo, createdAt, lastMessageAt, unread }
        active: [],              // ids floating right now, as the server chose them
        messages: new Map(),     // id -> records, oldest first; only for bubbles opened
    };
}

/** The list the server sends from GET /api/bubbles. Replaces everything but loaded chats. */
export function loadBubbles(state, { bubbles = [], active = [] } = {}) {
    const known = new Set(bubbles.map((b) => b.id));
    return {
        ...state,
        bubbles: new Map(bubbles.map((b) => [b.id, { ...b, unread: Boolean(b.unread) }])),
        active: active.filter((id) => known.has(id)),
        messages: new Map([...state.messages].filter(([id]) => known.has(id))),
    };
}

/**
 * Apply one `bubbles:*` frame. `meId` decides whether a new message is news; `openId` is
 * the bubble whose conversation is on screen, which is read the moment it arrives.
 */
export function applyBubbleFrame(state, frame, { meId = null, openId = null } = {}) {
    switch (frame?.type) {
        case 'bubbles:created': {
            const b = frame.bubble;
            if (!b?.id) return state;
            const bubbles = new Map(state.bubbles);
            bubbles.set(b.id, { ...b, unread: false });
            return { ...state, bubbles };
        }
        case 'bubbles:deleted': {
            if (!state.bubbles.has(frame.id)) return state;
            const bubbles = new Map(state.bubbles);
            bubbles.delete(frame.id);
            const messages = new Map(state.messages);
            messages.delete(frame.id);
            return { ...state, bubbles, messages, active: state.active.filter((id) => id !== frame.id) };
        }
        case 'bubbles:cleared': {
            const b = state.bubbles.get(frame.id);
            if (!b) return state;
            const bubbles = new Map(state.bubbles);
            bubbles.set(frame.id, { ...b, unread: false, lastMessageAt: null });
            const messages = new Map(state.messages);
            if (messages.has(frame.id)) messages.set(frame.id, []);
            return { ...state, bubbles, messages };
        }
        case 'bubbles:active':
            return { ...state, active: (frame.ids ?? []).filter((id) => state.bubbles.has(id)) };
        case 'bubbles:message': {
            const m = frame.message;
            const b = m && state.bubbles.get(m.bubbleId);
            if (!b) return state;
            const bubbles = new Map(state.bubbles);
            const news = m.userId !== meId && m.bubbleId !== openId;
            bubbles.set(b.id, { ...b, lastMessageAt: m.createdAt, unread: b.unread || news });
            const messages = new Map(state.messages);
            const list = messages.get(b.id);
            // Only a conversation already fetched is extended; one never opened is fetched
            // whole when it is, and a lone message would masquerade as its history.
            if (list && !list.some((x) => x.id === m.id)) messages.set(b.id, [...list, m]);
            return { ...state, bubbles, messages };
        }
        default:
            return state;
    }
}

/** A conversation fetched for the first time, or again. */
export function setBubbleMessages(state, id, records = []) {
    const messages = new Map(state.messages);
    messages.set(id, records);
    return { ...state, messages };
}

/** Opening a bubble reads it. */
export function markBubbleRead(state, id) {
    const b = state.bubbles.get(id);
    if (!b || !b.unread) return state;
    const bubbles = new Map(state.bubbles);
    bubbles.set(id, { ...b, unread: false });
    return { ...state, bubbles };
}

/** Whether anything at all is waiting, for the badge on the way into the list. */
export const anyUnread = (state) => [...state.bubbles.values()].some((b) => b.unread);
