// Deciding what to consume.
//
// Written against two failures from one evening of reconnects. A speaker stayed inaudible
// to two listeners for ten minutes, because each held a consumer of the speaker's PREVIOUS
// producer and every check was keyed on cid and slot. And a voice turned to a tin can for
// one listener, because two asks landed inside one round trip and both were answered.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    wantedStreams, consumeVerdict, reconcileConsumers, createFlights,
} from '../src/media/consume-plan.js';

const held = (id, cid, slot, producerId, closed = false) => ({ id, cid, slot, producerId, closed });
const room = (...peers) => wantedStreams(peers);
const peer = (cid, producers) => ({ cid, producers: producers.map(([slot, id]) => ({ slot, id })) });

/* ── wantedStreams ───────────────────────────────────────────────────────── */

test('the room says what should be playing, with the producer behind each stream', () => {
    const want = room(peer('SAN', [['audio', 'p-1'], ['screen', 'p-2']]));
    assert.deepEqual([...want.keys()], ['SAN:audio', 'SAN:screen']);
    assert.deepEqual(want.get('SAN:audio'), { cid: 'SAN', slot: 'audio', producerId: 'p-1' });
});

test('a ragged roster cannot throw, and a missing id is unknown rather than wrong', () => {
    const want = wantedStreams([null, {}, { cid: 'A' }, { cid: 'B', producers: [null, { slot: 'audio' }] }]);
    assert.deepEqual([...want.values()], [{ cid: 'B', slot: 'audio', producerId: null }]);
    assert.equal(wantedStreams().size, 0);
});

/* ── consumeVerdict ──────────────────────────────────────────────────────── */

test('nothing held: ask', () => {
    assert.deepEqual(consumeVerdict([], 'p-1'), { skip: false, drop: [] });
});

test('a live consumer of the announced producer is a duplicate, and nothing is asked', () => {
    const verdict = consumeVerdict([held('c1', 'SAN', 'audio', 'p-1')], 'p-1');
    assert.deepEqual(verdict, { skip: true, drop: [] });
});

test('the field case: a consumer of a replaced producer does not block the new one', () => {
    // The listener's client still held this, open as far as mediasoup-client knew, while the
    // server re-announced the new producer every five seconds for ten minutes.
    const verdict = consumeVerdict([held('c-old', 'SAN', 'audio', 'p-old')], 'p-new');
    assert.equal(verdict.skip, false);
    assert.deepEqual(verdict.drop, [{ id: 'c-old', reason: 'stale', producerId: 'p-old' }]);
});

test('an announcement that names no producer never calls anything stale', () => {
    const verdict = consumeVerdict([held('c1', 'SAN', 'audio', 'p-old')], null);
    assert.deepEqual(verdict, { skip: true, drop: [] });
});

test('a closed consumer is cleared away rather than counted', () => {
    const verdict = consumeVerdict([held('c1', 'SAN', 'audio', 'p-1', true)], 'p-1');
    assert.equal(verdict.skip, false);
    assert.deepEqual(verdict.drop.map((d) => [d.id, d.reason]), [['c1', 'closed']]);
});

test('beside a live consumer, a dead one still goes and the live one still stands', () => {
    const verdict = consumeVerdict([
        held('c-dead', 'SAN', 'audio', 'p-1', true),
        held('c-live', 'SAN', 'audio', 'p-1'),
    ], 'p-1');
    assert.equal(verdict.skip, true);
    assert.deepEqual(verdict.drop.map((d) => d.id), ['c-dead']);
});

/* ── reconcileConsumers ──────────────────────────────────────────────────── */

test('what the room has and we do not is asked for, with the producer the room named', () => {
    const plan = reconcileConsumers({ entries: [], want: room(peer('SAN', [['audio', 'p-1']])) });
    assert.deepEqual(plan, { drop: [], consume: [{ cid: 'SAN', slot: 'audio', producerId: 'p-1' }] });
});

