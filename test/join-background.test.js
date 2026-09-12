// The sign-in background.
//
// Strings that pluck themselves at random are hard to test by looking at pixels and easy
// to test by looking at behaviour, so that is what is pinned: eleven strings; they are
// struck at different moments rather than in unison; every one of them keeps being struck;
// a pluck dies away; and nothing moves for somebody who asked for stillness. Randomness is
// seeded, so each of those is the same run every time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { JoinBackground } from '../src/ui/join-background.js';

/** A 2D context that records what was asked of it. */
function fakeCtx() {
    const calls = { stroke: 0, clearRect: 0, lineWidths: [], lines: [] };
    return {
        calls,
        setTransform() {},
        clearRect() { calls.clearRect += 1; },
        save() {}, restore() {},
        beginPath() {}, moveTo() {},
        lineTo(x, y) { calls.lines.push([x, y]); },
        stroke() {
            calls.stroke += 1;
            calls.lineWidths.push(this.lineWidth);
        },
    };
}

function fakeCanvas({ w = 1000, h = 700 } = {}) {
    const ctx = fakeCtx();
    return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx, ctx };
}

function fakeDocument() {
    const listeners = new Map();
    return {
        hidden: false,
        addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
        removeEventListener: (t, fn) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
        fire: (t) => { for (const fn of listeners.get(t) ?? []) fn(); },
        count: (t) => (listeners.get(t) ?? []).length,
    };
}

/** A small deterministic generator (mulberry32), so a "random" run is the same run every time. */
function seeded(seed = 42) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function harness({ reduceMotion = false, w, h, seed } = {}) {
    const canvas = fakeCanvas({ w, h });
    const doc = fakeDocument();
    let pending = null;
    let handle = 0;
    let clock = 5000;

    const bg = new JoinBackground(canvas, {
        reduceMotion,
        random: seeded(seed),
        document: doc,
        raf: (fn) => { pending = fn; return ++handle; },
        cancelRaf: () => { pending = null; },
    });

    return {
        bg, canvas, doc,
        get pending() { return pending; },
        step(ms = 16) {
            clock += ms;
            const fn = pending;
            pending = null;
            if (fn) fn(clock);
        },
        run(frames, ms = 16) { for (let i = 0; i < frames; i++) this.step(ms); },
        /** Jump the wall clock without running a frame: the window was away. */
        away(ms) { clock += ms; },
    };
}

test('eleven strings, each a glow body and a bright core, across a warp', () => {
    const h = harness({ w: 1000 });
    h.bg.start();
    h.step();

    assert.equal(h.bg.strings.length, 11);
    // The warp: one hairline every 34px across 1000px, starting half a step in.
    const warp = Math.ceil((1000 - 17) / 34);
    assert.equal(h.canvas.ctx.calls.stroke, warp + 11 * 2);
});

test('the strings are a rainbow, not one colour', () => {
    const h = harness();
    h.bg.start();
    h.step();
    const hues = new Set(h.bg.strings.map((s) => s.hue));
    assert.equal(hues.size, 11, 'every string its own hue');
});

test('strings are struck at different moments, not in unison', () => {
    // Eleven strings plucked together is a chord, and a chord on a timer is a metronome.
    // The whole effect is that you cannot tell which string will go next.
    const h = harness();
    h.bg.start();

    const strikesPerFrame = [];
    for (let f = 0; f < 60 * 6; f++) {
        const before = h.bg.plucks;
        h.step();
        strikesPerFrame.push(h.bg.plucks - before);
    }

    const struck = h.bg.strings.filter((s) => s.struck > 0).length;
    assert.ok(struck >= 9, `after six seconds most strings should have sounded, got ${struck}`);
    assert.ok(Math.max(...strikesPerFrame) <= 3,
        `no frame should strike more than a few strings at once, got ${Math.max(...strikesPerFrame)}`);
});

