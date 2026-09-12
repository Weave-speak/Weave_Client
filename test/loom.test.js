// The Loom, and the traces that feed it.
//
// This is ported code, and the value of a port is that it behaves like the original — so
// what is pinned below is what is load-bearing, not the pixels. A string per person, in the
// order the faces are in; louder draws thicker; each of the three modes is genuinely a
// different instrument rather than a palette; the rings go out when the music stops; and
// the loop survives everything a room can do to it.
//
// The traces get their own section. They are the one piece of genuinely new logic here —
// ten readings a second turned into sixty frames, with an onset bounce the media layer has
// no concept of — and they are pure, so they are tested as arithmetic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LoomRenderer, LOOM_MODES, DEFAULT_LOOM_MODE, idlePhase } from '../src/ui/loom.js';
import { createVoiceTrace, createVoiceTraces } from '../src/ui/voice-trace.js';
import { userHue } from '../src/ui/hue.js';

/** A 2D context that records what was asked of it. */
function fakeCtx() {
    const calls = {
        stroke: 0, fill: 0, clearRect: 0, arc: 0, gradients: 0,
        strokeStyles: [], lineWidths: [], shadowBlurs: [], moves: [], lines: [],
    };
    return {
        calls,
        setTransform() {},
        clearRect() { calls.clearRect += 1; },
        save() {}, restore() {},
        beginPath() {},
        moveTo(x, y) { calls.moves.push([x, y]); },
        lineTo(x, y) { calls.lines.push([x, y]); },
        quadraticCurveTo() {},
        arc() { calls.arc += 1; },
        fill() { calls.fill += 1; },
        createLinearGradient() {
            calls.gradients += 1;
            return { addColorStop() {} };
        },
        stroke() {
            calls.stroke += 1;
            calls.strokeStyles.push(this.strokeStyle);
            calls.lineWidths.push(this.lineWidth);
            calls.shadowBlurs.push(this.shadowBlur);
        },
    };
}

