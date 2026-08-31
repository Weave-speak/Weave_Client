// The crop arithmetic.
//
// Worth testing on its own precisely because the failure is quiet: an off-by-one in the
// source rectangle produces a saved picture that sits a few pixels away from what was
// framed, which nobody notices until they compare the two side by side.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    minimumScale, clampOffset, centredOffset, sourceRect, zoomAbout, MAX_ZOOM,
} from '../src/settings/avatar-crop.js';

const FRAME = 200;

test('the smallest scale COVERS the frame rather than fitting inside it', () => {
    // A wide picture is limited by its height, a tall one by its width. Taking the smaller
    // ratio would fit the whole picture in and leave a ring of background inside the
    // circle, which reads as a broken image rather than as a considered crop.
    assert.equal(minimumScale({ width: 400, height: 200, frame: FRAME }), 1);
    assert.equal(minimumScale({ width: 200, height: 400, frame: FRAME }), 1);
    assert.equal(minimumScale({ width: 100, height: 100, frame: FRAME }), 2);

    // Nothing divides by zero on an image that has not loaded yet.
    assert.equal(minimumScale({ width: 0, height: 0, frame: FRAME }), 1);
});

test('the picture cannot be dragged off the frame', () => {
    const at = (x, y) => clampOffset({ x, y, width: 400, height: 300, scale: 1, frame: FRAME });

    // Flung far right and far down: stops with the picture's edge at the frame's edge.
    assert.deepEqual(at(500, 500), { x: 0, y: 0 });
    // Flung the other way: stops when the far edge arrives.
    assert.deepEqual(at(-9999, -9999), { x: -200, y: -100 });
    // Somewhere legitimate in the middle is left alone.
    assert.deepEqual(at(-50, -25), { x: -50, y: -25 });
});

test('a picture exactly the size of the frame has exactly one position', () => {
    const clamped = clampOffset({ x: 40, y: -40, width: 200, height: 200, scale: 1, frame: FRAME });
    assert.deepEqual(clamped, { x: 0, y: 0 });
});

test('a picture opens centred, not in its top-left corner', () => {
    const offset = centredOffset({ width: 400, height: 300, scale: 1, frame: FRAME });
    assert.deepEqual(offset, { x: -100, y: -50 });

    // And centring is consistent with the clamp: the starting position is always legal.
    assert.deepEqual(clampOffset({ ...offset, width: 400, height: 300, scale: 1, frame: FRAME }), offset);
});

test('the source rectangle is the part of the ORIGINAL the frame is showing', () => {
    // Centred, unscaled, on a 400x300: the frame shows the middle 200x200.
    const rect = sourceRect({ width: 400, height: 300, scale: 1, x: -100, y: -50, frame: FRAME });
    assert.deepEqual(rect, { sx: 100, sy: 50, size: 200 });

    // Zoomed to 2x, the frame covers half as much of the original.
    const zoomed = sourceRect({ width: 400, height: 300, scale: 2, x: -200, y: -100, frame: FRAME });
    assert.equal(zoomed.size, 100);
    assert.deepEqual([zoomed.sx, zoomed.sy], [100, 50]);
});

test('the source rectangle never leaves the image, whatever it is handed', () => {
    const rect = sourceRect({ width: 300, height: 300, scale: 1, x: 9999, y: 9999, frame: FRAME });
    assert.ok(rect.sx >= 0 && rect.sy >= 0);
    assert.ok(rect.sx + rect.size <= 300);
    assert.ok(rect.sy + rect.size <= 300);
});

test('zooming holds the centre of the frame still', () => {
    const start = { width: 400, height: 400, frame: FRAME, scale: 1, x: -100, y: -100 };

    // What sits under the middle of the frame before the zoom...
    const before = sourceRect(start);
    const middleBefore = before.sx + before.size / 2;

    const after = zoomAbout({ ...start, next: 2 });
    const rect = sourceRect({ ...start, scale: after.scale, x: after.x, y: after.y });
    const middleAfter = rect.sx + rect.size / 2;

    assert.ok(Math.abs(middleBefore - middleAfter) < 0.001,
        'zooming about the corner walks the subject out of frame after a few notches');
});

test('zoom is bounded at both ends', () => {
    const base = { width: 400, height: 400, frame: FRAME, scale: 1, x: -100, y: -100 };

    // Never below "covers the frame" — that is what would let background show through.
    assert.equal(zoomAbout({ ...base, next: 0.01 }).scale, minimumScale(base));
    // And not past the ceiling, where an avatar is four enlarged pixels.
    assert.equal(zoomAbout({ ...base, next: 9999 }).scale, minimumScale(base) * MAX_ZOOM);
});

test('a zoomed picture is still clamped inside the frame', () => {
    const out = zoomAbout({
        width: 400, height: 400, frame: FRAME, scale: 1, x: 0, y: 0, next: 1.5,
    });
    const rect = sourceRect({ width: 400, height: 400, frame: FRAME, ...out });
    assert.ok(rect.sx >= 0 && rect.sy >= 0, 'no wedge of nothing inside the circle');
});
