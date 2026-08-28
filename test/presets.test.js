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

test('system audio is captured unprocessed and in stereo', () => {
    // `audio: true` accepted the engine's defaults, and those defaults are written for a
    // microphone: AEC subtracts the very thing a loopback capture is capturing, NS treats
    // sustained music as noise and gates it, AGC flattens a film's dynamic range. It is
    // most of what "the stream sounds terrible" meant.
    const { audio } = screenShareSettings({}).constraints;
    assert.notEqual(audio, true, 'the engine must not be left to pick voice defaults');
    assert.equal(audio.echoCancellation, false);
    assert.equal(audio.noiseSuppression, false);
    assert.equal(audio.autoGainControl, false);
    assert.equal(audio.channelCount, 2, 'a system mix is stereo; a silent downmix loses half of it');
});

test('the camera ladder follows the chosen resolution', () => {
    // A 1080p capture squeezed into a 720p budget looks worse than 720p, so picking
    // "sharper, heavier" used to make the picture softer.
    assert.equal(cameraEncodings({ res: '1080' }).at(-1).maxBitrate, 2_500_000);
    assert.equal(cameraEncodings({ res: '720' }).at(-1).maxBitrate, 1_800_000);
    assert.equal(cameraEncodings({}).length, 3, 'three rungs for the SFU to choose between');
});

test('the tie-breaker also decides which layer the SFU can drop', () => {
    // A single-layer share means one slow viewer drags the encoder down for everybody,
    // because there is no smaller rung to move them to. K-SVC carries several layers in
    // one stream so the SFU can hand each viewer what their link affords.
    //
    // 'detail' (text, code, a spreadsheet) keeps resolution and spends temporal layers:
    // a starved viewer gets 1080p at a few frames a second, which is still readable.
    // 'motion' (games) spends spatial layers instead: smaller, but still smooth.
    assert.equal(screenShareSettings({ prefer: 'detail' }).encodings[0].scalabilityMode, 'L2T3_KEY');
    assert.equal(screenShareSettings({ prefer: 'motion' }).encodings[0].scalabilityMode, 'L3T3_KEY');
});
