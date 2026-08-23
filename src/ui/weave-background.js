// The living channel background: one weaving strand per person in the room.
//
// Ported verbatim from the animation running on the live server (`channel-weave.js`,
// "The Gathering"). The drawing maths is unchanged — every constant below was arrived at
// by looking at it, and a "tidier" number is a different animation. Treat the numbers as
// data, not as code to be improved.
//
// What has changed is the plumbing. The original was a classic script whose lifecycle was
// driven from five separate places in a 5,900-line file: start here, stop on tab hide, stop
// on a preference change, stop on leaving the room, clear the canvas because a bare stop
// freezes the last frame. All of that now lives inside the class, because scattering it is
// how a canvas ends up burning a core on a hidden tab.
//
// The shape of the animation:
//   - One strand per participant, spread evenly down the height, with amplitude slightly
//     WIDER than the spacing so neighbouring strands overlap and genuinely weave through
//     each other rather than running in parallel lanes.
//   - Colour comes from the person, via `userHue`. Nothing stored, nothing synchronised.
//   - Pace is driven by room "noise" — voice level and message rate — eased very gradually,
//     so a room waking up is felt rather than seen to switch.
//   - Joining and leaving fade over about a second. A departing strand keeps being drawn
//     while it fades, then retires.

/** Pace in phase-radians per second, before `paceScale`. */
const PACE_IDLE = 0.10;   // a silent room still drifts, very slowly
const PACE_GAIN = 0.55;   // extra pace at full noise
const PACE_EASE = 0.28;   // per-second approach rate -> the very gradual ramp
const PRESENCE = 0.9;     // join / leave fade rate (about 1.1s to fully fade)

const SEGMENTS = 56;      // points per strand

export class WeaveBackground {
    /**
     * @param {HTMLCanvasElement} canvas absolutely positioned behind the room content
     * @param {object} opts
     * @param {() => {participants: Array<{id: string, hue: number}>, noise: number}} opts.getState
     *        Read once per frame. Must be cheap, and must not throw — if it does, that frame
     *        is skipped rather than the loop dying silently.
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.getState = opts.getState || (() => ({ participants: [], noise: 0 }));
        this.paceScale = opts.paceScale ?? 1.0;
        this.maxDpr = opts.maxDpr || 2;

        this.reduceMotion = opts.reduceMotion ?? prefersReducedMotion();

        // Injectable so the loop can be stepped deterministically in a test. Nothing else
        // about the animation changes.
        this._raf = opts.raf ?? ((fn) => requestAnimationFrame(fn));
        this._cancelRaf = opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
        this._doc = opts.document ?? (typeof document === 'undefined' ? null : document);

        this.order = [];          // strand ids currently drawn, including ones fading out
        this.strands = new Map(); // id -> { hue, phase, kjit, ajit, present, target }
        this.phase = 0;           // accumulated weave phase
        this.spd = PACE_IDLE * this.paceScale;
        this.drift = 0;
        this.effNoise = 0;

        this._handle = 0;
        this._last = 0;
        this._wanted = false;     // what the caller asked for, independent of tab visibility
        this._animate = this._animate.bind(this);

        this._onVisibility = () => {
            // A hidden tab still runs rAF in some browsers, and always does in Electron with
            // background throttling disabled — which it must be, so audio meters keep working.
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
     * Clearing matters. A bare stop leaves the last frame painted, which reads as a still
     * photograph of a living thing rather than as its absence.
     */
    stop() {
        this._wanted = false;
        this._suspend();
        this._clear();
    }

    destroy() {
        this.stop();
        this._doc?.removeEventListener?.('visibilitychange', this._onVisibility);
    }

    get running() { return this._handle !== 0; }

    _resume() {
        if (this._handle) return;
        this._last = 0;
        this._handle = this._raf(this._animate);
    }

    _suspend() {
        if (this._handle) this._cancelRaf(this._handle);
        this._handle = 0;
    }

    _clear() {
        try {
            this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
        } catch {
            // A detached canvas during teardown. Nothing to clear, nothing to report.
        }
    }