test('what we hold and the room no longer has is let go, without troubling the server', () => {
    const plan = reconcileConsumers({ entries: [held('c1', 'GONE', 'audio', 'p-1')], want: room() });
    assert.deepEqual(plan.drop, [{ id: 'c1', key: 'GONE:audio', reason: 'gone', closeOnServer: false }]);
    assert.deepEqual(plan.consume, []);
});

test('a closed consumer no longer counts as having the stream', () => {
    // It used to: the beat saw the key, skipped it, and only a re-announcement could heal it.
    const plan = reconcileConsumers({
        entries: [held('c1', 'SAN', 'audio', 'p-1', true)],
        want: room(peer('SAN', [['audio', 'p-1']])),
    });
    assert.deepEqual(plan.drop.map((d) => d.reason), ['closed']);
    assert.deepEqual(plan.consume, [{ cid: 'SAN', slot: 'audio', producerId: 'p-1' }]);
});

test("the server's truth replaces a consumer of a producer that no longer exists", () => {
    const plan = reconcileConsumers({
        entries: [held('c-old', 'SAN', 'audio', 'p-old')],
        want: room(peer('SAN', [['audio', 'p-new']])),
        authoritative: true,
    });
    assert.deepEqual(plan.drop, [{ id: 'c-old', key: 'SAN:audio', reason: 'stale', closeOnServer: false }]);
    assert.deepEqual(plan.consume, [{ cid: 'SAN', slot: 'audio', producerId: 'p-new' }]);
});

test('the roster beat never acts on a producer id, so a lagging roster cannot churn a good consumer', () => {
    const plan = reconcileConsumers({
        entries: [held('c1', 'SAN', 'audio', 'p-new')],
        want: room(peer('SAN', [['audio', 'p-old']])),
        authoritative: false,
    });
    assert.deepEqual(plan, { drop: [], consume: [] });
});

test('two consumers of one voice collapse to one, and the server stops forwarding the other', () => {
    const plan = reconcileConsumers({
        entries: [held('c1', 'SAN', 'audio', 'p-1'), held('c2', 'SAN', 'audio', 'p-1')],
        want: room(peer('SAN', [['audio', 'p-1']])),
    });
    assert.deepEqual(plan.drop, [{ id: 'c1', key: 'SAN:audio', reason: 'duplicate', closeOnServer: true }]);
    assert.deepEqual(plan.consume, [], 'the newest one stays, so nothing needs asking for');
});

test('of two consumers on different producers, the newest stays and the older is let go quietly', () => {
    // The older one's producer has already been closed on the server; telling it to close a
    // consumer it no longer has would only come back as an error frame.
    const plan = reconcileConsumers({
        entries: [held('c-old', 'SAN', 'audio', 'p-old'), held('c-new', 'SAN', 'audio', 'p-new')],
        want: room(peer('SAN', [['audio', 'p-old']])),
    });
    assert.deepEqual(plan.drop, [{ id: 'c-old', key: 'SAN:audio', reason: 'stale', closeOnServer: false }]);
});

test('under the truth, staleness goes first and duplicates of the current producer collapse after', () => {
    const plan = reconcileConsumers({
        entries: [
            held('c1', 'SAN', 'audio', 'p-old'),
            held('c2', 'SAN', 'audio', 'p-cur'),
            held('c3', 'SAN', 'audio', 'p-cur'),
        ],
        want: room(peer('SAN', [['audio', 'p-cur']])),
        authoritative: true,
    });
    assert.deepEqual(plan.drop.map((d) => [d.id, d.reason, d.closeOnServer]), [
        ['c1', 'stale', false],
        ['c2', 'duplicate', true],
    ]);
    assert.deepEqual(plan.consume, []);
});

test('different people and different slots never collide', () => {
    const plan = reconcileConsumers({
        entries: [held('c1', 'SAN', 'audio', 'p-1'), held('c2', 'EMBY', 'audio', 'p-2'), held('c3', 'SAN', 'screen', 'p-3')],
        want: room(peer('SAN', [['audio', 'p-1'], ['screen', 'p-3']]), peer('EMBY', [['audio', 'p-2']])),
        authoritative: true,
    });
    assert.deepEqual(plan, { drop: [], consume: [] });
});

