// How often a canvas may actually draw.
//
// requestAnimationFrame fires at the DISPLAY's rate, not at sixty. Everything here was
// written and tuned on a 60 Hz screen and said so in its comments — "redrawn sixty times a
// second" — and on a 180 Hz monitor that sentence was simply false: the room background
// cleared and re-stroked a window-sized canvas three times as often as anybody had costed,
// and measured on such a machine the GPU process sat at a full core for as long as the app
// was open. Nothing leaked; it was just drawing frames nobody could tell apart.
//
// So a renderer asks this before it draws. It still schedules itself on every rAF — that is
// what keeps it in step with the compositor and stops it the moment the page stops
// compositing — and merely declines the frames that arrive too soon.
//
// A gate rather than a setInterval, for that reason: a timer keeps firing behind a window
// nobody is compositing, and drifts against the display when it is.

// A 60 Hz display delivers frames 16.67 ms apart, give or take. Without slack, a cap of 60
// would refuse every frame that came in at 16.5 and halve the rate it was asked to allow.
const SLACK_MS = 1.5;

/**
 * @param {number} maxFps 0 (or anything not positive) lets every frame through
 * @returns {{due: (now: number) => boolean, setMaxFps: (fps: number) => void,
 *            reset: () => void, readonly maxFps: number}}
 */
export function createFrameGate(maxFps = 0) {
    let fps = 0;
    let interval = 0;
    let last = null;

    const setMaxFps = (next) => {
        fps = Number.isFinite(next) && next > 0 ? next : 0;
        interval = fps ? 1000 / fps : 0;
    };
    setMaxFps(maxFps);

    return {
        /**
         * Whether a frame arriving at `now` (a rAF timestamp, milliseconds) should draw.
         * Answering yes records it, so ask once per frame.
         *
         * A clock that runs backwards — a test restarting its own, a suspended machine —
         * lets the frame through rather than waiting for time to catch up with itself.
         */
        due(now) {
            if (interval && last !== null && now >= last && now - last < interval - SLACK_MS) return false;
            last = now;
            return true;
        },
        setMaxFps,
        /** Forget the last frame, so the next one draws whatever the clock says. */
        reset() { last = null; },
        get maxFps() { return fps; },
    };
}
