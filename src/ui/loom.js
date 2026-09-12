// The Loom: one vibrating string per person in the room you are standing in.
//
// Each string belongs to somebody, carries their colour, and swells and glows with their
// voice. When two or more people talk at once the strings pull toward a shared band and
// braid through one another — the room weaving, which is the idea the product is named
// after. Three modes, and they are genuinely different instruments rather than three
// palettes: `cloth` hangs the strings in a warp and interlaces them, `harp` strings them
// between two rails and lets them ring pure, `web` connects every pair of active speakers
// with a glowing thread.
//
// Ported from `loom-renderer.js` on the live server. The drawing maths below — `_disp`,
// `_drawString` and everything inside `_drawLoom` — is unchanged. Every constant in it was
// arrived at by looking at the thing, and a tidier number is a different animation; treat
// them as data, not as code to be improved. The same warning is on `weave-background.js`,
// its sibling, and for the same reason.
//
// What HAS changed is the plumbing, in exactly the ways that file already established:
//
//   - The lifecycle lives in the class. The original was driven from five places in a
//     5,900-line file — start here, stop on tab hide, stop on a preference, stop on
//     leaving, clear the canvas because a bare stop freezes the last frame. Scattering
//     that is how a canvas ends up burning a core on a hidden tab.
//   - rAF, cancel and document are injectable, so the loop can be stepped deterministically
//     in a test with no browser.
//   - Idle phase is hashed from the id rather than drawn from `Math.random()`. A render
//     loop has no business holding an RNG, a person's string should look the same every
//     time they walk in, and a test can then assert a frame. `userHue()` in `./hue.js` is
//     the existing precedent for deriving something stable from a name.
//
// The canvas is expected to sit beside a column of faces, one row per person, and derives
// its row height as `height / voices` — so whatever parents it has to be exactly as tall as
// that column. A face and the string that belongs to it must line up.

/** The modes, in the order they are offered. Shared with the settings panel. */
export const LOOM_MODES = Object.freeze(['cloth', 'harp', 'web']);

export const DEFAULT_LOOM_MODE = 'cloth';

/** Points per string. Enough to curve, few enough to redraw a roomful at 60fps. */
const SEGMENTS = 46;

// The scaffold — the static loom frame each mode hangs its strings on — is the one part
// that is not coloured by a person, so it takes the app's own palette. These are the hues
// of --gold-rgb and --accent in tokens.css. They live here as numbers because the canvas
// draws in HSL and cannot read a CSS variable; if either token moves, move these with it.
const HUE_WARP = 37;    // --gold-rgb: 224 163 62
const HUE_WEB = 258;    // --accent: #8b5cf6

/** Below this a voice is not active enough to braid with anybody. */
const BRAID_AT = 0.2;
/** Below this, web mode does not run a thread to it. */
const CONNECT_AT = 0.18;
/** Below this, an avatar carries no ring at all. */
const RING_AT = 0.04;

export class LoomRenderer {
    /**
     * @param {HTMLCanvasElement} canvas sized by its wrapper, one row per voice
     * @param {object} opts
     * @param {'cloth'|'harp'|'web'} [opts.mode]
     * @param {() => Array<{id: string, hue: number, level: number, pluck: number}>} opts.getVoices
     *        Read once per frame, top row first. Must be cheap, and must not throw — if it
     *        does, that frame is skipped rather than the loop dying silently.
     * @param {(id: string, glow: string) => void} [opts.onRing]
     *        Called with a box-shadow for that person's avatar, so the face and its string
     *        are lit by one thing rather than two.
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.mode = LOOM_MODES.includes(opts.mode) ? opts.mode : DEFAULT_LOOM_MODE;
        this.getVoices = opts.getVoices || (() => []);
        this.onRing = opts.onRing || null;
        this.maxDpr = opts.maxDpr || 2;

        this.reduceMotion = opts.reduceMotion ?? prefersReducedMotion();

        // Injectable so the loop can be stepped deterministically in a test. Nothing else
        // about the animation changes.
        this._raf = opts.raf ?? ((fn) => requestAnimationFrame(fn));
        this._cancelRaf = opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
        this._doc = opts.document ?? (typeof document === 'undefined' ? null : document);

        this._handle = 0;
        this._t0 = 0;
        this._wanted = false;   // what the caller asked for, independent of tab visibility
        this._lit = new Set();  // ids currently carrying a ring, so it can be taken back
        this._animate = this._animate.bind(this);

        this._onVisibility = () => {
            // A hidden tab still runs rAF in some browsers, and always does in Electron
            // with background throttling disabled — which it must be, so audio meters keep
            // working.
            if (this._doc?.hidden) this._suspend();
            else if (this._wanted) this._resume();
        };
        this._doc?.addEventListener?.('visibilitychange', this._onVisibility);
    }

    /** Swap instrument. Takes effect on the next frame; nothing restarts. */
    setMode(mode) {
        if (LOOM_MODES.includes(mode)) this.mode = mode;
    }

