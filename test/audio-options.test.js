// What we ask Opus for. These numbers are the difference between "sounds like Discord"
// and "sounds like a phone", so they are asserted rather than trusted to a code review.

import test from 'node:test';
import assert from 'node:assert/strict';

import { micCodecOptions, screenAudioCodecOptions } from '../src/media/audio-options.js';

test('the microphone asks for a bitrate at all', () => {
    // Without opusMaxAverageBitrate, Chromium picks ~32 kb/s mono. Discord's default
    // channel is 64 kb/s; below roughly 48 kb/s speech starts losing its top octave.
    const o = micCodecOptions();
    assert.equal(o.opusMaxAverageBitrate, 64_000);
    assert.equal(o.opusMaxPlaybackRate, 48_000, 'fullband, stated rather than assumed');
    assert.equal(o.opusStereo, false, 'a microphone is one sound source');
    assert.equal(o.opusFec, true);
});

test('the microphone does not use DTX', () => {
    // The noise gate already emits digital silence. DTX on top of it stops sending
    // altogether, and the first syllable after a pause arrives before the decoder has
    // re-primed — heard as a clipped word. It would also make a quiet-but-connected
    // microphone indistinguishable from a dead send path, which the stall watchdog reads.
    assert.equal(micCodecOptions().opusDtx, false);
});

test('system audio is stereo and given room to breathe', () => {
    const o = screenAudioCodecOptions();
    assert.equal(o.opusStereo, true);
    assert.equal(o.opusMaxAverageBitrate, 128_000);
    assert.equal(o.opusDtx, false, 'silence suppression makes music gap and pump');
});

test('the two slots do not share a bitrate', () => {
    // The reason these cannot be declared once on the router: its codec parameters are the
    // floor for EVERY producer, so a single value would either starve the stream or drag
    // the microphone up for nothing.
    assert.notEqual(micCodecOptions().opusMaxAverageBitrate, screenAudioCodecOptions().opusMaxAverageBitrate);
});