    _hsl(h, s, l, a) { return a == null ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${a})`; }

    _resize() {
        const c = this.canvas;
        const dpr = Math.min(this._devicePixelRatio(), this.maxDpr);
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

    _devicePixelRatio() {
        return (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
    }

    /** Reconcile the drawn strand set with who is actually in the room. */
    _sync(participants, dt) {
        const want = new Map(participants.map((p) => [p.id, p]));

        // Newcomers append, so they slot in at the bottom and everything above reflows up.
        let slot = this.order.length;
        for (const p of participants) {
            if (!this.strands.has(p.id)) {
                this.order.push(p.id);
                this.strands.set(p.id, {
                    hue: p.hue,
                    phase: slot * 0.85,
                    kjit: ((slot % 3) - 1) * 0.06,                    // spatial-freq offset -> crossings
                    ajit: 0.82 + (((slot * 37) % 100) / 100) * 0.3,   // amplitude jitter -> organic weave
                    present: 0,
                    target: 1,
                });
                slot++;
            }
        }

        for (const id of this.order) {
            const st = this.strands.get(id);
            const live = want.get(id);
            st.target = live ? 1 : 0;
            if (live) st.hue = live.hue;
            st.present += (st.target - st.present) * Math.min(1, dt * PRESENCE * (this.reduceMotion ? 4 : 1));
        }

        // Retire only once fully faded, so a departure is seen to leave.
        this.order = this.order.filter((id) => {
            const st = this.strands.get(id);
            if (st.target === 0 && st.present < 0.02) { this.strands.delete(id); return false; }
            return true;
        });
    }

    _drawStrand(ctx, w, baseY, spacing, st, activity) {
        const lam = w * 0.55;         // base wavelength
        const amp = spacing * 0.92;   // wider than the spacing, so neighbours overlap and weave
        const kx = ((2 * Math.PI) / lam) * (1 + st.kjit);
        const a = (0.11 + activity * 0.11) * st.present;  // low opacity, lifts a touch with noise
        if (a <= 0.002) return false;

        const pts = [];
        for (let i = 0; i <= SEGMENTS; i++) {
            const x = (w * i) / SEGMENTS;
            const y = baseY
                + amp * st.ajit * Math.sin(kx * x + this.phase + st.phase)
                + amp * 0.28 * Math.sin(kx * 1.7 * x - this.phase * 0.6 + st.phase * 1.4);
            pts.push([x, y]);
        }

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Soft glow body.
        ctx.shadowBlur = 6 + activity * 12;
        ctx.shadowColor = this._hsl(st.hue, 88, 62, 0.85 * st.present);
        ctx.strokeStyle = this._hsl(st.hue, 74, 60, a);
        ctx.lineWidth = 4.0 + activity * 2.8;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();

        // Bright thread core.
        ctx.shadowBlur = 0;
        ctx.strokeStyle = this._hsl(st.hue, 100, 84, a * 0.9);
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();

        ctx.restore();
        return true;
    }

    _animate(now) {
        const dim = this._resize();
        const dt = Math.min(0.05, this._last ? (now - this._last) / 1000 : 0.016);
        this._last = now;
        if (!dim) { this._handle = this._raf(this._animate); return; }

        let state;
        try { state = this.getState() || {}; } catch { state = {}; }
        const participants = state.participants || [];
        const noise = Math.max(0, Math.min(1, state.noise || 0));

        this._sync(participants, dt);

        // Smoothed noise, then an eased pace. Two stages, deliberately: the first stops one
        // loud syllable jolting the whole field, the second makes the ramp gradual.
        this.effNoise += (noise - this.effNoise) * Math.min(1, dt * 2.0);
        const target = (PACE_IDLE + this.effNoise * PACE_GAIN) * this.paceScale;
        this.spd += (target - this.spd) * Math.min(1, dt * PACE_EASE);

        if (!this.reduceMotion) {
            this.phase += dt * this.spd;
            this.drift += dt * 0.05;
        }

        const { w, h } = dim;
        const n = Math.max(1, this.order.length);
        const spacing = h / n;
        const fieldDrift = Math.sin(this.drift) * spacing * 0.12;

        for (let s = 0; s < this.order.length; s++) {
            const st = this.strands.get(this.order[s]);
            this._drawStrand(this.ctx, w, (s + 0.5) * spacing + fieldDrift, spacing, st, this.effNoise);
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

/**
 * Room noise from message rate: messages per minute over a rolling window, as 0..1.
 *
 * A small stateful helper rather than a pure function, because the window has to be trimmed
 * as it is read and every caller would otherwise have to remember to do it.
 */
export function createMessageNoise({ windowMs = 20000, fullRate = 30 } = {}) {
    const times = [];
    return {
        record(at) { times.push(at); },
        /** Called on a room switch: the new room's pace must not inherit the old one's. */
        reset() { times.length = 0; },
        /** @param {number} now epoch milliseconds */
        value(now) {
            while (times.length && now - times[0] > windowMs) times.shift();
            return Math.min(1, (times.length * (60000 / windowMs)) / fullRate);
        },
    };
}

/**
 * Room noise from voices.
 *
 * Favours the LOUDEST speaker blended with the room average, so one person talking quietly
 * in a room of eight still registers instead of being averaged away into silence.
 */
export function voiceNoise(levels) {
    const values = [...levels];
    if (!values.length) return 0;
    let sum = 0;
    let loudest = 0;
    for (const lvl of values) {
        sum += lvl;
        if (lvl > loudest) loudest = lvl;
    }
    return Math.min(1, Math.max(loudest, (sum / values.length) * 1.4));
}
