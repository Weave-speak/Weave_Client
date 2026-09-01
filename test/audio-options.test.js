// What we ask Opus for.
//
// These assertions are a record of what NOT to change without listening first. Four
// releases tried to improve this path by reasoning and each made something worse, which is
// why the values below are not reasoned either: they are what the Weave web app sends, and
// it has been in production against the same SFU and the same codec for months.

import test from 'node:test';
import assert from 'node:assert/strict';

import { micCodecOptions, screenAudioCodecOptions } from '../src/media/audio-options.js';

test('the microphone does not suppress its own silence', () => {
    // The one that matters. DTX stops sending during what the encoder judges to be silence,
    // and its re-entry clips the front of the next word -- which is what "stuttering" was.
    // The noise gate already decides when not to transmit, against a threshold the person
    // can see, so DTX was doing a job nothing needed done.
    assert.equal(micCodecOptions().opusDtx, false);
});

test('the microphone is mono, full-band, and asks for FEC', () => {
    // Mono because a microphone is one sound source and stereo would double the bitrate to
    // carry a phase difference nobody wants in a voice mix. FEC because a packet rebuilt
    // from the next one matters more to a conversation than bitrate does, and costs no
    // round trip. opusMaxPlaybackRate is the line here with a standing argument against it
    // -- see the note in audio-options.js -- and is the first thing to drop if a listening
    // test says this got worse.
    assert.deepEqual(micCodecOptions(), {
        opusStereo: false,
        opusFec: true,
        opusDtx: false,
        opusMaxPlaybackRate: 48000,
    });
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
    // The mic defers because the router's declared parameters are what configure a browser's
    // encoder, so a value set there reaches every client including ones too old to ask for
    // it, and leaves an operator one restart away from a different number. WEAVE_OPUS_BITRATE
    // now defaults to 96000 rather than shipping off, so deferring means 96 kb/s and not
    // Chromium's ~32. Naming it here as well would only take that reversibility back.
    //
    // The stream cannot afford the same deference: the router's value is a floor for EVERY
    // producer, so raising it there to suit shared music drags the microphone up with it for
    // no gain. The two slots have to be able to disagree.
    assert.equal(micCodecOptions().opusMaxAverageBitrate, undefined, 'the server decides, reversibly');
    assert.equal(screenAudioCodecOptions().opusMaxAverageBitrate, 256_000, 'Opus own ceiling for stereo music');
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
