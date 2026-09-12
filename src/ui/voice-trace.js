// One voice, as the Loom needs to see it.
//
// The media layer publishes levels on a 100 ms interval (`LEVEL_INTERVAL_MS` in
// `src/media/voice.js`) — ten readings a second, which is ample for toggling a "speaking"
// class and far too coarse for a string that is being drawn sixty times a second. Fed
// straight in, a level steps: the string jumps to a new amplitude, sits there for six
// frames, and jumps again. It reads as a stutter rather than as a voice.
//
// So a trace sits between the two, and does the two things the raw number cannot:
//
//   level — the reading, smoothed. Chases the target every frame, so the string arrives
//           at a new loudness over a few frames instead of snapping to it.
//   pluck — the bounce when somebody STARTS talking. A rise past a threshold adds to it
//           and it decays away, which is what makes a string visibly struck rather than
//           merely thick. Nothing else in this client has this concept; it is the whole
//           difference between a level meter and an instrument.
//
// Ported from `voice-levels.js` on the live server, minus its analyser: `meterFor()` in
// `src/media/voice.js` already does the RMS and the sensitivity curve, so what arrives
// here is exactly the `target` that the original computed for itself. Every constant is
// that file's, and was arrived at by listening to it — treat them as data.
//
// Pure and frame-driven rather than clock-driven, in the same spirit as
// `createMessageNoise()` in `weave-background.js`: no timers, no audio nodes, nothing to
// tear down, and a test can step it by hand.

/** Per-frame approach rate toward the latest reading. */
const SMOOTHING = 0.18;
/** A rise larger than this, from a level already above the gate, counts as an onset. */
const PLUCK_THRESHOLD = 0.06;
const PLUCK_GATE = 0.08;
/** How much of that rise becomes bounce. */
const PLUCK_RESPONSE = 3.2;
/** Per-frame decay. At 60fps a pluck is spent in about a second. */
const PLUCK_DECAY = 0.92;

/**
 * A single voice's trace.
 *
 * @param {object} [opts] overrides, for the sandbox and for tests
 * @returns {{step: (target: number) => {level: number, pluck: number},
 *            read: () => {level: number, pluck: number}, reset: () => void}}
 */
export function createVoiceTrace({
    smoothing = SMOOTHING,
    pluckThreshold = PLUCK_THRESHOLD,
    pluckGate = PLUCK_GATE,
    pluckResponse = PLUCK_RESPONSE,
    pluckDecay = PLUCK_DECAY,
} = {}) {
    let level = 0;
    let pluck = 0;
    let previous = 0;

    return {
        /**
         * Advance one frame.
         *
         * @param {number} target the latest reading, 0..1. Repeats are expected and
         *        correct — between two arrivals the same value is stepped six times, which
         *        is what turns ten readings a second into a continuous line.
         */
        step(target) {
            const wanted = clamp(target);

            // Onset BEFORE the smoothing, deliberately: the bounce belongs to the moment
            // somebody started talking, and reading it off the smoothed level would find
            // it several frames late and flattened by exactly the smoothing that hid it.
            if (wanted - previous > pluckThreshold && wanted > pluckGate) {
                pluck = Math.min(1, pluck + (wanted - previous) * pluckResponse);
            }
            previous = wanted;

            level += (wanted - level) * smoothing;
            pluck *= pluckDecay;
            return { level, pluck };
        },

        /** What the last step produced, without advancing. */
        read() { return { level, pluck }; },

        /** Force the bounce, for a string somebody struck by hand. */
        strike() { pluck = 1; },

        reset() { level = 0; pluck = 0; previous = 0; },
    };
}

const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * A set of traces, keyed however the caller keys its people.
 *
 * Exists so the room does not grow a Map plus the four lines that keep it honest. A trace
 * is created on first sight and dropped when its person is no longer being asked about —
 * otherwise a busy server accumulates one per account that ever spoke.
 */
export function createVoiceTraces(opts = {}) {
    const traces = new Map();

    return {
        /**
         * Step every id given, retire every id not given, and return the results in the
         * order asked for.
         *
         * @param {Array<{id: string, level: number}>} readings
         */
        step(readings) {
            const seen = new Set();
            const out = [];

            for (const { id, level } of readings) {
                seen.add(id);
                let trace = traces.get(id);
                if (!trace) { trace = createVoiceTrace(opts); traces.set(id, trace); }
                out.push({ id, ...trace.step(level) });
            }

            for (const id of traces.keys()) if (!seen.has(id)) traces.delete(id);
            return out;
        },

        strike(id) { traces.get(id)?.strike(); },
        get size() { return traces.size; },
        clear() { traces.clear(); },
    };
}