function fakeCanvas({ w = 240, h = 136 } = {}) {
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
 * A loom wired to a manual clock.
 *
 * `step(ms)` runs exactly one frame, so a test can say "a second passed" without a timer
 * and without flake.
 */
function harness({ getVoices = () => [], onRing, mode, reduceMotion = false, w, h } = {}) {
    const canvas = fakeCanvas({ w, h });
    const doc = fakeDocument();
    let pending = null;
    let handle = 0;
    let clock = 1000;

    const loom = new LoomRenderer(canvas, {
        mode, getVoices, onRing, reduceMotion,
        document: doc,
        raf: (fn) => { pending = fn; return ++handle; },
        cancelRaf: () => { pending = null; },
    });

    return {
        loom, canvas, doc,
        get ctx() { return canvas.ctx; },
        get pending() { return pending; },
        step(ms = 16) {
            clock += ms;
            const fn = pending;
            pending = null;
            if (fn) fn(clock);
            return loom;
        },
        run(frames, ms = 16) { for (let i = 0; i < frames; i++) this.step(ms); return loom; },
        /** Everything the last frame drew, with earlier frames discarded. */
        lastFrame(ms = 16) {
            const c = this.ctx.calls;
            c.stroke = 0; c.fill = 0; c.arc = 0; c.gradients = 0;
            c.strokeStyles.length = 0; c.lineWidths.length = 0; c.shadowBlurs.length = 0;
            c.moves.length = 0; c.lines.length = 0;
            this.step(ms);
            return c;
        },
    };
}

const voice = (id, level = 0, pluck = 0) => ({ id, hue: userHue(id), level, pluck });

/* ── the shape of a frame ─────────────────────────────────────────────────── */

test('one string per person, drawn as a glow body and a bright core', () => {
    // Two passes per string is what gives a thread a lit edge rather than a flat line —
    // the same two-pass idiom the channel background uses.
    const h = harness({ mode: 'harp', getVoices: () => [voice('a'), voice('b'), voice('c')] });
    h.loom.start();
    const frame = h.lastFrame();

    // Three strings at two passes each, plus harp's two rails.
    assert.equal(frame.stroke, 3 * 2 + 2);
    // Every string is drawn in the colour of the person it belongs to.
    for (const id of ['a', 'b', 'c']) {
        assert.ok(frame.strokeStyles.some((s) => s?.startsWith(`hsla(${userHue(id)},`)),
            `${id} has no string in their own hue`);
    }
});

test('a louder voice draws a thicker string', () => {
    const quiet = harness({ mode: 'harp', getVoices: () => [voice('a', 0.05)] });
    const loud = harness({ mode: 'harp', getVoices: () => [voice('a', 0.95)] });
    quiet.loom.start();
    loud.loom.start();

    const widest = (frame) => Math.max(...frame.lineWidths);
    assert.ok(widest(loud.lastFrame()) > widest(quiet.lastFrame()),
        'loudness has to be visible in the line itself, not only in the glow');
});

test('an empty room draws nothing and does not divide by zero', () => {
    const h = harness({ getVoices: () => [] });
    h.loom.start();
    h.run(5);
    assert.equal(h.ctx.calls.stroke, 0);
    assert.ok(h.pending, 'and the loop keeps running, ready for somebody to arrive');
});

test('a zero-sized canvas is skipped, and the loop survives it', () => {
    // The sidebar is laid out after the first paint, so the first frame genuinely can
    // arrive before the wrapper has a height.
    const h = harness({ w: 0, h: 0, getVoices: () => [voice('a')] });
    h.loom.start();
    h.run(3);
    assert.equal(h.ctx.calls.stroke, 0);
    assert.ok(h.pending);
});

test('a getVoices that throws costs one frame, not the animation', () => {
    let broken = true;
    const h = harness({ mode: 'harp', getVoices: () => { if (broken) throw new Error('roster'); return [voice('a')]; } });
    h.loom.start();
    h.run(2);
    assert.equal(h.ctx.calls.stroke, 0);

    broken = false;
    assert.ok(h.lastFrame().stroke > 0, 'the next frame draws as though nothing happened');
});

/* ── the three instruments ────────────────────────────────────────────────── */

test('each mode hangs its strings on its own scaffold', () => {
    const voices = () => [voice('a'), voice('b')];
    const frameFor = (mode) => {
        const h = harness({ mode, getVoices: voices });
        h.loom.start();
        return h.lastFrame();
    };

    // Two strings cost four strokes in every mode; the rest is the scaffold.
    const cloth = frameFor('cloth');
    const harp = frameFor('harp');
    const web = frameFor('web');

    // Harp is the sparest: two rails, and a coloured tuning peg per string.
    assert.equal(harp.stroke, 4 + 2);
    assert.equal(harp.fill, 2, 'a peg per string');
    assert.equal(harp.arc, 2);

    // Cloth hangs a warp and then re-paints it over the strings at alternating crossings,
    // which is the entire interlace illusion — so it strokes far more than it has strings.
    assert.ok(cloth.stroke > harp.stroke * 2, `cloth drew only ${cloth.stroke}`);
    assert.equal(cloth.fill, 0, 'cloth has no pegs');

    // Web lays five diagonals behind, and no pegs.
    assert.equal(web.stroke, 4 + 5);
    assert.equal(web.fill, 0);
});

test('web joins speakers to each other, and only while they are speaking', () => {
    const silent = harness({ mode: 'web', getVoices: () => [voice('a'), voice('b')] });
    silent.loom.start();
    assert.equal(silent.lastFrame().gradients, 0, 'a quiet room is not a conversation');

    const talking = harness({ mode: 'web', getVoices: () => [voice('a', 0.6), voice('b', 0.5), voice('c', 0.4)] });
    talking.loom.start();
    // Every pair of the three: a-b, a-c, b-c.
    assert.equal(talking.lastFrame().gradients, 3);
});

test('a mode can be swapped without restarting the animation', () => {
    const h = harness({ mode: 'cloth', getVoices: () => [voice('a')] });
    h.loom.start();
    h.run(3);
    const handle = h.pending;

    h.loom.setMode('harp');
    assert.equal(h.loom.mode, 'harp');
    assert.ok(h.pending === handle, 'the pending frame is the same one; nothing was torn down');

    // One string, two passes, plus harp's two rails — it really is drawing the other mode.
    assert.equal(h.lastFrame().stroke, 2 + 2);
});

test('an unknown mode is ignored rather than drawing nothing', () => {
    // The preference is stored per server and read back from disk, so a value from a
    // future version, or a hand-edited one, will eventually turn up here.
    const h = harness({ mode: 'tapestry', getVoices: () => [voice('a')] });
    assert.equal(h.loom.mode, DEFAULT_LOOM_MODE);

    h.loom.setMode('nonsense');
    assert.equal(h.loom.mode, DEFAULT_LOOM_MODE, 'a bad mode must not blank the loom');

    for (const mode of LOOM_MODES) {
        h.loom.setMode(mode);
        assert.equal(h.loom.mode, mode);
    }
});

/* ── braiding ─────────────────────────────────────────────────────────────── */

test('two people talking at once leave their lanes and weave', () => {
    // The braid is the idea the product is named after, and it is the one behaviour that
    // cannot be seen in a single string: it exists only between two.
    //
    // Measured as how far the TOP string wanders from the row it belongs to. Two rooms of
    // 200px and two people put the rows at y=50 and y=150, so a departure of more than
    // half a row means that string has genuinely crossed into somebody else's lane rather
    // than merely vibrating harder in its own.
    const strayOf = (voices) => {
        const h = harness({ mode: 'harp', getVoices: () => voices, h: 200 });
        h.loom.start();
        // Harp draws its two rails first, one lineTo each, then every string twice.
        const strings = h.lastFrame().lines.slice(2).map(([, y]) => y);
        const top = strings.slice(0, strings.length / 2);
        return Math.max(...top.map((y) => Math.abs(y - 50)));
    };

    assert.equal(strayOf([voice('a', 0.05), voice('b', 0.05)]), 0,
        'two people breathing stay in their own rows');
    assert.ok(strayOf([voice('a', 0.9), voice('b', 0.9)]) > 50,
        'two people talking must cross into each other, not sit in parallel lanes');
});

test('one person talking alone has nobody to braid with', () => {
    // The pull is toward the other speakers. With one voice there is no shared band, and
    // a single string reaching for itself would just look like a bug.
    const h = harness({ mode: 'harp', getVoices: () => [voice('a', 0.9), voice('b', 0)], h: 200 });
    h.loom.start();
    const strings = h.lastFrame().lines.slice(2).map(([, y]) => y);
    const top = strings.slice(0, strings.length / 2);
    assert.ok(Math.max(...top.map((y) => Math.abs(y - 50))) < 50,
        'a lone voice swells in its own row');
});

/* ── the rings ────────────────────────────────────────────────────────────── */

test('a ring is lit for whoever is talking and taken back when they stop', () => {
    const rings = new Map();
    let level = 0.8;
    const h = harness({
        mode: 'harp',
        getVoices: () => [voice('a', level), voice('b', 0)],
        onRing: (id, glow) => rings.set(id, glow),
    });
    h.loom.start();
    h.step();

    assert.match(rings.get('a'), /^0 0 0 [\d.]+px hsla\(/, 'a is talking, so a is lit');
    assert.equal(rings.get('b'), undefined, 'and b, who is silent, is never touched');

    level = 0;
    h.step();
    assert.equal(rings.get('a'), 'none', 'a stopped, so the ring goes out');
});

test('stopping puts out every ring it lit, as well as clearing the canvas', () => {
    // A halo left burning on a face claims somebody is talking when nothing is listening.
    const rings = new Map();
    const h = harness({
        mode: 'harp',
        getVoices: () => [voice('a', 0.9)],
        onRing: (id, glow) => rings.set(id, glow),
    });
    h.loom.start();
    h.step();
    assert.notEqual(rings.get('a'), 'none');

    const cleared = h.ctx.calls.clearRect;
    h.loom.stop();
    assert.equal(rings.get('a'), 'none');
    assert.ok(h.ctx.calls.clearRect > cleared, 'a bare stop would freeze the last frame');
    assert.equal(h.pending, null);
    assert.equal(h.loom.running, false);
});

test('somebody who leaves mid-word does not keep their ring', () => {
    const rings = new Map();
    let roster = [voice('a', 0.9), voice('b', 0.9)];
    const h = harness({
        mode: 'harp',
        getVoices: () => roster,
        onRing: (id, glow) => rings.set(id, glow),
    });
    h.loom.start();
    h.step();
    assert.notEqual(rings.get('b'), 'none');

    roster = [voice('a', 0.9)];   // b walked out while talking; their row is gone
    h.step();
    assert.equal(rings.get('b'), 'none', 'no row is left to take the ring back, so the loom must');
});

/* ── the loop ─────────────────────────────────────────────────────────────── */

test('hiding the tab suspends the loop, and showing it resumes', () => {
    // Electron runs background throttling OFF so the audio meters keep working, which
    // means a hidden window would otherwise animate a canvas nobody can see, forever.
    const h = harness({ getVoices: () => [voice('a')] });
    h.loom.start();
    assert.ok(h.loom.running);

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    assert.equal(h.loom.running, false);

    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    assert.ok(h.loom.running);
});

test('a tab shown after an explicit stop stays stopped', () => {
    // "Still background" is a choice, and coming back to the window is not a request to
    // undo it.
    const h = harness({ getVoices: () => [voice('a')] });
    h.loom.start();
    h.loom.stop();

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    assert.equal(h.loom.running, false);
});

test('starting twice does not run two loops', () => {
    const h = harness({ getVoices: () => [voice('a')] });
    h.loom.start();
    const first = h.pending;
    h.loom.start();
    assert.equal(h.pending, first);
});

test('destroy releases the visibility listener', () => {
    const h = harness({ getVoices: () => [voice('a')] });
    h.loom.start();
    assert.equal(h.doc.count('visibilitychange'), 1);
    h.loom.destroy();
    assert.equal(h.doc.count('visibilitychange'), 0);
    assert.equal(h.loom.running, false);
});

test('reduced motion holds one shape instead of freezing mid-wobble', () => {
    // Still is not the same as stopped: the strings are still there, still coloured, still
    // showing who is in the room. They simply do not move.
    const h = harness({ mode: 'harp', reduceMotion: true, getVoices: () => [voice('a', 0.4)] });
    h.loom.start();

    const shape = () => JSON.stringify(h.lastFrame().lines);
    const first = shape();
    h.run(40, 16);
    assert.equal(shape(), first, 'a still loom must be identical frame to frame');
    assert.ok(h.lastFrame().stroke > 0, 'and still drawn — who is here is not an animation');
});

/* ── identity ─────────────────────────────────────────────────────────────── */

test('a string looks like the same string every time its owner walks in', () => {
    // Hashed rather than random, so nothing about a person changes between sessions or
    // between two people looking at the same room.
    assert.equal(idlePhase('ghostbyte'), idlePhase('ghostbyte'));
    assert.notEqual(idlePhase('ghostbyte'), idlePhase('kestrel'));
    for (const n of ['a', 'ghostbyte', 'vaporwave_dan', '', 'Ω']) {
        const p = idlePhase(n);
        assert.ok(p >= 0 && p < 6.28, `${n} -> ${p}`);
    }
});

/* ── voice traces ─────────────────────────────────────────────────────────── */

test('a trace approaches a new reading instead of jumping to it', () => {
    // The whole reason this exists: levels arrive every 100ms and the loom draws every
    // 16ms, so a raw level would step six frames at a time and read as a stutter.
    const t = createVoiceTrace();
    const first = t.step(1).level;
    assert.ok(first > 0 && first < 0.3, `one frame should cover a fraction, not all of it: ${first}`);

    let last = first;
    for (let i = 0; i < 40; i++) {
        const { level } = t.step(1);
        assert.ok(level > last, 'and it must keep climbing');
        last = level;
    }
    assert.ok(last > 0.9, `after forty frames it should have arrived: ${last}`);
});

test('a rise fires a pluck, and the pluck decays away on its own', () => {
    const t = createVoiceTrace();
    t.step(0);
    const onset = t.step(0.7).pluck;
    assert.ok(onset > 0, 'starting to talk has to be visible as more than a thicker line');

    // Held at the same level, nothing new is struck and the bounce dies out.
    let pluck = onset;
    for (let i = 0; i < 60; i++) {
        const next = t.step(0.7).pluck;
        assert.ok(next < pluck, 'a held note must not keep bouncing');
        pluck = next;
    }
    assert.ok(pluck < 0.05, `spent within a second: ${pluck}`);
});

test('a rise below the gate is room tone, not speech', () => {
    const t = createVoiceTrace();
    t.step(0);
    assert.equal(t.step(0.07).pluck, 0, 'a fan spinning up must not pluck anybody\'s string');
});

test('a trace refuses a reading that is not a number', () => {
    // Levels come from an analyser through a Map that can be empty mid-teardown, and NaN
    // propagates: one bad reading would poison the level and the string would vanish.
    const t = createVoiceTrace();
    t.step(0.5);
    for (const bad of [NaN, undefined, null, 'loud', Infinity]) {
        const { level, pluck } = t.step(bad);
        assert.ok(Number.isFinite(level) && Number.isFinite(pluck), `${bad} produced ${level}/${pluck}`);
    }
});

test('a trace set retires whoever it is no longer asked about', () => {
    // Otherwise a long session on a busy server accumulates one trace per account that
    // has ever spoken in it.
    const traces = createVoiceTraces();
    traces.step([{ id: 'a', level: 0.5 }, { id: 'b', level: 0.5 }]);
    assert.equal(traces.size, 2);

    traces.step([{ id: 'a', level: 0.5 }]);
    assert.equal(traces.size, 1);
});

test('a trace set answers in the order it was asked, so strings match faces', () => {
    // Row order is the contract between the canvas and the column of faces beside it.
    const traces = createVoiceTraces();
    const out = traces.step([{ id: 'c', level: 0.1 }, { id: 'a', level: 0.2 }, { id: 'b', level: 0.3 }]);
    assert.deepEqual(out.map((v) => v.id), ['c', 'a', 'b']);
});

test('a struck string bounces even though nobody said anything', () => {
    const traces = createVoiceTraces();
    traces.step([{ id: 'a', level: 0 }]);
    traces.strike('a');
    assert.ok(traces.step([{ id: 'a', level: 0 }])[0].pluck > 0.5);
});
