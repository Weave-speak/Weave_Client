// When a stream starting or stopping is heard.
//
// The web app chimes on every video producer that appears in your room. Here a producer_new
// also means "they moved across workers and re-produced", "they reconnected", or "you just
// walked in" — and a chime on each of those would teach people to ignore it. These pin down
// which announcements are real starts and stops.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamCues, ARRIVAL_GRACE_MS, RESUME_GRACE_MS } from '../src/room/stream-cues.js';

const ROOM = 'general';
const ME = 'u-me';

/** A clock the test moves by hand, and a cue machine that has long settled in its room. */
function setup() {
    let t = 1_000_000;
    const cues = createStreamCues({ now: () => t });
    const advance = (ms) => { t += ms; };
    // Settle: arriving in a room is a grace period of its own.
    cues.observe({ type: 'joined' }, { currentChannelId: ROOM, selfUserId: ME });
    advance(ARRIVAL_GRACE_MS + 1);
    return { cues, advance };
}

const peer = (over = {}) => ({ cid: 'c-kes', userId: 'u-kes', channelId: ROOM, producers: [], ...over });
const ctx = (p = peer()) => ({ peer: p, currentChannelId: ROOM, selfUserId: ME });
const started = (slot = 'screen', producerId = 'p1', cid = 'c-kes') => ({ type: 'producer_new', cid, slot, producerId });
const closed = (slot = 'screen', producerId = 'p1', extra = {}) => ({ type: 'producer_closed', cid: 'c-kes', slot, producerId, ...extra });

test('a screen starting and stopping in your room is heard, once each', () => {
    const { cues } = setup();
    assert.equal(cues.observe(started(), ctx()), 'start');
    assert.equal(cues.observe(closed('screen', 'p1', { stopped: true }), ctx()), 'end');
});

test('cameras count too, as on the web app; voice and screen audio do not', () => {
    const { cues } = setup();
    assert.equal(cues.observe(started('webcam', 'p-cam'), ctx()), 'start');
    assert.equal(cues.observe(started('audio', 'p-mic'), ctx()), null);
    assert.equal(cues.observe(started('screen-audio', 'p-sa'), ctx()), null);
    assert.equal(cues.observe(closed('audio', 'p-mic', { stopped: true }), ctx()), null);
});

test('the same producer announced again is not a second start', () => {
    const { cues } = setup();
    assert.equal(cues.observe(started(), ctx()), 'start');
    assert.equal(cues.observe(started(), ctx()), null);
});

test('only deliberate stops end with a sound — a disconnect or a replace is quiet', () => {
    const { cues } = setup();
    cues.observe(started(), ctx());
    assert.equal(cues.observe(closed('screen', 'p1'), ctx()), null, 'a transport teardown');
    assert.equal(cues.observe(closed('screen', 'p1', { replaced: true }), ctx()), null, 'a re-picked share');
});

test('a replaced share is heard starting, but never stopping', () => {
    // The web app does the same: re-running the picker is a new stream, not an ended one.
    const { cues } = setup();
    cues.observe(started('screen', 'p1'), ctx());
    assert.equal(cues.observe(closed('screen', 'p1', { replaced: true }), ctx()), null);
    assert.equal(cues.observe(started('screen', 'p2'), ctx()), 'start');
});

test('streams in other rooms, and your own account, are not heard', () => {
    const { cues } = setup();
    const elsewhere = peer({ channelId: 'lounge' });
    assert.equal(cues.observe(started('screen', 'p-x'), ctx(elsewhere)), null);
    assert.equal(cues.observe(closed('screen', 'p-x', { stopped: true }), ctx(elsewhere)), null);

    const myOtherDevice = peer({ cid: 'c-mine', userId: ME });
    assert.equal(cues.observe(started('screen', 'p-y', 'c-mine'), ctx(myOtherDevice)), null);
    assert.equal(cues.observe(closed('screen', 'p-y', { stopped: true }), ctx(myOtherDevice)), null);
});

test('an unknown peer is not guessed at', () => {
    const { cues } = setup();
    assert.equal(cues.observe(started(), { currentChannelId: ROOM, selfUserId: ME }), null);
});

test('someone arriving with their share already running is not a start', () => {
    // A cross-worker move tears their media down and they re-produce in the new room.
    const { cues, advance } = setup();
    const before = peer({ channelId: 'lounge' });
    cues.observe({ type: 'peer_joined', peer: peer() }, ctx(before));
    advance(1500);
    assert.equal(cues.observe(started('screen', 'p-moved'), ctx()), null);

    // But once they have been here a while, a new share is theirs to announce.
    advance(ARRIVAL_GRACE_MS);
    assert.equal(cues.observe(started('webcam', 'p-cam'), ctx()), 'start');
});

test('a peer_joined that is only an upsert, not an arrival, starts no grace', () => {
    // peer_joined also carries status changes for someone already here.
    const { cues } = setup();
    cues.observe({ type: 'peer_joined', peer: peer() }, ctx(peer()));
    assert.equal(cues.observe(started(), ctx()), 'start');
});

test('walking into a room is not everybody starting at once', () => {
    const { cues, advance } = setup();
    cues.observe({ type: 'moved' }, ctx());
    advance(2000);
    assert.equal(cues.observe(started('screen', 'p-there'), ctx()), null);
    advance(ARRIVAL_GRACE_MS);
    assert.equal(cues.observe(started('screen', 'p-new'), ctx()), 'start');
});

test('a share resuming after a dropped connection is not a new start', () => {
    const { cues, advance } = setup();
    cues.observe(started('screen', 'p1'), ctx());
    advance(60_000);
    // The old producer goes with the transport — no deliberate stop.
    assert.equal(cues.observe(closed('screen', 'p1'), ctx()), null);
    advance(ARRIVAL_GRACE_MS + 5000);
    // Back under a new cid, re-producing the same screen.
    const back = peer({ cid: 'c-kes-2' });
    assert.equal(cues.observe(started('screen', 'p2', 'c-kes-2'), ctx(back)), null);
    // The grace is spent on that one resume; a later real start is heard.
    advance(5000);
    cues.observe(closed('screen', 'p2', { stopped: true }), ctx(back));
    assert.equal(cues.observe(started('screen', 'p3', 'c-kes-2'), ctx(back)), 'start');
});

test('a share that went with a vanished connection resumes quietly too', () => {
    const { cues, advance } = setup();
    const streaming = peer({ producers: [{ slot: 'screen', id: 'p1' }] });
    cues.observe({ type: 'peer_left', cid: 'c-kes' }, ctx(streaming));
    advance(ARRIVAL_GRACE_MS + 5000);
    assert.equal(cues.observe(started('screen', 'p2', 'c-kes-2'), ctx(peer({ cid: 'c-kes-2' }))), null);
});

test('an unannounced close long ago does not silence a new share', () => {
    const { cues, advance } = setup();
    cues.observe(closed('screen', 'p1'), ctx());
    advance(RESUME_GRACE_MS + 1);
    assert.equal(cues.observe(started('screen', 'p2'), ctx()), 'start');
});