test('a ragged list cannot throw', () => {
    assert.deepEqual(reconcileConsumers(), { drop: [], consume: [] });
    assert.deepEqual(reconcileConsumers({ entries: [null, {}], want: room() }), { drop: [], consume: [] });
});

/* ── createFlights ───────────────────────────────────────────────────────── */

/** A request that answers only when told to. */
function gate() {
    let open;
    let fail;
    const promise = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return { promise, open, fail };
}

test('asking twice while the first ask is on its way sends one request', async () => {
    const flights = createFlights();
    const reply = gate();
    let started = 0;
    const start = () => { started += 1; return reply.promise; };

    const first = flights.run('SAN:audio', 'p-1', start);
    const second = flights.run('SAN:audio', 'p-1', start);
    const untagged = flights.run('SAN:audio', null, start);
    reply.open('consumer');

    assert.deepEqual(await Promise.all([first, second, untagged]), ['consumer', 'consumer', 'consumer']);
    assert.equal(started, 1, 'one request, so one consumer, so one copy of the voice');
    assert.equal(flights.size, 0, 'and the key is free again once it has landed');
});

test('an ask for a different producer waits for the one in flight, then asks again', async () => {
    const flights = createFlights();
    const order = [];
    const firstReply = gate();
    const first = flights.run('SAN:audio', 'p-old', () => { order.push('old'); return firstReply.promise; });
    const second = flights.run('SAN:audio', 'p-new', () => { order.push('new'); return 'fresh'; });

    await Promise.resolve();
    assert.deepEqual(order, ['old'], 'nothing new is asked while the old answer is still coming');
    firstReply.open('stale');
    assert.equal(await first, 'stale');
    assert.equal(await second, 'fresh');
    assert.deepEqual(order, ['old', 'new']);
});

test('different streams fly side by side', async () => {
    const flights = createFlights();
    const a = gate();
    const b = gate();
    const started = [];
    const one = flights.run('SAN:audio', 'p-1', () => { started.push('SAN'); return a.promise; });
    const two = flights.run('EMBY:audio', 'p-2', () => { started.push('EMBY'); return b.promise; });

    await Promise.resolve();
    assert.deepEqual(started, ['SAN', 'EMBY']);
    b.open(2);
    a.open(1);
    assert.deepEqual(await Promise.all([one, two]), [1, 2]);
});

test('a failure reaches everyone who shared it, and frees the key for the next ask', async () => {
    const flights = createFlights();
    const reply = gate();
    let started = 0;
    const first = flights.run('SAN:audio', 'p-1', () => { started += 1; return reply.promise; });
    const second = flights.run('SAN:audio', 'p-1', () => { started += 1; return reply.promise; });
    reply.fail(new Error('The server did not answer "consumed" in time.'));

    await assert.rejects(first, /did not answer/);
    await assert.rejects(second, /did not answer/);
    assert.equal(await flights.run('SAN:audio', 'p-1', () => { started += 1; return 'retried'; }), 'retried');
    assert.equal(started, 2);
});

test('a teardown forgets what is in flight, so nothing after it waits on a request from before', async () => {
    const flights = createFlights();
    const before = gate();
    const generation = flights.generation;
    const stale = flights.run('SAN:audio', 'p-1', () => before.promise);

    flights.reset();
    assert.equal(flights.generation, generation + 1, 'the old request can tell its answer is out of date');

    const after = flights.run('SAN:audio', 'p-1', () => 'rebuilt');
    assert.equal(await after, 'rebuilt', 'asked at once, not queued behind the old path');

    // The old request landing late must not free the slot of the one that replaced it.
    const pending = gate();
    const current = flights.run('SAN:audio', 'p-1', () => pending.promise);
    before.open('old path');
    await stale;
    assert.equal(flights.run('SAN:audio', 'p-1', () => 'should not run'), current);
    pending.open('done');
    assert.equal(await current, 'done');
});
