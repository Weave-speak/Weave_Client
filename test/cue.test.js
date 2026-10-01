// Join and leave cues, routed to the device the room is heard on.
//
// What these pin down is that routing can fail in every way it knows how and the cue still
// plays: a cue on the wrong speaker is a nuisance, a cue that never plays is the bug this
// exists to fix.

import test from 'node:test';
import assert from 'node:assert/strict';

import { playCue } from '../src/media/cue.js';

/** Just enough of an HTMLAudioElement to record what was asked of it, and in what order. */
function fakeAudio({ sink = () => Promise.resolve(), play = () => Promise.resolve() } = {}) {
    const calls = [];
    return {
        calls,
        setSinkId: sink && ((id) => { calls.push(`sink:${id}`); return sink(id); }),
        play: () => { calls.push('play'); return play(); },
    };
}

test('the cue is routed to the chosen device before it starts', async () => {
    const audio = fakeAudio();
    await playCue(audio, 'headset');
    assert.deepEqual(audio.calls, ['sink:headset', 'play']);
});

test('the system default is left alone', async () => {
    for (const deviceId of ['', undefined, null]) {
        const audio = fakeAudio();
        await playCue(audio, deviceId);
        assert.deepEqual(audio.calls, ['play']);
    }
});

test('a device that has gone away still gets a cue on the default', async () => {
    const audio = fakeAudio({ sink: () => Promise.reject(new Error('NotFoundError')) });
    await playCue(audio, 'unplugged');
    assert.deepEqual(audio.calls, ['sink:unplugged', 'play']);
});

test('an engine without setSinkId, or one that throws, still plays', async () => {
    const missing = fakeAudio({ sink: null });
    await playCue(missing, 'headset');
    assert.deepEqual(missing.calls, ['play']);

    const throwing = fakeAudio({ sink: () => { throw new TypeError('not supported'); } });
    await playCue(throwing, 'headset');
    assert.deepEqual(throwing.calls, ['sink:headset', 'play']);
});

test('a refused play reaches the caller', async () => {
    // The autoplay policy's NotAllowedError is the caller's to interpret — the preview
    // button resets itself on it — so it must not vanish into the routing's catch.
    const audio = fakeAudio({ play: () => Promise.reject(new Error('NotAllowedError')) });
    await assert.rejects(playCue(audio, 'headset'), /NotAllowedError/);
});
