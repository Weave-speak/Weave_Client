// The animated room background.
//
// This is ported code, and the value of a port is that it behaves like the original. The
// tests below pin the behaviours that are actually load-bearing — one strand per person,
// fade in and out, a pace that eases rather than jumps, and a loop that genuinely stops —
// rather than the exact pixels, which are the animation's business.

import test from 'node:test';
import assert from 'node:assert/strict';

import { WeaveBackground, createMessageNoise, voiceNoise } from '../src/ui/weave-background.js';
import { userHue, avatarColour } from '../src/ui/hue.js';

/** A 2D context that records what was asked of it. */
function fakeCtx() {
    const calls = { stroke: 0, clearRect: 0, strokeStyles: [], shadowColors: [], lineWidths: [] };
    return {
        calls,
        setTransform() {},
        clearRect() { calls.clearRect += 1; },
        save() {}, restore() {},
        beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {
            calls.stroke += 1;
            calls.strokeStyles.push(this.strokeStyle);
            calls.shadowColors.push(this.shadowColor);
            calls.lineWidths.push(this.lineWidth);
        },
    };
}

function fakeCanvas({ w = 800, h = 600 } = {}) {
    const ctx = fakeCtx();
    return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx, ctx };
}

/** A document whose visibility the test controls, and whose listeners it can fire. */
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

/**
 * A background wired to a manual clock.
 *
 * `step(ms)` runs exactly one frame, so a test can say "half a second passed" without a
 * timer and without flake.
 */
function harness({ getState, reduceMotion = false, w, h } = {}) {
    const canvas = fakeCanvas({ w, h });
    const doc = fakeDocument();
    let pending = null;
    let handle = 0;
    let clock = 1000;

    const bg = new WeaveBackground(canvas, {
        getState,
        reduceMotion,
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
            return bg;
        },
        run(frames, ms = 16) { for (let i = 0; i < frames; i++) this.step(ms); return bg; },
    };
}

const people = (...names) => names.map((id) => ({ id, hue: userHue(id) }));

test('a hue is stable for a name and differs between names', () => {
    // Stability is the whole point: everyone must see the same person in the same colour,
    // on every client, with nothing stored and nothing synchronised.
    assert.equal(userHue('ghostbyte'), userHue('ghostbyte'));
    assert.notEqual(userHue('ghostbyte'), userHue('kestrel'));
    for (const n of ['a', 'ghostbyte', 'vaporwave_dan', '', 'Ω']) {
        const h = userHue(n);
        assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `${n} -> ${h}`);
    }
    assert.match(avatarColour('ghostbyte'), /^hsl\(\d+, 55%, 40%\)$/);
});

test('one strand per person in the room', () => {
    const h = harness({ getState: () => ({ participants: people('a', 'b', 'c'), noise: 0 }) });
    h.bg.start();
    h.run(30);
    assert.equal(h.bg.order.length, 3);
    assert.deepEqual([...h.bg.strands.keys()], ['a', 'b', 'c']);
});

test('a newcomer fades in rather than appearing at full strength', () => {
    let roster = people('a');
    const h = harness({ getState: () => ({ participants: roster, noise: 0 }) });
    h.bg.start();
    // PRESENCE is an approach RATE, not a duration: 0.9 gives a time constant of about
    // 1.1s, so roughly 63% after that and asymptotically the rest. Two seconds is settled.
    h.run(125);
    assert.ok(h.bg.strands.get('a').present > 0.7, 'the first person should have settled');

    roster = people('a', 'b');
    h.step();
    const justArrived = h.bg.strands.get('b').present;
    assert.ok(justArrived > 0 && justArrived < 0.1, `expected a faint arrival, got ${justArrived}`);

    h.run(125);
    assert.ok(h.bg.strands.get('b').present > 0.7, 'and then to settle in');
});

test('a departure keeps being drawn while it fades, then retires', () => {
    let roster = people('a', 'b');
    const h = harness({ getState: () => ({ participants: roster, noise: 0 }) });
    h.bg.start();
    h.run(100);
    assert.equal(h.bg.order.length, 2);

    roster = people('a');
    h.step();
    // Still drawn. Someone leaving should be seen to leave.
    assert.equal(h.bg.order.length, 2);
    assert.ok(h.bg.strands.get('b').present > 0.5);

    h.run(400);
    assert.equal(h.bg.order.length, 1, 'a fully faded strand should be retired');
    assert.equal(h.bg.strands.has('b'), false, 'and its state released');
});

test('noise raises the pace gradually, not in one frame', () => {
    let noise = 0;
    const h = harness({ getState: () => ({ participants: people('a'), noise }) });
    h.bg.start();
    h.run(30);
    const idle = h.bg.spd;

    noise = 1;
    h.step();
    const afterOneFrame = h.bg.spd;
    // PACE_EASE is 0.28 per second, so a single 16ms frame must barely move it. A jump here
    // would mean the field lurches the instant somebody speaks.
    assert.ok(afterOneFrame - idle < 0.005, `pace jumped by ${afterOneFrame - idle}`);

    h.run(600);
    assert.ok(h.bg.spd > idle * 2, `pace should have climbed, got ${h.bg.spd} from ${idle}`);
    assert.ok(h.bg.spd <= 0.65 + 1e-9, 'and stay within PACE_IDLE + PACE_GAIN');
});

test('noise is clamped, so a bad reading cannot run the animation away', () => {
    const h = harness({ getState: () => ({ participants: people('a'), noise: 99 }) });
    h.bg.start();
    h.run(2000);
    assert.ok(h.bg.effNoise <= 1 + 1e-9, `effNoise was ${h.bg.effNoise}`);
    assert.ok(h.bg.spd <= 0.65 + 1e-9);
});

