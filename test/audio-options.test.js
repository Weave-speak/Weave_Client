// What we ask Opus for.
//
// These assertions are a record of what NOT to change without listening first. Four
// releases tried to improve this path and each made something worse; the values below are
// what shipped in every version people described as sounding fine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { micCodecOptions, screenAudioCodecOptions } from '../src/media/audio-options.js';

test('the microphone asks for FEC and DTX, and nothing else', () => {
    // Deliberately minimal. Every addition here has cost something: opusNack made distant
    // callers fast-forward, and pinning the bitrate and playback rate belongs on the
    // server where it can be A/B tested with an environment variable instead of a release.
    assert.deepEqual(micCodecOptions(), { opusDtx: true, opusFec: true });
});

test('neither slot asks for Opus NACK', () => {
    // Retransmission costs a full round trip, so the receiver holds its jitter buffer open
    // and then time-compresses to catch up — heard as fast-forwarded speech. It only ever
    // showed up for callers on another continent, and the server never retransmits audio
    // anyway, so the wait bought nothing. In-band FEC is the loss resilience for a long
    // link, because the redundancy travels inside the next packet at no round-trip cost.
    for (const opts of [micCodecOptions(), screenAudioCodecOptions()]) {
        assert.equal(opts.opusNack, undefined, 'let mediasoup-client strip it, as it does by default');
    }
});

test('neither slot pins a bitrate in the client', () => {
    // The server declares it, so an operator can change it and listen without cutting a
    // release. A value baked in here would override that and take the knob away.
    for (const opts of [micCodecOptions(), screenAudioCodecOptions()]) {
        assert.equal(opts.opusMaxAverageBitrate, undefined);
        assert.equal(opts.opusMaxPlaybackRate, undefined, 'let Opus narrow its own bandwidth under pressure');
    }
});

test('system audio is stereo, and does not suppress silence', () => {
    // Silence suppression makes music gap and pump. Stereo is asked for even though echo
    // cancellation currently downmixes the capture to mono — it costs nothing and is
    // correct the moment per-application capture makes real stereo possible.
    assert.deepEqual(screenAudioCodecOptions(), { opusStereo: true, opusDtx: false });
});
