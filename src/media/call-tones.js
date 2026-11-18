// The sounds of a call that has not started yet: ringback for the caller (the phone at the
// other end is ringing), and the ring itself on a computer.
//
// Made from oscillators rather than shipped as files: a ring is two sine waves and a
// rhythm, and synthesising it costs nothing to the installer or to the update delta. On
// the Android app the incoming ring is the phone's own ringtone instead (IncomingCall.kt),
// which obeys the ringer switch and Do Not Disturb as no page sound can.

/**
 * One cycle of each tone, as notes: [startMs, endMs, frequencies]. The cycle repeats.
 *
 * Ringback is the European one (a single 425 Hz tone, one second on, four off): heard on
 * mobile calls across most of the world, and recognisable as "it is ringing" rather than
 * as a melody. The ring is a quick two-note trill, twice, then silence — distinct from the
 * message chime, so the two are never confused from across a room.
 */
export const TONES = Object.freeze({
    ringback: { cycleMs: 5_000, notes: [[0, 1_000, [425]]] },
    ring: {
        cycleMs: 4_000,
        notes: [
            [0, 120, [784, 988]], [160, 280, [659, 784]],
            [320, 440, [784, 988]], [480, 600, [659, 784]],
            [1_000, 1_120, [784, 988]], [1_160, 1_280, [659, 784]],
            [1_320, 1_440, [784, 988]], [1_480, 1_600, [659, 784]],
        ],
    },
});

/**
 * Every note of a tone that sounds between two moments since it started, with absolute
 * times. Pure, so the rhythm is tested rather than listened to.
 *
 * @returns {{start: number, end: number, freqs: number[]}[]}
 */
export function toneNotes(kind, fromMs, toMs) {
    const tone = TONES[kind];
    if (!tone || toMs <= fromMs) return [];
    const out = [];
    const first = Math.floor(fromMs / tone.cycleMs);
    const last = Math.floor((toMs - 1) / tone.cycleMs);
    for (let cycle = first; cycle <= last; cycle += 1) {
        const base = cycle * tone.cycleMs;
        for (const [s, e, freqs] of tone.notes) {
            const start = base + s;
            const end = base + e;
            if (end > fromMs && start < toMs) out.push({ start, end, freqs });
        }
    }
    return out;
}

/**
 * Play a tone until stopped. Schedules a little ahead on the audio clock, so a busy page or
 * a throttled timer stretches nothing.
 *
 * @param {'ringback'|'ring'} kind
 * @param {{ context?: AudioContext, volume?: number }} options
 * @returns {{ stop(): void }}
 */
export function playTone(kind, { context = null, volume = 0.18 } = {}) {
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    const ctx = context ?? (Ctx ? new Ctx() : null);
    if (!ctx) return { stop() {} };
    const owned = !context;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(ctx.destination);

    const startedAt = ctx.currentTime;
    let scheduledTo = 0;
    const LOOKAHEAD_MS = 1_500;
    const nodes = new Set();

    const schedule = () => {
        const nowMs = (ctx.currentTime - startedAt) * 1000;
        const until = nowMs + LOOKAHEAD_MS;
        for (const note of toneNotes(kind, scheduledTo, until)) {
            if (note.start < scheduledTo) continue;
            for (const freq of note.freqs) {
                const osc = ctx.createOscillator();
                const env = ctx.createGain();
                osc.frequency.value = freq;
                const t0 = startedAt + note.start / 1000;
                const t1 = startedAt + note.end / 1000;
                // A few milliseconds of ramp at each end, or every note starts with a click.
                env.gain.setValueAtTime(0, t0);
                env.gain.linearRampToValueAtTime(1 / note.freqs.length, t0 + 0.008);
                env.gain.setValueAtTime(1 / note.freqs.length, Math.max(t0 + 0.008, t1 - 0.012));
                env.gain.linearRampToValueAtTime(0, t1);
                osc.connect(env).connect(out);
                osc.start(t0);
                osc.stop(t1 + 0.01);
                nodes.add(osc);
                osc.onended = () => nodes.delete(osc);
            }
        }
        scheduledTo = until;
    };

    ctx.resume?.().catch?.(() => {});
    schedule();
    const timer = setInterval(schedule, 500);

    return {
        stop() {
            clearInterval(timer);
            for (const osc of nodes) {
                try { osc.stop(); } catch { /* already stopped */ }
            }
            nodes.clear();
            try { out.disconnect(); } catch { /* already gone */ }
            if (owned) ctx.close?.().catch?.(() => {});
        },
    };
}
