// Stream and camera presets: two settings in, everything a share needs out.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    screenShareSettings, cameraConstraints, cameraEncodings, STREAM_PRESETS,
} from '../src/media/presets.js';

test('each preset caps capture and budget together', () => {
    const p = screenShareSettings({ preset: '1080p60' });
    assert.equal(p.constraints.video.frameRate.max, 60);
    assert.equal(p.constraints.video.width.max, 1920);
    assert.equal(p.encodings[0].maxBitrate, 6_000_000);
});

test('source imposes no size, only a rate and the largest budget', () => {
    const p = screenShareSettings({ preset: 'source' });
    assert.equal(p.constraints.video.width, undefined);
    assert.equal(p.encodings[0].maxBitrate, 8_000_000);
});

test('the tie-breaker maps onto the content hint', () => {
    assert.equal(screenShareSettings({ prefer: 'detail' }).contentHint, 'detail');
    assert.equal(screenShareSettings({ prefer: 'motion' }).contentHint, 'motion');
    assert.equal(screenShareSettings({ prefer: 'nonsense' }).contentHint, 'detail', 'text survives by default');
});

test('an unknown preset falls back to the everyday default', () => {
    const p = screenShareSettings({ preset: 'nope' });
    assert.equal(p.encodings[0].maxBitrate, STREAM_PRESETS['1080p30'].maxBitrate);
});

test('camera constraints follow the chosen ladder and device', () => {
    const c = cameraConstraints({ device: 'cam-1', res: '1080', fps: 60 });
    assert.equal(c.deviceId.exact, 'cam-1');
    assert.equal(c.height.ideal, 1080);
    assert.equal(c.frameRate.ideal, 60);
    assert.equal(cameraConstraints({}).height.ideal, 720, 'kind to upload by default');
});

test('system audio keeps echo cancellation, and drops the rest', () => {
    // The regression this exists to prevent, shipped in 0.1.41: turning AEC off here sent
    // the whole room back to itself. The loopback captures the machine's OUTPUT MIX, and
    // that mix contains the call — so without AEC every viewer heard their own voice
    // returned through the stream. Headphones make no difference; it is not a microphone.
    const { audio } = screenShareSettings({}).constraints;
    assert.notEqual(audio, true, 'still stated, not left to the engine');
    assert.equal(audio.echoCancellation, true, 'OFF here feeds the call back to itself');

    // Neither of these ever had anything to do with the loop, and both hurt music.
    assert.equal(audio.noiseSuppression, false, 'NS gates sustained music');
    assert.equal(audio.autoGainControl, false, 'AGC pumps a film flat');
});

test('a screen share is a single encoding', () => {
    // VP9 K-SVC here gave every viewer a black picture while the audio from the same
    // share played fine. It goes back only behind a two-machine test.
    for (const prefer of ['detail', 'motion']) {
        const { encodings } = screenShareSettings({ prefer });
        assert.equal(encodings.length, 1);
        assert.equal(encodings[0].scalabilityMode, undefined, 'no SVC until it is proven');
    }
});

test('the camera ladder follows the chosen resolution', () => {
    // A 1080p capture squeezed into a 720p budget looks worse than 720p, so picking
    // "sharper, heavier" used to make the picture softer.
    assert.equal(cameraEncodings({ res: '1080' }).at(-1).maxBitrate, 2_500_000);
    assert.equal(cameraEncodings({ res: '720' }).at(-1).maxBitrate, 1_800_000);
    assert.equal(cameraEncodings({}).length, 3, 'three rungs for the SFU to choose between');
});
