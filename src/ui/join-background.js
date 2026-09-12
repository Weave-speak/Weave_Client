// The sign-in background: a field of strings that pluck themselves.
//
// Eleven strings run the height of the window, each in its own colour, and every so often
// one is struck — a bounce, a glow, and a slow fall back to rest — while the others keep
// breathing. Nobody is doing it. It is the tapestry weaving itself, which is what the first
// screen of the app should feel like before anyone is in it.
//
// Ported from `join-background.js` on the live server. The pluck schedule, the decay
// rates, the warp spacing, the hue step and the row stretch below are that file's numbers,
// arrived at by looking at the thing; treat them as data, not as code to be improved. The
// same warning sits on `loom.js` and `weave-background.js`, for the same reason.
//
// The string itself is not ported at all. Its maths was line for line the Loom's in cloth
// mode, so it is drawn by `drawString` from `./loom.js` — one instrument, not two copies of
// one that will drift the first time somebody retunes either.
//
// What has changed is the plumbing, in the ways its siblings already established: the
// lifecycle lives in the class, rAF and document are injectable, and the clock is the frame
// timestamp rather than a second clock started in `start()`.
//
// One deliberate difference from the Loom: the randomness stays. The Loom hashes each
// string's phase from a person's name, because a person's string should look like theirs.
// Here nothing belongs to anyone, and strings plucking at moments you cannot predict IS the
// effect — so `random` is kept, and merely made injectable so a test can seed it.

import { drawString, hsl, HUE_WARP } from './loom.js';

const ROWS = 11;
/** Colour step between neighbouring strings. 33 degrees walks eleven strings through a rainbow. */
const HUE_STEP = 33;
/** A string drawn a little taller than its row, so neighbours brush against each other. */
const ROW_STRETCH = 1.1;
const WARP_STEP = 34;

/** A gap between frames longer than this was a pause, not a slow frame. */
const MAX_FRAME_GAP_MS = 250;
const FRAME_MS = 16;

export class JoinBackground {
    /**
     * @param {HTMLCanvasElement} canvas fills the window, behind the sign-in card
     * @param {object} [opts]
     * @param {number} [opts.rows]
     * @param {() => number} [opts.random] a source in [0, 1); seeded in tests
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.rows = opts.rows || ROWS;
        this.maxDpr = opts.maxDpr || 2;
        this.reduceMotion = opts.reduceMotion ?? prefersReducedMotion();
        this.random = opts.random ?? Math.random;

        // Injectable so the loop can be stepped deterministically in a test.
        this._raf = opts.raf ?? ((fn) => requestAnimationFrame(fn));
        this._cancelRaf = opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
        this._doc = opts.document ?? (typeof document === 'undefined' ? null : document);

        this.strings = null;    // built on the first frame, when there is a clock to schedule against
        this.plucks = 0;        // how many times any string has been struck; for tests and the sandbox
        this._handle = 0;
        this._t0 = null;
        this._lastAt = null;
        this._wanted = false;
        this._animate = this._animate.bind(this);

        this._onVisibility = () => {
            // Electron runs with background throttling off so the room's audio meters keep
            // working, which means a hidden window would otherwise pluck strings nobody can
            // see for as long as it sat on the sign-in screen.
            if (this._doc?.hidden) this._suspend();
            else if (this._wanted) this._resume();
        };
        this._doc?.addEventListener?.('visibilitychange', this._onVisibility);
    }

    /** Run. Idempotent, and a no-op while the tab is hidden. */
    start() {
        this._wanted = true;
        if (!this._doc?.hidden) this._resume();
    }

    /**
     * Stop and clear.
     *
     * A bare stop leaves the last frame painted — a string frozen mid-bounce, which reads as
     * a fault rather than as stillness.
     */
    stop() {
        this._wanted = false;
        this._suspend();
        try {
            this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
        } catch {
            // A detached canvas during teardown. Nothing to clear.
        }
    }

    destroy() {
        this.stop();
        this._doc?.removeEventListener?.('visibilitychange', this._onVisibility);
    }

    get running() { return this._handle !== 0; }

    _resume() {
        if (this._handle) return;
        this._handle = this._raf(this._animate);
    }

    _suspend() {
        if (this._handle) this._cancelRaf(this._handle);
        this._handle = 0;
    }

    _resize() {
        const c = this.canvas;
        const dpr = Math.min((typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1, this.maxDpr);
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (!w || !h) return null;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
        }
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.clearRect(0, 0, w, h);
        return { w, h };
    }

    _build(t) {
        const r = this.random;
        this.strings = [];
        for (let i = 0; i < this.rows; i++) {
            this.strings.push({
                hue: (i * HUE_STEP) % 360,
                level: 0,
                pluck: 0,
                phase: r() * 6.28,
                freq: 1.6 + r() * 1.4,
                // Staggered from the start, so the screen does not open on eleven strings
                // struck at once.
                next: t + r() * 1.5,
                struck: 0,
            });
        }
    }

    _frame(ctx, w, h, t) {
        if (!this.strings) this._build(t);
        const rowH = h / this.rows;

        // The faint warp the strings hang across.
        ctx.lineWidth = 1;
        for (let x = WARP_STEP * 0.5; x < w; x += WARP_STEP) {
            ctx.strokeStyle = hsl(HUE_WARP, 40, 50, 0.04);
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }

        for (let i = 0; i < this.rows; i++) {
            const st = this.strings[i];

            // Still means still: a string that plucks itself is exactly the motion somebody
            // who asked for less of it does not want. The strings stay drawn, at rest.
            if (!this.reduceMotion && t > st.next) {
                st.pluck = 0.7 + this.random() * 0.3;
                st.level = 0.3 + this.random() * 0.4;
                st.next = t + 0.8 + this.random() * 2.2;
                st.struck += 1;
                this.plucks += 1;
            }
            st.pluck *= 0.965;
            st.level *= 0.97;

            drawString(ctx, {
                x0: 0, x1: w, y: (i + 0.5) * rowH, voice: st,
                rowH: rowH * ROW_STRETCH, t, harm: true,
            });
        }
    }

    _animate(frameTime) {
        const at = Number.isFinite(frameTime) ? frameTime : (this._lastAt ?? 0) + 16;
        if (this._t0 === null) this._t0 = at;

        // Time spent away does not count. Every string is waiting for a moment on this clock,
        // so after ten minutes hidden, or stopped, every one of those moments is already in
        // the past — and all eleven strings would be struck on the same frame the window
        // came back. The original does exactly that. Sliding the origin forward by the gap
        // resumes the schedule where it left off instead.
        if (this._lastAt !== null && at - this._lastAt > MAX_FRAME_GAP_MS) {
            this._t0 += at - this._lastAt - FRAME_MS;
        }
        this._lastAt = at;

        // The clock stands still with motion off, so the idle breathing stops too.
        const t = this.reduceMotion ? 0 : (at - this._t0) / 1000;

        try {
            const dim = this._resize();
            if (dim) this._frame(this.ctx, dim.w, dim.h, t);
        } catch {
            // One bad frame must not end the animation.
        }

        this._handle = this._raf(this._animate);
    }
}

function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}
