// The frame gate, and the two canvases that draw through it.
//
// The bug this pins was invisible on the machine it was written on: rAF fires at the
// display's rate, so a renderer that "draws sixty times a second" drew a hundred and eighty
// on a 180 Hz monitor. The tests therefore feed frames at display rates rather than at
// sixteen milliseconds, which is the only way the difference shows.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameGate } from '../src/ui/frame-gate.js';
import { WeaveBackground } from '../src/ui/weave-background.js';
import { LoomRenderer } from '../src/ui/loom.js';
import { motionPlan, BACKGROUND_FPS, BACKGROUND_UNFOCUSED_FPS, LOOM_FPS } from '../src/room/motion.js';

/** How many of one second's frames a gate lets through, at a display rate. */
function drawnPerSecond(gate, displayHz) {
    let drawn = 0;
    for (let i = 0; i < displayHz; i++) if (gate.due(5000 + (i * 1000) / displayHz)) drawn += 1;
    return drawn;
}

test('an uncapped gate lets every frame through', () => {
    assert.equal(drawnPerSecond(createFrameGate(0), 180), 180);
    assert.equal(drawnPerSecond(createFrameGate(), 60), 60);
});

test('a cap holds on a fast display and costs nothing on a slow one', () => {
    for (const hz of [120, 144, 165, 180, 240]) {
        const drawn = drawnPerSecond(createFrameGate(60), hz);
        assert.ok(drawn <= 61, `${hz} Hz drew ${drawn}`);
        assert.ok(drawn >= 45, `${hz} Hz drew only ${drawn}; the cap must not halve itself`);
    }
    // The slack is what this line is about: frames 16.67 ms apart must all pass a cap of 60.
    assert.equal(drawnPerSecond(createFrameGate(60), 60), 60);
    assert.equal(drawnPerSecond(createFrameGate(30), 60), 30);
});

test('the cap can be changed while running, and a clock that restarts does not stall it', () => {
    const gate = createFrameGate(30);
    assert.equal(gate.due(1000), true);
    assert.equal(gate.due(1010), false);
    gate.setMaxFps(0);
    assert.equal(gate.due(1011), true, 'lifting the cap applies to the very next frame');
    gate.setMaxFps(30);
    assert.equal(gate.due(5), true, 'time running backwards draws rather than waiting to catch up');
    gate.reset();
    assert.equal(gate.due(6), true, 'and the first frame after a reset always draws');
});

/** A canvas whose context counts the clears — one per frame actually drawn. */
function countingCanvas() {
    const calls = { clearRect: 0 };
    const noop = () => {};
    const ctx = new Proxy({ calls }, {
        get(target, key) {
            if (key in target) return target[key];
            if (key === 'clearRect') return () => { calls.clearRect += 1; };
            if (key === 'createLinearGradient') return () => ({ addColorStop: noop });
            return noop;
        },
        set(target, key, value) { target[key] = value; return true; },
    });
    return { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: () => ctx, calls };
}

/** Drive a renderer for one second of a display running at `hz`. */
function runForASecond(make, hz) {
    const canvas = countingCanvas();
    let pending = null;
    const renderer = make(canvas, {
        document: { hidden: false, addEventListener() {}, removeEventListener() {} },
        reduceMotion: false,
        raf: (fn) => { pending = fn; return 1; },
        cancelRaf: () => { pending = null; },
    });
    renderer.start();
    for (let i = 0; i < hz; i++) {
        const fn = pending;
        pending = null;
        fn?.(1000 + (i * 1000) / hz);
    }
    return { renderer, frames: canvas.calls.clearRect, stillScheduled: Boolean(pending) };
}

test('the room background draws at its cap however fast the display is', () => {
    const people = [{ id: 'a', hue: 10 }, { id: 'b', hue: 200 }];
    const make = (maxFps) => (canvas, opts) => new WeaveBackground(canvas, {
        ...opts, maxFps, getState: () => ({ participants: people, noise: 0.5 }),
    });

    const uncapped = runForASecond(make(0), 180);
    assert.equal(uncapped.frames, 180, 'the original behaviour, and what a hand-stepped test still gets');

    const capped = runForASecond(make(BACKGROUND_FPS), 180);
    assert.ok(capped.frames <= BACKGROUND_FPS + 1, `drew ${capped.frames}`);
    assert.ok(capped.frames >= BACKGROUND_FPS - 6, `drew only ${capped.frames}`);
    assert.ok(capped.stillScheduled, 'a declined frame must still ask for the next one');
});

test('a capped background moves as far in a second as an uncapped one', () => {
    // The step is measured from the last frame DRAWN, so skipping frames must not slow the
    // weave down — only make it take fewer, larger steps.
    const make = (maxFps) => (canvas, opts) => new WeaveBackground(canvas, {
        ...opts, maxFps, getState: () => ({ participants: [{ id: 'a', hue: 10 }], noise: 0 }),
    });
    const every = runForASecond(make(0), 180).renderer.drift;
    const capped = runForASecond(make(BACKGROUND_FPS), 180).renderer.drift;
    const slowest = runForASecond(make(BACKGROUND_UNFOCUSED_FPS), 180).renderer.drift;
    assert.ok(Math.abs(capped - every) / every < 0.06, `${capped} against ${every}`);
    assert.ok(Math.abs(slowest - every) / every < 0.08, `${slowest} against ${every}`);
});

test('the loom reads its voices once per frame drawn, not once per display frame', () => {
    // Reading the voices is what steps the traces, and they decay per frame at a rate tuned
    // for sixty. Uncapped on a fast display, a pluck was spent in a third of the time.
    let reads = 0;
    const make = (canvas, opts) => new LoomRenderer(canvas, {
        ...opts,
        maxFps: LOOM_FPS,
        getVoices: () => { reads += 1; return [{ id: 'a', hue: 10, level: 0.4, pluck: 0 }]; },
    });
    const { frames } = runForASecond(make, 180);
    assert.equal(reads, frames);
    assert.ok(reads <= LOOM_FPS + 1 && reads >= LOOM_FPS - 6, `read ${reads} times`);
});

test('the animations stop for the preference, for fullscreen, and for a window nobody can see', () => {
    assert.equal(motionPlan().run, true);
    assert.equal(motionPlan({ staticBackground: true }).run, false);
    assert.equal(motionPlan({ fullscreen: true }).run, false);
    assert.equal(motionPlan({ windowVisible: false }).run, false);
    // Unfocused is not unseen: Weave on a second monitor beside a game is being looked at.
    assert.equal(motionPlan({ windowFocused: false }).run, true);
});

test('losing focus slows the background and leaves the loom alone', () => {
    const front = motionPlan({ windowFocused: true });
    const behind = motionPlan({ windowFocused: false });
    assert.equal(front.backgroundFps, BACKGROUND_FPS);
    assert.equal(behind.backgroundFps, BACKGROUND_UNFOCUSED_FPS);
    assert.ok(behind.backgroundFps < front.backgroundFps);
    // Twenty is a floor: below it the background's 50 ms step clamp would run it slow.
    assert.ok(BACKGROUND_UNFOCUSED_FPS >= 20);
    assert.equal(behind.loomFps, front.loomFps);
    assert.equal(front.loomFps, 60, 'the rate the voice traces were tuned at');
});
