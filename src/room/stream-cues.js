// When a stream starting or stopping deserves a sound.
//
// The web app plays one on every video producer that appears in your room and on every
// deliberate stop. The stop half ports directly: the server marks a deliberate stop with
// `stopped: true` (a disconnect, a transport teardown and a replaced share do not carry it),
// so a network blip never sounds like somebody ending their stream.
//
// The start half needs more care than the web app gives it, because `producer_new` does not
// only mean "somebody started streaming":
//   - a cross-worker move tears the mover's media down and they RE-PRODUCE in the new room,
//     so their running share arrives there as a fresh producer_new;
//   - a reconnect does the same under a new cid, after the old producer closed unannounced;
//   - you arriving in a room is when you learn of everything in it.
// None of those is a stream starting, and a chime on each would teach people to ignore it.
// So a start is quiet when the person (or you) only just arrived, or when the same person's
// same slot went away without a deliberate stop moments ago.
//
// Pure, with the clock injected: the room asks, this answers, and the tests need no browser.

/** The slots that are a stream someone watches. Voice and a screen's audio are not. */
const VIDEO_SLOTS = new Set(['screen', 'webcam']);

/** Arriving re-produces within a second or two; ten is generous without hiding real starts. */
export const ARRIVAL_GRACE_MS = 10_000;

/** A share coming back after an unannounced close: a reconnect can take a while. */
export const RESUME_GRACE_MS = 60_000;

/**
 * @param {{ now?: () => number }} [options]
 * @returns {{ observe(msg: object, ctx: {
 *     peer?: object|null, currentChannelId?: string|null, selfUserId?: string|null,
 * }): 'start'|'end'|null }}
 *
 * `peer` is the roster's entry for msg.cid (or msg.peer.cid) BEFORE the frame is applied —
 * which is why the room calls this ahead of state.apply.
 */
export function createStreamCues({ now = () => Date.now() } = {}) {
    // producerIds already sounded (or deliberately not): the server re-announces.
    const seen = new Set();
    // cid -> when that connection arrived in your room.
    const arrivedAt = new Map();
    // `${userId}:${slot}` -> when it closed WITHOUT a deliberate stop.
    const droppedAt = new Map();
    let selfArrivedAt = -Infinity;

    const within = (at, grace) => at !== undefined && now() - at < grace;

    return {
        observe(msg, { peer = null, currentChannelId = null, selfUserId = null } = {}) {
            switch (msg?.type) {
                case 'joined':
                case 'moved':
                    selfArrivedAt = now();
                    arrivedAt.clear();
                    return null;

                case 'peer_joined': {
                    // An upsert, not only an arrival: status changes and leaving a room come
                    // this way too. Only stepping INTO your room counts.
                    const next = msg.peer;
                    if (next?.cid && next.channelId && next.channelId === currentChannelId
                        && peer?.channelId !== next.channelId) arrivedAt.set(next.cid, now());
                    return null;
                }

                case 'peer_left': {
                    // A connection that went with a stream running may come straight back
                    // under a new cid and re-produce it — the same as an unannounced close.
                    if (!peer?.userId) return null;
                    for (const producer of peer.producers ?? []) {
                        if (VIDEO_SLOTS.has(producer.slot)) droppedAt.set(`${peer.userId}:${producer.slot}`, now());
                    }
                    return null;
                }

                case 'producer_closed': {
                    if (!VIDEO_SLOTS.has(msg.slot) || !peer) return null;
                    if (!msg.stopped && !msg.replaced && peer.userId) {
                        droppedAt.set(`${peer.userId}:${msg.slot}`, now());
                    }
                    if (!msg.stopped) return null;
                    if (peer.channelId !== currentChannelId) return null;
                    if (selfUserId && peer.userId === selfUserId) return null;
                    return 'end';
                }

                case 'producer_new': {
                    if (!VIDEO_SLOTS.has(msg.slot) || !peer) return null;
                    const id = msg.producerId ?? msg.id;
                    if (id) {
                        if (seen.has(id)) return null;
                        seen.add(id);
                    }
                    if (peer.channelId !== currentChannelId) return null;
                    if (selfUserId && peer.userId === selfUserId) return null;
                    if (within(selfArrivedAt, ARRIVAL_GRACE_MS)) return null;
                    if (within(arrivedAt.get(peer.cid ?? msg.cid), ARRIVAL_GRACE_MS)) return null;
                    const dropKey = `${peer.userId}:${msg.slot}`;
                    const dropped = droppedAt.get(dropKey);
                    droppedAt.delete(dropKey);
                    if (within(dropped, RESUME_GRACE_MS)) return null;
                    return 'start';
                }

                default:
                    return null;
            }
        },
    };
}
