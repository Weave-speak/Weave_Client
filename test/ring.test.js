// Calls ringing in and going out: every frame that starts a ring, every one that ends it,
// and what answering or declining sends.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RING_MS, callIdOf, ringFromFrame, ringsEndedBy, answerFrame, declineFrame, outgoingOutcome, callPlace,
} from '../src/room/ring.js';
import { TONES, toneNotes } from '../src/media/call-tones.js';

const from = { username: 'kes', displayName: 'Kestrel' };

test('a private call rings with the caller by name, until the server says it stops', () => {
    const ring = ringFromFrame({ type: 'dm:ring', threadId: 't1', callId: 'abc', from, expiresAt: 5000 }, 0);
    assert.deepEqual(ring, {
        callId: 'abc', kind: 'dm', threadId: 't1', channelId: null,
        title: 'Kestrel', subtitle: 'is calling you', expiresAt: 5000,
    });
});

test('an older server sends no call id: the thread stands in, and the ring lasts its usual time', () => {
    const ring = ringFromFrame({ type: 'dm:ring', threadId: 't1', from }, 1000);
    assert.equal(ring.callId, 'dm:t1');
    assert.equal(ring.expiresAt, 1000 + RING_MS);
    assert.equal(callIdOf({}), null);
});

test('a huddle rings with its own name and who started it', () => {
    const ring = ringFromFrame({
        type: 'private-channels:ring', channelId: 'h1', callId: 'xyz', name: 'Planning', from, ringMs: 30_000,
    }, 0);
    assert.equal(ring.kind, 'huddle');
    assert.equal(ring.title, 'Planning');
    assert.equal(ring.subtitle, 'Kestrel started a huddle');
    assert.equal(ring.expiresAt, 30_000);
    // A frame without the name borrows the room list's.
    const named = ringFromFrame({ type: 'private-channels:ring', channelId: 'h1', callId: 'q' }, 0, () => 'Late night');
    assert.equal(named.title, 'Late night');
    assert.equal(ringFromFrame({ type: 'private-channels:ring' }), null, 'nothing to ring for without an id');
    assert.equal(ringFromFrame({ type: 'text-chat:message' }), null);
});

test('a ring ends with whatever ends its call — here, elsewhere, declined or given up', () => {
    const rings = [
        { callId: 'abc', kind: 'dm', threadId: 't1' },
        { callId: 'dm:t2', kind: 'dm', threadId: 't2' },
        { callId: 'xyz', kind: 'huddle', channelId: 'h1' },
    ];
    assert.deepEqual(ringsEndedBy({ type: 'dm:call_live', threadId: 't1', callId: 'abc' }, rings), ['abc']);
    assert.deepEqual(ringsEndedBy({ type: 'dm:call_ended', threadId: 't2', reason: 'cancelled' }, rings), ['dm:t2'],
        'an older server names only the thread');
    assert.deepEqual(ringsEndedBy({ type: 'private-channels:ring_cancel', callId: 'xyz', channelId: 'h1' }, rings), ['xyz']);
    assert.deepEqual(ringsEndedBy({ type: 'dm:call_ended', threadId: 't1', callId: 'other' }, rings), [],
        'a newer call on the same thread does not end this ring');
    assert.deepEqual(ringsEndedBy({ type: 'dm:ring', threadId: 't1' }, rings), []);
});

test('answering a call accepts it; answering a huddle is walking in', () => {
    assert.deepEqual(answerFrame({ kind: 'dm', threadId: 't1', callId: 'abc' }), ['dm:accept', { threadId: 't1', callId: 'abc' }]);
    assert.deepEqual(answerFrame({ kind: 'dm', threadId: 't1', callId: 'dm:t1' }), ['dm:accept', { threadId: 't1' }],
        'a stand-in id is never sent as if it were the server\'s');
    assert.deepEqual(answerFrame({ kind: 'huddle', channelId: 'h1', callId: 'xyz' }), ['move', { channelId: 'h1' }]);
    assert.deepEqual(declineFrame({ kind: 'dm', threadId: 't1', callId: 'abc' }), ['dm:decline', { threadId: 't1', callId: 'abc' }]);
    assert.deepEqual(declineFrame({ kind: 'huddle', channelId: 'h1', callId: 'xyz' }),
        ['private-channels:decline', { channelId: 'h1', callId: 'xyz' }]);
    assert.equal(answerFrame(null), null);
});

test('ringback plays until the call you placed is answered or settled', () => {
    assert.equal(outgoingOutcome({ type: 'dm:call_live', threadId: 't1' }, 't1'), 'live');
    assert.equal(outgoingOutcome({ type: 'dm:call_ended', threadId: 't1', reason: 'declined' }, 't1'), 'declined');
    assert.equal(outgoingOutcome({ type: 'dm:call_ended', threadId: 't1', reason: 'no_answer' }, 't1'), 'no_answer');
    assert.equal(outgoingOutcome({ type: 'dm:call_ended', threadId: 't1', reason: 'left' }, 't1'), 'ended');
    assert.equal(outgoingOutcome({ type: 'dm:call_live', threadId: 't9' }, 't1'), null, 'another call is not this one');
    assert.equal(outgoingOutcome({ type: 'dm:call_live', threadId: 't1' }, null), null);
});

test('ringback is a second of tone every five; the ring is a trill that repeats', () => {
    assert.deepEqual(toneNotes('ringback', 0, 12_000).map((n) => [n.start, n.end]),
        [[0, 1000], [5000, 6000], [10_000, 11_000]]);
    const ring = toneNotes('ring', 0, TONES.ring.cycleMs);
    assert.equal(ring.length, TONES.ring.notes.length);
    assert.ok(ring.every((n) => n.freqs.length === 2), 'two notes at once: a trill, not a beep');
    // Scheduling in windows never drops or repeats a note at the seam.
    const whole = toneNotes('ring', 0, 8_000).length;
    const split = toneNotes('ring', 0, 3_000).filter((n) => n.start < 3_000).length
        + toneNotes('ring', 3_000, 8_000).filter((n) => n.start >= 3_000).length;
    assert.equal(split, whole);
    assert.deepEqual(toneNotes('nope', 0, 1000), []);
});

test('a call is in progress only on the device that placed or answered it', () => {
    // Signed in on a phone and a computer: both rang, the phone answered.
    const live = { type: 'dm:call_live', threadId: 't1', callId: 'abc' };
    assert.equal(callPlace(live, { activeThreadId: 't1' }), 'here', 'the phone, which answered');
    assert.equal(callPlace(live, { activeThreadId: null }), 'elsewhere', 'the computer, which only rang');
    assert.equal(callPlace(live, { activeThreadId: 't9' }), 'elsewhere', 'a different call is not this one');

    // Declined on the phone: the computer must not tell its owner "Call declined."
    const declined = { type: 'dm:call_ended', threadId: 't1', reason: 'declined' };
    assert.equal(callPlace(declined, { activeThreadId: null }), 'elsewhere');
    assert.equal(callPlace(declined, { activeThreadId: 't1' }), 'here', 'the caller, who should hear it');

    // A page reloaded mid-call stands in the call room without remembering which call: the end
    // of the call must still walk it out.
    const ended = { type: 'dm:call_ended', threadId: 't1', reason: 'left' };
    assert.equal(callPlace(ended, { activeThreadId: null, inCallRoom: true }), 'here');
    assert.equal(callPlace(ended, { activeThreadId: 't9', inCallRoom: true }), 'elsewhere',
        'not when it knows it is in a different call');
    assert.equal(callPlace({ type: 'dm:ring', threadId: 't1' }, { activeThreadId: 't1' }), null);
});