test('no string is struck once and then left silent', () => {
    const h = harness({ seed: 7 });
    h.bg.start();
    h.run(60 * 30);   // half a minute

    for (const [i, s] of h.bg.strings.entries()) {
        // A string rests 0.8–3.0 s between plucks, so thirty seconds is at least ten.
        assert.ok(s.struck >= 8, `string ${i} sounded only ${s.struck} times in thirty seconds`);
    }
});

test('a pluck dies away on its own', () => {
    const h = harness();
    h.bg.start();

    // Run until something is struck, then watch that string with nothing new arriving.
    let target = -1;
    for (let f = 0; f < 600 && target < 0; f++) {
        h.step();
        target = h.bg.strings.findIndex((s) => s.pluck > 0.6);
    }
    assert.ok(target >= 0, 'something should have been struck within ten seconds');

    const st = h.bg.strings[target];
    st.next = Infinity;   // hold off its next pluck, so only the decay is measured
    const struckAt = st.pluck;
    h.run(90);
    assert.ok(st.pluck < struckAt * 0.1, `a pluck should be mostly gone after 1.5s: ${st.pluck}`);
    assert.ok(st.level < 0.1, `and so should its swell: ${st.level}`);
});

test('coming back to the window does not strike every string at once', () => {
    // Every string waits for a moment on the clock. After a long absence all of those
    // moments are in the past, and the original struck all eleven on the frame it returned.
    const h = harness();
    h.bg.start();
    h.run(120);

    h.away(10 * 60 * 1000);   // ten minutes in another window
    const before = h.bg.plucks;
    h.step();
    assert.ok(h.bg.plucks - before <= 2,
        `returning struck ${h.bg.plucks - before} strings on one frame`);
});

test('reduced motion: the tapestry is there, and nothing moves', () => {
    const h = harness({ reduceMotion: true });
    h.bg.start();

    const frame = () => {
        h.canvas.ctx.calls.lines.length = 0;
        h.step();
        return JSON.stringify(h.canvas.ctx.calls.lines);
    };
    const first = frame();
    h.run(600);   // ten seconds

    assert.equal(h.bg.plucks, 0, 'a string that plucks itself is the motion that was declined');
    assert.equal(frame(), first, 'identical frame to frame');
    assert.ok(h.canvas.ctx.calls.stroke > 0, 'and still drawn');
});

test('stop halts the loop and clears the canvas', () => {
    const h = harness();
    h.bg.start();
    h.run(10);
    const cleared = h.canvas.ctx.calls.clearRect;

    h.bg.stop();
    assert.equal(h.bg.running, false);
    assert.equal(h.pending, null);
    assert.ok(h.canvas.ctx.calls.clearRect > cleared, 'a bare stop would freeze a string mid-bounce');
});

test('a hidden window suspends the loop, and showing it resumes', () => {
    const h = harness();
    h.bg.start();

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    assert.equal(h.bg.running, false);

    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    assert.ok(h.bg.running);
});

test('an explicit stop survives the window being shown again', () => {
    // "Still background" is a choice; returning to the window is not a request to undo it.
    const h = harness();
    h.bg.start();
    h.bg.stop();
    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    assert.equal(h.bg.running, false);
});

test('starting twice does not run two loops, and destroy releases the listener', () => {
    const h = harness();
    h.bg.start();
    const first = h.pending;
    h.bg.start();
    assert.equal(h.pending, first);

    assert.equal(h.doc.count('visibilitychange'), 1);
    h.bg.destroy();
    assert.equal(h.doc.count('visibilitychange'), 0);
    assert.equal(h.bg.running, false);
});

test('a zero-sized canvas is skipped, and the loop survives it', () => {
    // The first frame can arrive before layout, in which case there is nothing to draw on.
    const h = harness({ w: 0, h: 0 });
    h.bg.start();
    h.run(3);
    assert.equal(h.canvas.ctx.calls.stroke, 0);
    assert.ok(h.pending);
});
