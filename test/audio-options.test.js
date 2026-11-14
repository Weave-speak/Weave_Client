// What we ask Opus for.
//
// These assertions are a record of what NOT to change without listening first. Four
// releases tried to improve this path by reasoning and each made something worse, which is
// why the values below are not reasoned either: they are what the Weave web app sends, and
// it has been in production against the same SFU and the same codec for months.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    micCodecOptions, screenAudioCodecOptions, micConstraints, openMicrophoneStream, micFailureText,
} from '../src/media/audio-options.js';

test('the microphone is opened with three flags and nothing else', () => {
    // sampleRate, latency and channelCount each cost something when they were tried; the
    // three processing flags are what every version people liked shipped with.
    assert.deepEqual(micConstraints({}), {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    });
    assert.deepEqual(micConstraints({ echoCancellation: false, micDevice: 'dev-1' }), {
        echoCancellation: false, noiseSuppression: true, autoGainControl: true,
        deviceId: { exact: 'dev-1' },
    });
});

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

// A microphone chosen in Settings can go away: Bluetooth headphones switched off, a USB
// headset unplugged. Asked for exactly, a missing device fails outright with an
// OverconstrainedError whose message is empty, so voice never started and the room said only
// "Microphone unavailable:". Settings could not undo the choice either, since it lists devices
// only once the microphone has opened. Reported from a phone after Bluetooth headphones.

/** A getUserMedia that knows only the devices it is given. */
function fakeMedia(present) {
    const asked = [];
    return {
        asked,
        getUserMedia: async (c) => {
            asked.push(c);
            const wanted = c.audio?.deviceId?.exact;
            if (wanted && !present.includes(wanted)) {
                throw Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' });
            }
            return { id: 'stream', device: wanted ?? 'default' };
        },
    };
}

test('a chosen microphone that is there is the one opened', async () => {
    const media = fakeMedia(['headset']);
    const fellBack = [];
    const stream = await openMicrophoneStream(micConstraints({ micDevice: 'headset' }), {
        getUserMedia: media.getUserMedia, onFallback: (e) => fellBack.push(e),
    });
    assert.equal(stream.device, 'headset');
    assert.equal(media.asked.length, 1);
    assert.deepEqual(media.asked[0].audio.deviceId, { exact: 'headset' }, 'still asked for exactly');
    assert.equal(fellBack.length, 0);
});

test('a chosen microphone that has gone falls back to the default, flags intact', async () => {
    const media = fakeMedia([]);
    const fellBack = [];
    const stream = await openMicrophoneStream(micConstraints({ micDevice: 'bt-headphones', noiseSuppression: false }), {
        getUserMedia: media.getUserMedia, onFallback: (e) => fellBack.push(e.name),
    });
    assert.equal(stream.device, 'default');
    assert.equal(media.asked.length, 2);
    assert.deepEqual(media.asked[1], {
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
    }, 'only the device is dropped');
    assert.deepEqual(fellBack, ['OverconstrainedError'], 'and the room is told');
});

test('other failures are not papered over with a second request', async () => {
    for (const name of ['NotAllowedError', 'NotReadableError', 'AbortError']) {
        let calls = 0;
        const refuse = async () => { calls++; throw Object.assign(new Error('no'), { name }); };
        await assert.rejects(
            openMicrophoneStream(micConstraints({ micDevice: 'headset' }), { getUserMedia: refuse }),
            { name },
        );
        assert.equal(calls, 1, `${name} is the person's or the device's answer, not a missing device`);
    }
    // With no device chosen there is nothing to drop, so a missing microphone is reported.
    let calls = 0;
    const none = async () => { calls++; throw Object.assign(new Error(''), { name: 'NotFoundError' }); };
    await assert.rejects(openMicrophoneStream(micConstraints({}), { getUserMedia: none }), { name: 'NotFoundError' });
    assert.equal(calls, 1);
});

test('a microphone failure always says something', () => {
    const named = (name, message = '') => Object.assign(new Error(message), { name });
    assert.equal(micFailureText(named('NotAllowedError')), 'Microphone blocked. You can still hear everyone.');
    assert.match(micFailureText(named('NotFoundError')), /No microphone was found/);
    assert.match(micFailureText(named('OverconstrainedError')), /No microphone was found/);
    assert.match(micFailureText(named('NotReadableError')), /would not start/);
    assert.equal(micFailureText(named('TypeError', 'bad things')), 'Microphone unavailable: bad things');
    for (const err of [named('WeirdError'), named(''), {}, null, undefined]) {
        const text = micFailureText(err);
        assert.ok(!/:\s*$/.test(text), `"${text}" ends in a bare colon`);
        assert.ok(text.length > 'Microphone unavailable'.length);
    }
});
