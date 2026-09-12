// Share and camera presets: two choices in, everything a share needs out.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    screenShareSettings, bestFitFramerate, cameraConstraints, cameraEncodings,
    SHARE_QUALITIES, SHARE_CONTENT, DEFAULT_SHARE_QUALITY, DEFAULT_SHARE_CONTENT,
    CAPTURE_FPS_CEILING, normaliseShareChoice, legacyShareChoice,
} from '../src/media/presets.js';

test('each quality caps the capture size and sets the video budget', () => {
    // The web app's ladder, plus Source. The numbers are what a viewer actually receives,
    // so they are pinned rather than left to drift.
    for (const [quality, width, bitrate] of [
        ['720p', 1280, 2_500_000],
        ['1080p', 1920, 5_000_000],
        ['1440p', 2560, 8_000_000],
    ]) {
        const p = screenShareSettings({ quality });
        assert.equal(p.constraints.video.width.max, width, quality);
        assert.equal(p.constraints.video.width.ideal, undefined, `${quality}: a ceiling, never a target to scale up to`);
        assert.equal(p.encodings[0].maxBitrate, bitrate, quality);
    }
});

test('the content type sets the rate and the tie-breaker', () => {
    const video = screenShareSettings({ content: 'video' });
    assert.equal(video.encodings[0].maxFramerate, 60, 'the rate is the encoder\'s business');
    assert.equal(video.targetFramerate, 60, 'and voice.js snaps against it');
    assert.equal(video.contentHint, 'motion', 'a game keeps its frame rate');

    const text = screenShareSettings({ content: 'text' });
    assert.equal(text.encodings[0].maxFramerate, 30);
    assert.equal(text.contentHint, 'text', 'a document keeps its glyphs sharp');
});

test('no choice caps the CAPTURE at its own rate', () => {
    // This is the stuttering-game fix, and the thing most likely to be undone by accident.
    // A per-choice max here makes Chromium run the desktop capturer on a fixed-interval
    // timer, and a source that does not divide into that interval lands its frames either
    // side of the tick — 70 fps into a 30 Hz grid is a 2-1-2-1 stagger with nothing lost to
    // the network at all. The ceiling belongs to the machine, not to the quality picked.
    for (const quality of Object.keys(SHARE_QUALITIES)) {
        for (const content of Object.keys(SHARE_CONTENT)) {
            const { video } = screenShareSettings({ quality, content }).constraints;
            assert.equal(video.frameRate.max, CAPTURE_FPS_CEILING, `${quality}/${content}`);
            assert.equal(video.frameRate.ideal, undefined, `${quality}/${content}: for display capture, ideal caps too`);
        }
    }
});

test('source imposes no size', () => {
    const p = screenShareSettings({ quality: 'source', content: 'video' });
    assert.equal(p.constraints.video.width, undefined);
    assert.equal(p.constraints.video.height, undefined);
    assert.equal(p.encodings[0].maxBitrate, 8_000_000);
    assert.equal(p.encodings[0].maxFramerate, 60, 'but the content type still decides the rate');
});

test('every tier and content type can be rendered, and says what it is', () => {
    // The chooser draws straight from these tables, so a missing title is a blank card.
    for (const [key, entry] of [...Object.entries(SHARE_QUALITIES), ...Object.entries(SHARE_CONTENT)]) {
        assert.ok(entry.title && entry.sub, `${key} needs a title and a description`);
    }
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

test('an unknown choice falls back to the defaults rather than breaking the share', () => {
    // The choice is remembered on disk. A value from an older or newer build must still
    // produce a working share.
    const p = screenShareSettings({ quality: 'nope', content: 'nonsense' });
    assert.equal(p.encodings[0].maxBitrate, SHARE_QUALITIES[DEFAULT_SHARE_QUALITY].maxBitrate);
    assert.equal(p.contentHint, SHARE_CONTENT[DEFAULT_SHARE_CONTENT].contentHint);
    assert.deepEqual(p.choice, { quality: DEFAULT_SHARE_QUALITY, content: DEFAULT_SHARE_CONTENT });
    assert.deepEqual(normaliseShareChoice(), { quality: '1080p', content: 'video' }, 'the web app\'s defaults');
    // Prototype keys are not tiers.
    assert.deepEqual(normaliseShareChoice({ quality: 'toString', content: '__proto__' }),
        { quality: '1080p', content: 'video' });
});

test('the old settings carry over to the chooser once', () => {
    for (const [streamPreset, streamPrefer, expected] of [
        ['720p30', 'detail', { quality: '720p', content: 'text' }],
        ['1080p30', 'detail', { quality: '1080p', content: 'text' }],
        ['1080p30', 'motion', { quality: '1080p', content: 'video' }],
        ['1080p60', 'detail', { quality: '1080p', content: 'video' }],   // the games preset
        ['source', null, { quality: 'source', content: 'text' }],
        ['something-else', 'motion', { quality: '1080p', content: 'video' }],
    ]) {
        assert.deepEqual(legacyShareChoice({ streamPreset, streamPrefer }), expected,
            `${streamPreset}/${streamPrefer}`);
    }
    assert.equal(legacyShareChoice({}), null, 'nothing ever chosen is not the same as the default');
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
    for (const content of Object.keys(SHARE_CONTENT)) {
        const { encodings } = screenShareSettings({ content });
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
