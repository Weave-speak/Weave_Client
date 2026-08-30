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

test('the microphone leaves its bitrate to the server; the stream does not', () => {
    // The mic defers so an operator can change WEAVE_OPUS_BITRATE and listen without cutting
    // a release. The stream cannot afford the same deference, for two reasons. The router's
    // value is a floor for EVERY producer, so raising it there to suit shared music drags the
    // microphone up with it for no gain — the two slots have to be able to disagree. And that
    // knob ships OFF, so "the server decides" has meant Chromium's own fallback of roughly
    // 32 kb/s, split across two channels at that. Game and film audio arriving as a smeared
    // mono blur is the whole of what people were reporting.
    assert.equal(micCodecOptions().opusMaxAverageBitrate, undefined, 'the operator decides, by ear');
    assert.equal(screenAudioCodecOptions().opusMaxAverageBitrate, 256_000, 'Opus own ceiling for stereo music');
});

test('neither slot pins a playback rate', () => {
    // Pinning fullband stops Opus narrowing its own bandwidth when the link tightens, which
    // is a thing it is good at and which being told otherwise prevented.
    for (const opts of [micCodecOptions(), screenAudioCodecOptions()]) {
        assert.equal(opts.opusMaxPlaybackRate, undefined, 'let Opus narrow its own bandwidth under pressure');
    }
});

test('system audio is stereo, and does not suppress silence', () => {
    // Silence suppression makes music gap and pump. Stereo is asked for even though echo
    // cancellation currently downmixes the capture to mono — it costs nothing, is correct
    // the moment per-application capture makes real stereo possible, and at 256 kb/s no
    // longer has a starved budget to halve.
    assert.deepEqual(screenAudioCodecOptions(), {
        opusStereo: true, opusDtx: false, opusMaxAverageBitrate: 256_000,
    });
});
