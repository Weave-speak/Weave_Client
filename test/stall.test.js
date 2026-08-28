// Deciding a transport has stopped carrying media.
//
// The bug these describe: users silently losing one direction of audio and having to
// reconnect by hand. Send and receive are separate transports, which is why it was always
// one direction. Time is passed in, so these drive the clock rather than waiting on it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createStallDetector, GRACE_MS, STALL_MS, MAX_ICE_RESTARTS,
} from '../src/media/stall.js';

const flowing = (d, t, packets) => d.sample({ state: 'connected', packets, expecting: true, now: t });

test('a healthy connected transport is left alone', () => {
    const d = createStallDetector();
    let packets = 0;
    for (let t = 0; t < 60_000; t += 2_000) {
        assert.equal(flowing(d, t, (packets += 100)), 'ok');
    }
});

test('disconnected is given a grace period, and cleared if it recovers', () => {
    // Browsers fix a short disruption themselves, usually well inside 15 s. Acting
    // instantly would reconnect people who were about to be fine.
    const d = createStallDetector();
    assert.equal(d.sample({ state: 'disconnected', now: 0 }), 'ok');
    assert.equal(d.sample({ state: 'disconnected', now: GRACE_MS - 1 }), 'ok');
    assert.equal(flowing(d, GRACE_MS, 100), 'ok', 'recovery inside the grace costs nothing');
    assert.equal(d.restarts, 0);
});

test('disconnected held past the grace escalates', () => {
    // The confirmed root cause: the client acted only on 'failed', the server reported
    // only 'closed' as fatal, and mediasoup-client can sit in 'disconnected' for ever.
    const d = createStallDetector();
    assert.equal(d.sample({ state: 'disconnected', now: 0 }), 'ok');
    assert.equal(d.sample({ state: 'disconnected', now: GRACE_MS }), 'restart-ice');
});

test('failed escalates at once, with no grace', () => {
    const d = createStallDetector();
    assert.equal(d.sample({ state: 'failed', now: 0 }), 'restart-ice');
});

test('a connected transport carrying no packets is disbelieved', () => {
    // Fault B, and the only one no state machine can catch: a NAT rebind moves the UDP
    // mapping, consent still flows outbound so nothing fires, and ICE keeps saying
    // 'connected' while the return path is gone.
    const d = createStallDetector();
    flowing(d, 0, 500);                                        // baseline
    assert.equal(flowing(d, 2_000, 500), 'ok', 'one flat sample is not a verdict');
    assert.equal(flowing(d, 2_000 + STALL_MS - 1, 500), 'ok', 'nor is a stall still inside the window');
    // The clock starts when flatness is first OBSERVED, not at the baseline sample.
    assert.equal(flowing(d, 2_000 + STALL_MS, 500), 'restart-ice');
});

test('a quiet transport is not a broken one', () => {
    // The false positive that would make this worse than nothing. A muted microphone, or
    // a peer with nobody to listen to, legitimately moves no packets at all.
    const d = createStallDetector();
    for (let t = 0; t <= STALL_MS * 3; t += 2_000) {
        assert.equal(d.sample({ state: 'connected', packets: 500, expecting: false, now: t }), 'ok');
    }
});

test('a transport still connecting is not yet a fault', () => {
    const d = createStallDetector();
    for (const state of ['new', 'connecting']) {
        assert.equal(d.sample({ state, now: 0 }), 'ok');
        assert.equal(d.sample({ state, now: STALL_MS * 2 }), 'ok');
    }
});

test('ICE restart is tried before a rebuild, and only so many times', () => {
    // The whole point of the ladder: restarting ICE repairs the path without recreating
    // producers or consumers, so it costs no permission prompt and no media state.
    const d = createStallDetector();
    for (let i = 0; i < MAX_ICE_RESTARTS; i += 1) {
        assert.equal(d.sample({ state: 'failed', now: i }), 'restart-ice');
    }
    assert.equal(d.sample({ state: 'failed', now: 99 }), 'rebuild', 'then stop trying the cheap fix');
});

test('sustained health earns the restart budget back', () => {
    // Without this, a path that flaps once an hour would eventually exhaust its budget
    // and go straight to a full rebuild for a fault ICE restart could have fixed.
    const d = createStallDetector();
    assert.equal(d.sample({ state: 'failed', now: 0 }), 'restart-ice');
    assert.equal(d.restarts, 1);

    let packets = 0;
    for (let t = 1_000; t <= 60_000; t += 2_000) flowing(d, t, (packets += 100));
    assert.equal(d.restarts, 0, 'a long healthy stretch, not one good sample');
});

test('reset forgets everything about the old path', () => {
    const d = createStallDetector();
    d.sample({ state: 'failed', now: 0 });
    d.reset();
    assert.equal(d.restarts, 0);
    assert.equal(d.sample({ state: 'disconnected', now: 0 }), 'ok', 'the grace starts over too');
});

test('flow is read from the candidate pair, so a quiet room is not a dead one', async () => {
    const { readFlow } = await import('../src/media/stall.js');

    // Everyone muted: no RTP at all, but ICE consent and RTCP keep the pair alive. Reading
    // inbound-rtp here would call this a broken path and reconnect people for being quiet.
    const quiet = [
        { type: 'candidate-pair', nominated: true, bytesReceived: 4_096, bytesSent: 2_048 },
        { type: 'inbound-rtp', bytesReceived: 0 },
    ];
    assert.equal(readFlow(quiet), 4_096, 'received only — see below');

    // Bytes SENT must never count. When a NAT rebinding kills the return path we go on
    // transmitting into the void, so a counter including bytesSent climbs for ever and the
    // one fault this exists to catch is the one it could never see.
    const deadReturnPath = [
        { type: 'candidate-pair', nominated: true, bytesReceived: 4_096, bytesSent: 9_999_999 },
    ];
    assert.equal(readFlow(deadReturnPath), 4_096, 'sending hard into a dead path is not flow');

    // Engines that do not fill in `nominated` still have to work.
    assert.equal(readFlow([{ type: 'candidate-pair', state: 'succeeded', bytesReceived: 10 }]), 10);

    // No pair reported at all: fall back to RTP rather than silently disabling the watch.
    assert.equal(readFlow([{ type: 'inbound-rtp', bytesReceived: 700 }]), 700);

    assert.equal(readFlow([]), null, 'a report saying nothing is not a stall');
    assert.equal(readFlow(null), null);

    // The shape it actually meets in a browser. An RTCStatsReport is Map-like, and
    // iterating a Map yields [key, value] pairs rather than the stats themselves — read
    // the wrong way this returns null for ever and the watchdog quietly never fires.
    const asReport = new Map([
        ['cp1', { type: 'candidate-pair', nominated: true, bytesReceived: 900, bytesSent: 100 }],
        ['ir1', { type: 'inbound-rtp', bytesReceived: 5 }],
    ]);
    assert.equal(readFlow(asReport), 900);
});