test('reduced motion freezes the weave but still shows who is here', () => {
    const h = harness({ getState: () => ({ participants: people('a', 'b'), noise: 1 }), reduceMotion: true });
    h.bg.start();
    h.run(200);
    assert.equal(h.bg.phase, 0, 'phase must not advance');
    assert.equal(h.bg.drift, 0, 'nor the field drift');
    assert.equal(h.bg.order.length, 2, 'but the strands are still there');
    assert.ok(h.canvas.ctx.calls.stroke > 0, 'and still drawn');
});

test('each visible strand is drawn twice: a glow body and a bright core', () => {
    const h = harness({ getState: () => ({ participants: people('a', 'b'), noise: 0 }) });
    h.bg.start();
    h.run(120);
    const before = h.canvas.ctx.calls.stroke;
    h.step();
    assert.equal(h.canvas.ctx.calls.stroke - before, 4, 'two people, two passes each');

    const recent = h.canvas.ctx.calls.lineWidths.slice(-4);
    // The core is a constant hairline; the body is wider and widens further with noise.
    assert.deepEqual(recent.filter((v) => v === 1.8).length, 2);
    assert.ok(recent.filter((v) => v > 1.8).length === 2);
});

test('an empty room draws nothing and does not divide by zero', () => {
    const h = harness({ getState: () => ({ participants: [], noise: 0 }) });
    h.bg.start();
    h.run(50);
    assert.equal(h.bg.order.length, 0);
    assert.equal(h.canvas.ctx.calls.stroke, 0);
    assert.ok(Number.isFinite(h.bg.spd));
});

test('a zero-sized canvas is skipped, and the loop survives it', () => {
    // Happens for a frame or two while the room is still laying out.
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }), w: 0, h: 0 });
    h.bg.start();
    h.run(10);
    assert.equal(h.canvas.ctx.calls.stroke, 0);
    assert.ok(h.pending, 'the loop must still be scheduled');
});

test('a getState that throws costs one frame, not the animation', () => {
    let broken = true;
    const h = harness({
        getState: () => {
            if (broken) throw new Error('roster not ready');
            return { participants: people('a'), noise: 0 };
        },
    });
    h.bg.start();
    h.run(5);
    assert.ok(h.pending, 'still running');
    broken = false;
    h.run(60);
    assert.equal(h.bg.order.length, 1);
});

test('stop cancels the loop and clears the canvas', () => {
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }) });
    h.bg.start();
    h.run(20);
    assert.equal(h.bg.running, true);

    const clears = h.canvas.ctx.calls.clearRect;
    h.bg.stop();
    assert.equal(h.bg.running, false);
    assert.equal(h.pending, null);
    // A bare stop would freeze the last frame, which reads as a photograph of a live thing.
    assert.ok(h.canvas.ctx.calls.clearRect > clears, 'stop must clear');
});

test('hiding the tab suspends the loop, and showing it resumes', () => {
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }) });
    h.bg.start();
    h.run(10);
    assert.equal(h.bg.running, true);

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    assert.equal(h.bg.running, false, 'a hidden tab must not burn a core');

    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    assert.equal(h.bg.running, true);
});

test('a tab shown after an explicit stop stays stopped', () => {
    // Visibility must not override the caller. This is the "static background" preference,
    // and a preference that un-sets itself when you alt-tab is not a preference.
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }) });
    h.bg.start();
    h.run(5);
    h.bg.stop();

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    h.doc.hidden = false;
    h.doc.fire('visibilitychange');

    assert.equal(h.bg.running, false);
});

test('starting twice does not run two loops', () => {
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }) });
    h.bg.start();
    const first = h.pending;
    h.bg.start();
    assert.equal(h.pending, first, 'the second start must be a no-op');
});

test('destroy releases the visibility listener', () => {
    const h = harness({ getState: () => ({ participants: people('a'), noise: 0 }) });
    h.bg.start();
    assert.equal(h.doc.count('visibilitychange'), 1);
    h.bg.destroy();
    assert.equal(h.doc.count('visibilitychange'), 0);
    assert.equal(h.bg.running, false);
});

test('message noise rises with traffic and decays out of the window', () => {
    const n = createMessageNoise({ windowMs: 20000, fullRate: 30 });
    const t = 100000;
    assert.equal(n.value(t), 0);

    for (let i = 0; i < 10; i++) n.record(t + i * 100);
    // 10 messages in a 20s window is 30/min, which the original treats as full.
    assert.equal(n.value(t + 1000), 1);

    // Once they age out of the window the room reads as quiet again.
    assert.equal(n.value(t + 30000), 0);
});

test('message noise resets on a room switch', () => {
    const n = createMessageNoise();
    const t = 100000;
    for (let i = 0; i < 10; i++) n.record(t);
    assert.ok(n.value(t) > 0);
    n.reset();
    assert.equal(n.value(t), 0, 'a new room must not inherit the old one’s pace');
});

test('voice noise favours the loudest speaker over the room average', () => {
    // One person talking in a room of eight must register. Averaging alone would bury them.
    assert.equal(voiceNoise([]), 0);
    assert.ok(voiceNoise([0.9, 0, 0, 0, 0, 0, 0, 0]) >= 0.9);
    assert.ok(voiceNoise([0.3, 0.3, 0.3]) > 0.3, 'a whole room murmuring counts for more than one');
    assert.ok(voiceNoise([1, 1, 1]) <= 1, 'and it is clamped');
});
