// The window on a monitor it does not fit.
//
// Windows keeps a window's logical size across a change of scale, so a window dragged to a
// smaller or higher-scaled monitor can arrive bigger than it, with the self bar (and the
// share button in it) under the taskbar. These hold what gets corrected, and — as much to
// the point — what is left alone. Work areas below are the real ones: the resolution
// divided by the scale, less a 48px taskbar.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fitBounds, minimumSizeFor, MIN_SIZE } from '../electron/window-fit.js';

const inside = (b, area) => b.x >= area.x && b.y >= area.y
    && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;

// 1366×768 at 125%, the commonest laptop panel beside a desktop monitor.
const LAPTOP_125 = { x: 0, y: 0, width: 1093, height: 566 };

test('a window too big for the monitor it was dragged to is shrunk onto it', () => {
    // The launch's 1280×820 restore bounds, released near the top-left of the laptop.
    const fit = fitBounds({ x: 40, y: 30, width: 1280, height: 820 }, LAPTOP_125);
    assert.deepEqual(fit, { x: 0, y: 0, width: 1093, height: 566 });
    assert.ok(inside(fit, LAPTOP_125));
});

test('only the dimension that does not fit is changed', () => {
    // 1920×1080 at 150% is 1280×672 usable: wide enough for 1100, not tall enough for 900.
    const area = { x: 0, y: 0, width: 1280, height: 672 };
    const fit = fitBounds({ x: 100, y: 200, width: 1100, height: 900 }, area);
    assert.equal(fit.width, 1100, 'the width fitted and is kept');
    assert.equal(fit.height, 672);
    assert.equal(fit.x, 100, 'nor is it moved sideways when it did not need to be');
    assert.equal(fit.y, 0);
});

test('a window that fits is never touched, even hanging off an edge', () => {
    // Parked half off the right edge on purpose: it fits, so it can be dragged back by hand.
    assert.equal(fitBounds({ x: 900, y: 100, width: 800, height: 500 }, LAPTOP_125), null);
    // Exactly the size of the work area is a fit, not an overflow.
    assert.equal(fitBounds({ ...LAPTOP_125 }, LAPTOP_125), null);
});

test('a window stretched across two monitors is a choice, and is left alone', () => {
    // Two 1920×1080 at 100% side by side; the window spans the seam but each half fits the
    // height. getDisplayMatching gives the one with more of it — that display still holds
    // the window's height, so nothing is corrected.
    const left = { x: 0, y: 0, width: 1920, height: 1032 };
    assert.equal(fitBounds({ x: 1500, y: 100, width: 1000, height: 800 }, left), null);
});

test('a second monitor to the left, at negative coordinates', () => {
    // A 1366×768 @125% laptop placed LEFT of the primary: its work area starts at x=-1093.
    const area = { x: -1093, y: 202, width: 1093, height: 566 };
    const fit = fitBounds({ x: -1200, y: 150, width: 1280, height: 820 }, area);
    assert.deepEqual(fit, { x: -1093, y: 202, width: 1093, height: 566 });
});

test('a taskbar on the left or top offsets the work area, and the fit respects it', () => {
    const leftBar = { x: 62, y: 0, width: 1031, height: 614 };
    const fit = fitBounds({ x: 0, y: 0, width: 1280, height: 820 }, leftBar);
    assert.equal(fit.x, 62, 'never under a taskbar on the left');
    assert.ok(inside(fit, leftBar));

    const topBar = { x: 0, y: 48, width: 1093, height: 566 };
    assert.equal(fitBounds({ x: 0, y: 0, width: 1200, height: 900 }, topBar).y, 48);
});

test('a window pushed partly past the far edge is brought fully back once it is resized', () => {
    const fit = fitBounds({ x: 600, y: 300, width: 1280, height: 820 }, LAPTOP_125);
    assert.ok(inside(fit, LAPTOP_125), 'half a corrected window is the same complaint');
});

test('fractional work areas, as some scales produce, still give whole pixels', () => {
    const area = { x: 0, y: 0, width: 1097.6, height: 617.6 };
    const fit = fitBounds({ x: 10, y: 10, width: 1280, height: 820 }, area);
    for (const v of Object.values(fit)) assert.ok(Number.isInteger(v), `${v} is not a whole pixel`);
    assert.ok(fit.width <= area.width && fit.height <= area.height, 'rounded down, so it still fits');
});

test('the minimum size gives way to a display smaller than it', () => {
    assert.deepEqual(minimumSizeFor({ x: 0, y: 0, width: 1920, height: 1032 }), MIN_SIZE);
    // 1366×768 at 150%: 911×464 usable. A 480px minimum there meant even the smallest
    // Weave hung under the taskbar.
    assert.deepEqual(minimumSizeFor({ x: 0, y: 0, width: 911, height: 464 }), { width: 620, height: 464 });
    assert.deepEqual(minimumSizeFor({ x: 0, y: 0, width: 600, height: 400 }), { width: 600, height: 400 });
});
