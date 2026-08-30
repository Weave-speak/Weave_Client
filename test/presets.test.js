// Stream and camera presets: two settings in, everything a share needs out.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    screenShareSettings, bestFitFramerate, cameraConstraints, cameraEncodings,
    STREAM_PRESETS, CAPTURE_FPS_CEILING,
} from '../src/media/presets.js';

test('a preset caps size and budget, and asks the ENCODER for its rate', () => {
    const p = screenShareSettings({ preset: '1080p60' });
    assert.equal(p.constraints.video.width.max, 1920);
    assert.equal(p.encodings[0].maxBitrate, 6_000_000);
    assert.equal(p.encodings[0].maxFramerate, 60, 'the rate is the encoder\'s business now');
    assert.equal(p.targetFramerate, 60, 'and voice.js snaps against it');
});

test('no preset caps the CAPTURE at its own rate', () => {
    // This is the stuttering-game fix, and the thing most likely to be undone by accident.
    // A per-preset max here makes Chromium run the desktop capturer on a fixed-interval
    // timer, and a source that does not divide into that interval lands its frames either
    // side of the tick — 70 fps into a 30 Hz grid is a 2-1-2-1 stagger with nothing lost to
    // the network at all. The ceiling belongs to the machine, not to the quality picked.
    for (const preset of Object.keys(STREAM_PRESETS)) {
        const { video } = screenShareSettings({ preset }).constraints;
        assert.equal(video.frameRate.max, CAPTURE_FPS_CEILING, preset);
        assert.equal(video.frameRate.ideal, undefined, preset + ': for display capture, ideal caps too');
    }
});

test('source imposes no size and no rate at all', () => {
    const p = screenShareSettings({ preset: 'source' });
    assert.equal(p.constraints.video.width, undefined);
    assert.equal(p.encodings[0].maxBitrate, 8_000_000);
    assert.equal(p.encodings[0].maxFramerate, undefined, '"as it is" means as it is');
    assert.equal(p.targetFramerate, null);
});

test('the chosen rate snaps to a cadence the source divides into', () => {
    // Dividing the source by a whole number is the whole idea: every streamed frame is then
    // exactly n source frames, so the spacing is even. Rounding to the NEAREST divisor rather
    // than down is deliberate — 70 against a 30 budget gives 35, slightly over and perfectly
    // smooth, where 23.3 would be under budget and visibly worse.
    for (const [source, target, expected] of [
        [70, 30, 35],
        [60, 30, 30],
        [144, 30, 28.8],
        [75, 30, 25],
        [50, 30, 25],
        [144, 60, 72],
    ]) {
        assert.equal(bestFitFramerate(source, target), expected, `${source} against ${target}`);
    }
});

test('a source already within budget is left alone rather than resampled', () => {
    // A 24 fps film never threatened a 30 fps budget, and halving it to "respect" one would
    // be the same judder this whole change exists to remove.
    assert.equal(bestFitFramerate(24, 30), null);
    assert.equal(bestFitFramerate(30, 30), null);
    assert.equal(bestFitFramerate(70, null), null, 'a preset naming no rate caps nothing');
});

test('an unsettled stat falls back to the chosen rate, not to nonsense', () => {
    // framesPerSecond is absent for the first second or so of a share. Dividing by it gives
    // Infinity, and reading it as "no cap" would spend the budget before anyone knows what
    // the source is doing.
    for (const bad of [0, NaN, undefined, null, -5, 'nope']) {
        assert.equal(bestFitFramerate(bad, 30), 30, String(bad));
    }
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

    // opusStereo has been set on the codec for releases while the capture never asked for
    // two channels, so the stereo was only ever nominal. It is inert while the AEC downmix
    // wins and correct for free the moment per-application capture exists.
    assert.equal(audio.channelCount.ideal, 2, 'ask the capture for what the codec is told');
    assert.equal(audio.channelCount.exact, undefined, 'exact here kills the share outright');
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
