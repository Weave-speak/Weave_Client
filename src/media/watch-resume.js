// Which watches to re-arm after a reconnection that could not be resumed.
//
// Video is opt-in: a screen or a camera is a placeholder tile until the person clicks
// Watch, and that choice is remembered as a connection id. Which is exactly why it does
// not survive a reconnection — every cid in the room is new, including our own, so the
// remembered keys name people who no longer exist and the tiles all fall back to
// placeholders. A viewer's screen went blank on somebody ELSE's network blip.
//
// The choice was never really about a connection, though. "I want to see what Chris is
// showing" is about the account, so that is what is remembered across the gap, and the
// keys are rebuilt against whoever is actually in the room now. Only where that account
// is still showing that slot: re-arming a watch on a share that ended in the meantime
// would consume a producer nobody is sending.
//
// Pure, and therefore tested without a browser, a socket or a mediasoup device.

/**
 * Slots the watch switch governs, as its OWN key.
 *
 * A screen's system audio deliberately has no entry of its own: it rides its screen's
 * choice, so restoring the screen restores the sound with it.
 */
const WATCHABLE = new Set(['screen', 'webcam']);

/**
 * @param {object}   options
 * @param {string[]} options.watched   remembered choices, as 'userId:slot'
 * @param {object[]} options.peers     the roster from the joined frame
 * @param {string?}  options.channelId only re-arm inside this room; null means anywhere
 * @returns {{cid: string, slot: string, userId: string}[]}
 */
export function watchesToRestore({ watched = [], peers = [], channelId = null } = {}) {
    const wanted = new Set(watched);
    if (!wanted.size) return [];

    const restore = [];
    for (const peer of peers) {
        if (!peer?.cid || !peer?.userId) continue;
        if (channelId !== null && peer.channelId !== channelId) continue;
        for (const producer of peer.producers ?? []) {
            const slot = producer?.slot;
            if (!WATCHABLE.has(slot)) continue;
            if (!wanted.has(`${peer.userId}:${slot}`)) continue;
            restore.push({ cid: peer.cid, slot, userId: peer.userId });
        }
    }
    return restore;
}
