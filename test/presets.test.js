// Stream and camera presets: two settings in, everything a share needs out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { screenShareSettings, cameraConstraints, STREAM_PRESETS } from '../src/media/presets.js';

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
