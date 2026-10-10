// Which consumers to keep, which to let go, and which to ask for.
//
// Two failures from the same long evening, both on listeners whose links had blipped:
//
//   - One person went inaudible to two listeners for over ten minutes while everyone
//     else heard them. The server re-announced the producer every five seconds and the
//     two clients never asked for it, because each still held a consumer of that person's
//     PREVIOUS producer. A producer closed on the server is invisible to mediasoup-client,
//     so that consumer reported itself open, and every check here was keyed on cid and
//     slot — "we already have their audio" — and never on which producer it belonged to.
//     Only the speaker restarting, which bought them a new cid, got past it.
//
//   - One voice turned to a tin can for one listener. Two consumers of the same producer
//     play the same audio through two jitter buffers a few milliseconds apart, which is a
//     comb filter. They came from two asks landing inside one round trip: the duplicate
//     check only sees consumers that have finished being built.
//
// So a consumer is judged by its PRODUCER wherever the caller knows it, and an ask that is
// already on its way is shared rather than repeated. Pure, so both are tested without a
// browser, a socket or a mediasoup device.

/**
 * The streams a peer list says should be playing, keyed 'cid:slot'.
 *
 * `producerId` is null where the list does not say — an older frame, or a ragged roster —
 * and null never counts as a mismatch anywhere below.
 *
 * @param {object[]} peers  [{ cid, producers: [{ slot, id }] }]
 * @returns {Map<string, {cid: string, slot: string, producerId: string|null}>}
 */
export function wantedStreams(peers = []) {
    const want = new Map();
    for (const peer of peers ?? []) {
        if (!peer?.cid) continue;
        for (const producer of peer.producers ?? []) {
            if (!producer?.slot) continue;
            want.set(`${peer.cid}:${producer.slot}`, {
                cid: peer.cid,
                slot: producer.slot,
                producerId: producer.id ?? null,
            });
        }
    }
    return want;
}

/**
 * Whether to ask for a stream, given the consumers already held for it.
 *
 * A closed consumer is cleared away rather than counted. One whose producer is not the
 * producer being announced is cleared away too: the server keeps one producer per slot and
 * closes the old one when it is replaced, so a consumer of any other producer is already
 * dead there, whatever it says here. Anything left standing is a live duplicate, and
 * asking again would be the second copy of a voice.
 *
 * @param {Array<{id: string, producerId: string|null, closed: boolean}>} entries
 *   the consumers held for ONE cid:slot, oldest first
 * @param {string|null} producerId  the producer being announced, where the frame said
 * @returns {{skip: boolean, drop: Array<{id: string, reason: 'closed'|'stale', producerId: string|null}>}}
 */
export function consumeVerdict(entries = [], producerId = null) {
    const drop = [];
    let live = false;
    for (const entry of entries ?? []) {
        if (!entry?.id) continue;
        if (entry.closed) {
            drop.push({ id: entry.id, reason: 'closed', producerId: entry.producerId ?? null });
            continue;
        }
        if (producerId && entry.producerId && entry.producerId !== producerId) {
            drop.push({ id: entry.id, reason: 'stale', producerId: entry.producerId });
            continue;
        }
        live = true;
    }
    return { skip: live, drop };
}

/**
 * Reconcile the consumers held against what a peer list says should be playing.
 *
 * `authoritative` says whether the list's producer ids are the SERVER's current memory —
 * the pong's truth, a join's snapshot — or the client's own roster, which can lag a frame
 * it never saw. Only the former may call a consumer stale: acting on a lagging roster
 * would drop a perfectly good consumer, re-make it, and drop it again on the next beat.
 *
 * Duplicates collapse to the newest, because the server always consumes its CURRENT
 * producer, so the most recent answer is never the older one. A duplicate of the same
 * producer is still forwarding on the server and is closed there too; one of a superseded
 * producer is already gone there, and saying so would only earn an error frame.
 *
 * @param {object}  options
 * @param {Array<{id, cid, slot, producerId, closed}>} options.entries  every consumer held, oldest first
 * @param {Map}     options.want  from wantedStreams()
 * @param {boolean} options.authoritative
 * @returns {{
 *   drop: Array<{id: string, key: string, reason: 'closed'|'gone'|'stale'|'duplicate', closeOnServer: boolean}>,
 *   consume: Array<{cid: string, slot: string, producerId: string|null}>,
 * }}
 */
export function reconcileConsumers({ entries = [], want = new Map(), authoritative = false } = {}) {
    const drop = [];
    const standing = new Map();   // key -> entries still standing, oldest first

    for (const entry of entries ?? []) {
        if (!entry?.id) continue;
        const key = `${entry.cid}:${entry.slot}`;
        const wanted = want.get(key);
        if (entry.closed) {
            drop.push({ id: entry.id, key, reason: 'closed', closeOnServer: false });
            continue;
        }
        if (!wanted) {
            drop.push({ id: entry.id, key, reason: 'gone', closeOnServer: false });
            continue;
        }
        if (authoritative && wanted.producerId && entry.producerId
            && entry.producerId !== wanted.producerId) {
            drop.push({ id: entry.id, key, reason: 'stale', closeOnServer: false });
            continue;
        }
        if (!standing.has(key)) standing.set(key, []);
        standing.get(key).push(entry);
    }

    for (const [key, held] of standing) {
        if (held.length < 2) continue;
        const keep = held.at(-1);
        for (const entry of held.slice(0, -1)) {
            const same = entry.producerId === keep.producerId;
            drop.push({ id: entry.id, key, reason: same ? 'duplicate' : 'stale', closeOnServer: same });
        }
    }

    const consume = [];
    for (const [key, stream] of want) {
        if (standing.has(key)) continue;
        consume.push({ cid: stream.cid, slot: stream.slot, producerId: stream.producerId });
    }
    return { drop, consume };
}

/**
 * One request per key in flight, shared by everyone who asks while it is.
 *
 * The shape ensureTransport() already uses for transports, for the same reason: a check
 * that reads state the request has not written yet lets every concurrent caller through.
 *
 * `tag` is what the caller is asking FOR — for a consume, the producer it was told about.
 * A caller with no tag, or the same one, shares the request in flight. A caller with a
 * DIFFERENT tag knows something newer than the request does, so it waits for that request
 * to land and then asks again, when the guard can see the result and replace it.
 *
 * reset() forgets everything in flight and moves the generation on. A request that began
 * before a teardown is then never waited on by anything after it, and its own code can
 * compare generations to see that its answer belongs to a path that no longer exists.
 */
export function createFlights() {
    const flying = new Map();   // key -> { tag, promise }
    let generation = 0;

    function run(key, tag, start) {
        const current = flying.get(key);
        if (current) {
            if (tag == null || current.tag == null || current.tag === tag) return current.promise;
            const again = () => run(key, tag, start);
            return current.promise.then(again, again);
        }
        const promise = Promise.resolve().then(start).finally(() => {
            if (flying.get(key)?.promise === promise) flying.delete(key);
        });
        flying.set(key, { tag, promise });
        return promise;
    }

    return {
        run,
        reset() {
            flying.clear();
            generation += 1;
        },
        get generation() { return generation; },
        get size() { return flying.size; },
    };
}
