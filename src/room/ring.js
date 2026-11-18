// Calls ringing in, and going out.
//
// Two servers' worth of frames ring: a private call (dm:ring) and a private huddle starting
// (private-channels:ring). On a phone the same ring can also arrive as a push while the app
// is closed, which the native side handles itself (IncomingCall.kt). Everything here turns
// those frames into one shape and keeps track of which rings are live, so that the ring is
// stopped by whatever ends it — answered here, answered on another device, declined, the
// caller giving up, the time running out — and never twice.
//
// Pure, so every one of those endings is tested without a socket.

/** How long a ring lasts when the server does not say: the server's own RING_MS. */
export const RING_MS = 45_000;

/**
 * The call id a frame names. A server before 0.1.43 sent no callId, and a thread has only
 * one call at a time, so the thread stands in for it there.
 */
export function callIdOf(msg = {}) {
    if (msg.callId) return String(msg.callId);
    if (msg.threadId) return `dm:${msg.threadId}`;
    return null;
}

const nameOf = (person) => person?.displayName || person?.username || 'Someone';

/**
 * A ringing frame as a ring, or null for anything else.
 *
 * @param {object} msg       the frame
 * @param {number} now       for a ring whose server did not say when it ends
 * @param {(id: string) => string|null} roomName  a huddle's name, when the frame lacks it
 */
export function ringFromFrame(msg = {}, now = Date.now(), roomName = () => null) {
    if (msg.type === 'dm:ring') {
        return {
            callId: callIdOf(msg),
            kind: 'dm',
            threadId: msg.threadId ?? null,
            channelId: null,
            title: nameOf(msg.from),
            subtitle: 'is calling you',
            expiresAt: Number(msg.expiresAt) || now + RING_MS,
        };
    }
    if (msg.type === 'private-channels:ring' && msg.callId && msg.channelId) {
        const name = msg.name || roomName(msg.channelId) || 'a private room';
        return {
            callId: String(msg.callId),
            kind: 'huddle',
            threadId: null,
            channelId: msg.channelId,
            title: name,
            subtitle: `${nameOf(msg.from)} started a huddle`,
            expiresAt: Number(msg.expiresAt) || now + (Number(msg.ringMs) || RING_MS),
        };
    }
    return null;
}

/**
 * Which live rings a frame ends: a call answered (here or on another device), declined,
 * given up on, or a huddle ring cancelled. A ring is matched by its id, or by the thread it
 * belongs to when the frame (from an older server) names only that.
 *
 * @param {object} msg
 * @param {Iterable<object>} rings  the live rings
 * @returns {string[]} their call ids
 */
export function ringsEndedBy(msg = {}, rings = []) {
    const ends = ['dm:call_live', 'dm:call_ended', 'private-channels:ring_cancel'];
    if (!ends.includes(msg.type)) return [];
    const out = [];
    for (const ring of rings) {
        if (msg.callId && ring.callId === msg.callId) out.push(ring.callId);
        else if (!msg.callId && msg.threadId && ring.threadId === msg.threadId) out.push(ring.callId);
    }
    return out;
}

/**
 * What answering a ring sends, or declining it. Answering a huddle is simply walking into it,
 * which is also how the server knows the ring for you is over.
 */
export function answerFrame(ring) {
    if (ring?.kind === 'dm') return ['dm:accept', { threadId: ring.threadId, ...(isRealId(ring) ? { callId: ring.callId } : {}) }];
    if (ring?.kind === 'huddle') return ['move', { channelId: ring.channelId }];
    return null;
}

export function declineFrame(ring) {
    if (ring?.kind === 'dm') return ['dm:decline', { threadId: ring.threadId, ...(isRealId(ring) ? { callId: ring.callId } : {}) }];
    if (ring?.kind === 'huddle') return ['private-channels:decline', { channelId: ring.channelId, callId: ring.callId }];
    return null;
}

/** A server id, rather than the thread standing in for one (see callIdOf). */
const isRealId = (ring) => !String(ring.callId).startsWith('dm:');

/**
 * Whether a call is happening on THIS device, or on another one signed in as the same person.
 *
 * One account can be open on a phone and a computer at once, and the server tells every one
 * of them about every call the account is party to: all of them ring, and all of them hear
 * that the call went live or ended. Only the device that placed the call or answered it is in
 * it. The others must stop ringing, must not believe they are in a call (and offer to end
 * one they are not in), and must not announce "Call declined." to the person who has just
 * declined it on their phone. They may offer to take the call over instead.
 *
 * A device standing in a call room is in that call even when it has forgotten which one — a
 * page reloaded mid-call rejoins the room with no thread in mind — so the end of a call still
 * walks it back out.
 *
 * @param {object} msg  dm:call_live or dm:call_ended
 * @param {{ activeThreadId?: string|null, inCallRoom?: boolean }} here
 *   the call this device placed or answered, and whether it stands in a call room now
 * @returns {'here'|'elsewhere'|null} null for any other frame
 */
export function callPlace(msg = {}, { activeThreadId = null, inCallRoom = false } = {}) {
    if (msg.type !== 'dm:call_live' && msg.type !== 'dm:call_ended') return null;
    if (msg.threadId && activeThreadId === msg.threadId) return 'here';
    if (msg.type === 'dm:call_ended' && inCallRoom && !activeThreadId) return 'here';
    return 'elsewhere';
}

/**
 * Whether a call you placed has been settled, and how. Ringback plays until it is.
 *
 * @param {object} msg
 * @param {string|null} threadId  the thread you are calling
 * @returns {null | 'live' | 'declined' | 'no_answer' | 'ended'}
 */
export function outgoingOutcome(msg = {}, threadId = null) {
    if (!threadId || msg.threadId !== threadId) return null;
    if (msg.type === 'dm:call_live') return 'live';
    if (msg.type === 'dm:call_ended') {
        return msg.reason === 'declined' || msg.reason === 'no_answer' ? msg.reason : 'ended';
    }
    return null;
}