    /** Run. Idempotent, and a no-op while the tab is hidden. */
    start() {
        this._wanted = true;
        if (!this._doc?.hidden) this._resume();
    }

    /**
     * Stop, clear, and put out every ring.
     *
     * Clearing matters. A bare stop leaves the last frame painted, which reads as a still
     * photograph of a living thing rather than as its absence — and a ring left burning on
     * an avatar claims somebody is talking when nothing is listening any more.
     */
    stop() {
        this._wanted = false;
        this._suspend();
        this._clear();
        this._douse();
    }

    destroy() {
        this.stop();
        this._doc?.removeEventListener?.('visibilitychange', this._onVisibility);
    }

    get running() { return this._handle !== 0; }

    _resume() {
        if (this._handle) return;
        // No clock is started here on purpose. The animation's time base is the frame
        // timestamp rAF hands in, and seeding it from a second clock instead means the
        // very first frame is computed against a `t` that belongs to neither.
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

    /** Hand every lit avatar its ring back as "none", then forget them. */
    _douse() {
        if (this.onRing) for (const id of this._lit) this.onRing(id, 'none');
        this._lit.clear();
    }

    _hsl(h, s, l, a) { return a == null ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${a})`; }

    _resize(rows) {
        const c = this.canvas;
        const dpr = Math.min(this._devicePixelRatio(), this.maxDpr);
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (!w || !h || !rows) return null;
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

    /* ── the maths, verbatim from the original ───────────────────────────── */

    /**
     * How far a string is displaced at a fractional position along it.
     *
     * `sin(pi * tx)` pins both ends at zero and bulges the middle, which is what a plucked
     * string does. `harm` adds a second and a half harmonic so cloth and web shimmer; harp
     * stays pure, which is the difference you can actually see between them.
     */
    _disp(tx, amp, freq, t, harm) {
        const env = Math.sin(Math.PI * tx);
        let d = env * amp * Math.sin(2 * Math.PI * freq * t);
        if (harm) {
            d += env * amp * 0.34 * Math.sin(2 * Math.PI * freq * 2 * t + 1.1)
                + Math.sin(2 * Math.PI * tx) * amp * 0.18 * Math.sin(2 * Math.PI * freq * 0.5 * t);
        }
        return d;
    }

    /**
     * One string: a wide glow pass, then a bright core along the same path.
     *
     * `offFn` bends the whole baseline, which is how braiding is done — the string keeps
     * its own vibration and the offset carries it toward everybody else.
     */
    _drawString(ctx, x0, x1, y, v, rowH, t, mode, offFn) {
        const maxA = rowH * 0.34;
        const pluckA = rowH * 0.42;
        const idle = 0.05 + 0.04 * Math.sin(t * 1.1 + v.phase);
        let amp = (v.level * maxA) + (v.pluck * pluckA) + idle * (rowH * 0.16);
        amp = Math.min(amp, rowH * 0.47);
        const harm = mode !== 'harp';

        const pts = [];
        for (let i = 0; i <= SEGMENTS; i++) {
            const tx = i / SEGMENTS;
            const x = x0 + (x1 - x0) * tx;
            const off = offFn ? offFn(tx) : 0;
            pts.push([x, y + off - this._disp(tx, amp, v.freq, t, harm)]);
        }

        const lvl = Math.min(1, v.level + v.pluck);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Glow pass.
        ctx.shadowBlur = 5 + lvl * 20;
        ctx.shadowColor = this._hsl(v.hue, 90, 62, 0.9);
        ctx.strokeStyle = this._hsl(v.hue, 78, 56 + lvl * 8, 0.55 + lvl * 0.4);
        ctx.lineWidth = 1.3 + v.level * 3 + v.pluck * 2.4;
        trace(ctx, pts);

        // Bright core.
        ctx.shadowBlur = 0;
        ctx.strokeStyle = this._hsl(v.hue, 100, 86, 0.25 + lvl * 0.6);
        ctx.lineWidth = 0.8 + lvl * 1.1;
        trace(ctx, pts);

        ctx.restore();
        return { amp };
    }

    _drawLoom(ctx, w, h, t, raw) {
        const n = raw.length;
        if (!n) { this._douse(); return 0; }

        const rowH = h / n;
        const x0 = 6;
        const x1 = w - 8;

        // A stable phase and frequency per voice, so idle motion is organic rather than
        // everybody breathing in unison. Hashed from the id, not random — see the header.
        const voices = raw.map((r, i) => ({
            id: r.id,
            hue: r.hue,
            level: clamp(r.level),
            pluck: clamp(r.pluck),
            phase: idlePhase(r.id),
            freq: 2.0 + i * 0.27,
        }));

        this._drawScaffold(ctx, h, t, x0, x1);

        // Braiding: when two or more people are talking, their strings gravitate toward a
        // shared band and cross over and under one another. Ends stay anchored, so the
        // weave happens in the middle where there is room for it.
        const sd = voices.map((v, i) => ({
            v, i, y: (i + 0.5) * rowH, strength: Math.min(1, v.level + v.pluck),
        }));
        const active = sd.filter((d) => d.strength > BRAID_AT);
        let centerY = 0;
        for (const d of active) centerY += d.y;
        if (active.length) centerY /= active.length;
        let spread = 0;
        if (active.length >= 2) {
            const ys = active.map((d) => d.y);
            spread = Math.max(...ys) - Math.min(...ys);
        }

        const offFnFor = (d) => {
            if (active.length < 2 || d.strength <= BRAID_AT) return null;
            const k = active.indexOf(d);
            const braidAmp = spread * 0.5 + rowH * 0.35;
            const up = -(d.y - 6);
            const down = (h - 6 - d.y);
            return (tx) => {
                const env = Math.sin(Math.PI * tx);                      // ends stay anchored
                const pull = (centerY - d.y) * 0.6 * d.strength * env;   // toward the shared band
                const braid = Math.sin(2 * Math.PI * tx * 1.4 + k * (2 * Math.PI / active.length) + t * 2.0)
                    * braidAmp * d.strength * env;                       // over and under
                return Math.max(up, Math.min(down, pull + braid));
            };
        };

        const meta = [];
        for (const d of sd) {
            const off = offFnFor(d);
            const info = this._drawString(ctx, x0, x1, d.y, d.v, rowH, t, this.mode, off);
            meta.push({ v: d.v, y: d.y, amp: info.amp, offFn: off });
        }

        this._drawInterlace(ctx, t, x0, x1, rowH, meta);
        this._drawRings(meta);
        return meta.length;
    }

    /** The static frame each mode hangs its strings on. */
    _drawScaffold(ctx, h, t, x0, x1) {
        if (this.mode === 'cloth') {
            const step = 26;
            ctx.lineWidth = 1;
            for (let x = x0 + step * 0.5; x < x1; x += step) {
                const dx = 2.2 * Math.sin(t * 0.3 + x * 0.05);
                ctx.strokeStyle = this._hsl(HUE_WARP, 55, 52, 0.10);
                ctx.beginPath(); ctx.moveTo(x + dx, 0); ctx.lineTo(x + dx, h); ctx.stroke();
            }
        } else if (this.mode === 'harp') {
            ctx.strokeStyle = this._hsl(HUE_WARP, 45, 55, 0.16);
            ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.moveTo(x0, 6); ctx.lineTo(x0, h - 6); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x1, 6); ctx.lineTo(x1, h - 6); ctx.stroke();
        } else if (this.mode === 'web') {
            ctx.strokeStyle = this._hsl(HUE_WEB, 40, 55, 0.06);
            ctx.lineWidth = 1;
            for (let i = 0; i < 5; i++) {
                const yy = (i + 0.5) / 5 * h;
                ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, h - yy); ctx.stroke();
            }
        }
    }

    /** What each mode draws ON TOP of its strings — the part that makes it that mode. */
    _drawInterlace(ctx, t, x0, x1, rowH, meta) {
        // Cloth: repaint warp segments over the strings at every other crossing, so the
        // string passes UNDER there. Alternating by row and column is the whole illusion.
        if (this.mode === 'cloth') {
            const step = 26;
            for (let i = 0; i < meta.length; i++) {
                const m = meta[i];
                let col = 0;
                for (let x = x0 + step * 0.5; x < x1; x += step, col++) {
                    if (((i + col) & 1) !== 0) continue;
                    const tx = (x - x0) / (x1 - x0);
                    const dx = 2.2 * Math.sin(t * 0.3 + x * 0.05);
                    const yy = m.y + (m.offFn ? m.offFn(tx) : 0) - this._disp(tx, m.amp, m.v.freq, t, true);
                    ctx.strokeStyle = this._hsl(HUE_WARP, 60, 56, 0.34);
                    ctx.lineWidth = 2.4;
                    ctx.beginPath();
                    ctx.moveTo(x + dx, yy - rowH * 0.28);
                    ctx.lineTo(x + dx, yy + rowH * 0.28);
                    ctx.stroke();
                }
            }
            return;
        }

        // Harp: a tuning peg per string at the left rail, in that person's colour.
        if (this.mode === 'harp') {
            for (const m of meta) {
                ctx.fillStyle = this._hsl(m.v.hue, 70, 60, 0.9);
                ctx.beginPath(); ctx.arc(x0, m.y, 3.1, 0, 6.28); ctx.fill();
            }
            return;
        }

        // Web: a glowing thread between every pair of people currently talking, so a
        // conversation is drawn as the connections it actually is.
        if (this.mode === 'web') {
            const act = meta.filter((m) => (m.v.level + m.v.pluck) > CONNECT_AT);
            for (let a = 0; a < act.length; a++) {
                for (let b = a + 1; b < act.length; b++) {
                    const A = act[a];
                    const B = act[b];
                    const strength = Math.min(A.v.level + A.v.pluck, B.v.level + B.v.pluck);
                    const ax = (x0 + x1) / 2;
                    const ay = A.y + (A.offFn ? A.offFn(0.5) : 0) - A.amp * 0.7;
                    const bx = (x0 + x1) / 2;
                    const by = B.y + (B.offFn ? B.offFn(0.5) : 0) - B.amp * 0.7;
                    ctx.save();
                    ctx.shadowBlur = 8 * strength;
                    ctx.shadowColor = this._hsl(A.v.hue, 80, 60, 0.6);
                    const g = ctx.createLinearGradient(ax, ay, bx, by);
                    g.addColorStop(0, this._hsl(A.v.hue, 80, 62, 0.16 + strength * 0.5));
                    g.addColorStop(1, this._hsl(B.v.hue, 80, 62, 0.16 + strength * 0.5));
                    ctx.strokeStyle = g;
                    ctx.lineWidth = 0.8 + strength * 2.2;
                    ctx.beginPath();
                    ctx.moveTo(ax, ay);
                    ctx.quadraticCurveTo((ax + bx) / 2 + 18 * Math.sin(t * 1.5), (ay + by) / 2, bx, by);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }
    }

    /**
     * Light each avatar from the same number that drew its string.
     *
     * Tracked rather than written blindly, so a person who stops talking gets their ring
     * taken back — and so `stop()` can put out everything it lit rather than leaving a
     * frozen halo behind on a face.
     */
    _drawRings(meta) {
        if (!this.onRing) return;
        const stillLit = new Set();

        for (const m of meta) {
            const lvl = Math.min(1, m.v.level + m.v.pluck);
            if (lvl > RING_AT) {
                const ring = this._hsl(m.v.hue, 80, 55, 0.18 + lvl * 0.4);
                const halo = this._hsl(m.v.hue, 85, 55, lvl * 0.5);
                this.onRing(m.v.id, `0 0 0 ${1.5 + lvl * 2.5}px ${ring}, 0 0 ${lvl * 16}px ${halo}`);
                stillLit.add(m.v.id);
            } else if (this._lit.has(m.v.id)) {
                this.onRing(m.v.id, 'none');
            }
        }

        // Anybody lit last frame who is no longer on the loom at all — they left mid-word,
        // and their row is gone, so nothing above would ever take the ring back.
        const present = new Set(meta.map((m) => m.v.id));
        for (const id of this._lit) if (!present.has(id)) this.onRing(id, 'none');

        this._lit = stillLit;
    }

    _animate(frameTime) {
        const at = Number.isFinite(frameTime) ? frameTime : now();
        if (!this._t0) this._t0 = at;

        // The clock stands still when motion is off, so the strings hold one shape rather
        // than freezing mid-wobble at whatever phase the last frame happened to catch.
        const t = this.reduceMotion ? 0 : (at - this._t0) / 1000;

        try {
            let voices = [];
            try { voices = this.getVoices() || []; } catch { voices = []; }
            const dim = this._resize(voices.length);
            if (dim) this._drawLoom(this.ctx, dim.w, dim.h, t, voices);
        } catch {
            // One bad frame must not take the loom down with it. The next one usually
            // works, and a dead canvas is far more visible than a dropped frame.
        }

        this._handle = this._raf(this._animate);
    }
}

/** Trace a polyline that has already been computed. */
function trace(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
}

/**
 * A stable idle phase in [0, 2pi) for an id.
 *
 * The same hash as `userHue()`, read at a finer resolution. Deliberately the same shape of
 * thing: a person's string should look like theirs on every client and after every restart.
 */
export function idlePhase(id) {
    const s = String(id ?? '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return (h % 628) / 100;
}

const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}
