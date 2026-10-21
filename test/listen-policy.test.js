// How loudly you hear one person, and through which output.
//
// The rule these pin down is that exactly one of the two outputs is ever audible. Both
// ways of getting that wrong are silent failures in production: mute the element whenever
// a gain node exists and a suspended context makes the room go quiet, or leave the element
// playing as a safety net and everyone is heard twice at once.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    listenOutput, duckState, MAX_LISTEN_GAIN, DUCK_FACTOR, DUCK_HOLD_MS, PRIORITY_TALKING_AT,
} from '../src/media/listen-policy.js';

test('a running context carries the sound, and the element goes quiet', () => {
    const out = listenOutput({ pref: { volume: 1 }, hasGain: true, contextRunning: true });
    assert.equal(out.gain, 1);
    assert.equal(out.elementMuted, true, 'or the voice plays twice');
});

test('somebody can be turned up past the element ceiling', () => {
    // The whole reason the gain node exists. HTMLMediaElement.volume stops at 1.0, so a
    // quiet talker had no fix at all before this.
    const out = listenOutput({ pref: { volume: 2 }, hasGain: true, contextRunning: true });
    assert.equal(out.gain, 2);
    assert.equal(listenOutput({ pref: { volume: 9 }, hasGain: true, contextRunning: true }).gain,
        MAX_LISTEN_GAIN, 'and not past the cap');
});

test('a suspended context hands the sound back to the element', () => {
    // Web Audio emits nothing while suspended. Routing everything through it regardless
    // would turn a recoverable autoplay block into a room nobody can hear.
    const out = listenOutput({ pref: { volume: 2 }, hasGain: true, contextRunning: false });
    assert.equal(out.elementMuted, false, 'the element is the fallback, not a formality');
    assert.equal(out.elementVolume, 1, 'clamped to what the element can actually do');
    assert.equal(out.gain, 0, 'and the node is silenced so a resume cannot double it');
});

test('with no Web Audio at all the element simply carries it', () => {
    const out = listenOutput({ pref: { volume: 0.5 }, hasGain: false, contextRunning: false });
    assert.equal(out.gain, null, 'nothing to write to');
    assert.equal(out.elementMuted, false);
    assert.equal(out.elementVolume, 0.5);
});

test('deafened outranks every per-stream choice, on either output', () => {
    for (const contextRunning of [true, false]) {
        const out = listenOutput({ deafened: true, pref: { volume: 2 }, hasGain: true, contextRunning });
        assert.equal(out.gain, 0);
        assert.equal(out.elementMuted, true);
    }
});

test('lifting deafen restores a choice rather than unmuting everyone', () => {
    // Somebody you muted individually stays muted. This is the case a simpler
    // implementation gets wrong by treating deafen as a blanket set-and-clear.
    const muted = listenOutput({ deafened: false, pref: { muted: true, volume: 1 }, hasGain: true, contextRunning: true });
    assert.equal(muted.gain, 0);
    const heard = listenOutput({ deafened: false, pref: { muted: false, volume: 1 }, hasGain: true, contextRunning: true });
    assert.equal(heard.gain, 1);
});

test('a stream with no preference of its own is still governed', () => {
    // A person joining and talking is exactly when a missing preference used to let sound
    // through while deafened.
    assert.equal(listenOutput({ deafened: true, hasGain: true, contextRunning: true }).gain, 0);
    assert.equal(listenOutput({ hasGain: true, contextRunning: true }).gain, 1, 'and defaults to as-sent');
});

/* ── priority speaker ───────────────────────────────────────────────────── */

test('a duck turns somebody down by the factor, on top of their own volume', () => {
    const out = listenOutput({ pref: { volume: 2 }, hasGain: true, contextRunning: true, duck: DUCK_FACTOR });
    assert.equal(out.gain, 2 * DUCK_FACTOR, 'composed, not replaced — your slider still counts');
});

test('a duck is a duck, never a mute or a boost', () => {
    assert.ok(DUCK_FACTOR > 0 && DUCK_FACTOR < 1);
    // Out-of-range factors are clamped rather than trusted.
    assert.equal(listenOutput({ hasGain: true, contextRunning: true, duck: 5 }).gain, 1);
    assert.equal(listenOutput({ hasGain: true, contextRunning: true, duck: 'x' }).gain, 1);
});

test('a duck does not lift deafen or a mute', () => {
    assert.equal(listenOutput({ deafened: true, hasGain: true, contextRunning: true, duck: DUCK_FACTOR }).gain, 0);
    assert.equal(listenOutput({ pref: { muted: true }, hasGain: true, contextRunning: true, duck: 1 }).gain, 0);
});

test('a duck reaches the element fallback too', () => {
    const out = listenOutput({ pref: { volume: 1 }, hasGain: true, contextRunning: false, duck: DUCK_FACTOR });
    assert.equal(out.elementVolume, DUCK_FACTOR);
});

test('the room ducks while a starred voice is talking, and holds through a breath', () => {
    let s = duckState([PRIORITY_TALKING_AT], 1000, 0);
    assert.equal(s.ducked, true);
    // Silent now, but within the hold: still ducked, so a pause mid-sentence does not pump.
    s = duckState([0], 1000 + DUCK_HOLD_MS - 1, s.holdUntil);
    assert.equal(s.ducked, true);
    s = duckState([0], 1000 + DUCK_HOLD_MS, s.holdUntil);
    assert.equal(s.ducked, false, 'and lets go once the hold has run out');
});

test('room tone from a starred microphone does not duck anybody', () => {
    assert.equal(duckState([PRIORITY_TALKING_AT / 2], 1000, 0).ducked, false);
    assert.equal(duckState([], 1000, 0).ducked, false, 'nobody starred is here');
});

test('any one starred voice talking is enough', () => {
    assert.equal(duckState([0, 0.4, 0], 1000, 0).ducked, true);
});

test('a nonsense volume reads as unchanged rather than silent', () => {
    for (const volume of [undefined, null, NaN, 'loud']) {
        const out = listenOutput({ pref: { volume }, hasGain: true, contextRunning: true });
        assert.equal(out.gain, 1, `${String(volume)} should not mute somebody`);
    }
    assert.equal(listenOutput({ pref: { volume: -3 }, hasGain: true, contextRunning: true }).gain, 0);
});
