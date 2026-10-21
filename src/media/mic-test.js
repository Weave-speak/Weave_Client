// "Test my setup": hear yourself the way the room hears you.
//
// Ported from the web app's runMicSetupTest, which existed because people kept asking the
// room "can you hear me?" — and the room is the worst instrument for answering that, being
// made of people who are polite, busy, or wearing headphones that hide a hum.
//
// It runs WITHOUT being in a voice room, opens the microphone exactly as the room does
// (micConstraints), and records what comes out of the same processing chain the room
// sends — gain, gate, shaping — rather than the raw device. A test of the raw device would
// pass while the gate was shut, which is the one failure people most need it to catch.
//
// Three listening windows, then a playback:
//   1. the room, quietly — a baseline for what the microphone hears when nobody speaks;
//   2. a short tone through the chosen output, to find out whether the microphone hears
//      the speakers (and therefore whether the room hears itself through you);
//   3. five seconds of you, recorded from the processed track.
//
// Nothing is sent anywhere. The judgement is a pure function, below, so it can be tested
// without a microphone; the runner is the only part that needs one.

import { createMicChain, sensitivityToDb, gainToLinear, levelToDb } from './chain.js';
import { micConstraints } from './audio-options.js';

const GATE_WORKLET_URL = new URL('./gate-worklet.js', import.meta.url);

/** How long you are recorded for. The web app's five seconds: a sentence and a pause. */
export const RECORD_MS = 5000;
const BASELINE_MS = 700;
const TONE_MS = 1500;
const SAMPLE_MS = 50;

/** Nothing at all reached the chain: an unplugged, muted or wrong device. */
export const SILENT_DB = -60;
/** Speech that peaks below this is hard to hear beside anybody at a normal level. */
export const QUIET_DB = -30;
/** How much louder the room must get while the tone plays to count as hearing the speakers. */
export const BLEED_DB = 15;
/** A sample this close to full scale is a clipped one. */
const CLIP_LEVEL = 0.98;

/**
 * Input devices that are the computer's own output looped back in. Picking one as a
 * microphone sends the room whatever the computer is playing — including the room.
 */
const LOOPBACK_NAMES = /stereo mix|what u hear|wave out|loopback|cable output|voicemeeter|virtual audio/i;

export const looksLikeLoopback = (label) => LOOPBACK_NAMES.test(String(label ?? ''));

const peakOf = (levels = []) => levels.reduce((m, v) => (v > m ? v : m), 0);

/**
 * The verdict, from what was measured.
 *
 * @param {object}   m
 * @param {string}   m.label        the device's name, as the browser gives it
 * @param {number[]} m.raw          peak levels (0–1) straight off the device, while recording
 * @param {number[]} m.sent         peak levels of the PROCESSED track, while recording
 * @param {number[]} m.baseline     raw levels with nobody speaking
 * @param {number[]} m.duringTone   raw levels while the tone played
 * @param {boolean}  m.processed    whether the chain built (false = raw track is what is sent)
 * @param {boolean}  m.gateEnabled
 * @param {string[]} m.ignored      constraints asked for that the device did not apply
 * @returns {{ verdict: 'good'|'warn'|'bad', findings: Array<{tone: string, text: string}> }}
 */
export function assessMicTest({
    label = '', raw = [], sent = [], baseline = [], duringTone = [],
    processed = true, gateEnabled = false, ignored = [],
} = {}) {
    const findings = [];
    const rawDb = levelToDb(peakOf(raw));
    const sentDb = levelToDb(peakOf(sent));

    if (looksLikeLoopback(label)) {
        findings.push({
            tone: 'bad',
            text: `"${label}" records what your computer plays, not your voice. Pick your real microphone above.`,
        });
    }

    if (rawDb <= SILENT_DB) {
        findings.push({
            tone: 'bad',
            text: 'Nothing was heard. Check that the right input device is chosen and that it is not muted on the device itself.',
        });
    } else if (processed && sentDb <= SILENT_DB) {
        // The microphone heard you and the chain sent nothing: the case this test exists for.
        findings.push(gateEnabled
            ? { tone: 'warn', text: 'The noise gate never opened while you spoke. Drag Sensitivity lower until the bar crosses the line when you talk.' }
            : { tone: 'bad', text: 'Your microphone heard you, but the processing sent silence. Turn Sound optimisation off and test again; if it is still silent, please report a bug.' });
    } else if (rawDb < QUIET_DB) {
        findings.push({
            tone: 'warn',
            text: 'You are quiet. Raise Input gain, or move a little closer to the microphone.',
        });
    }

    if (raw.filter((v) => v >= CLIP_LEVEL).length >= 3) {
        findings.push({
            tone: 'warn',
            text: 'You are clipping — the loudest parts are distorting. Lower Input gain a little.',
        });
    }

    if (duringTone.length && baseline.length
        && levelToDb(peakOf(duringTone)) - levelToDb(peakOf(baseline)) >= BLEED_DB) {
        findings.push({
            tone: 'warn',
            text: 'Your microphone hears your speakers, so the room can hear itself through you. Headphones fix it; keeping Echo cancellation on helps.',
        });
    }

    if (ignored.length) {
        findings.push({
            tone: 'quiet',
            text: `Your device ignored: ${ignored.join(', ')}. That is the device's choice, not a fault here.`,
        });
    }

    const verdict = findings.some((f) => f.tone === 'bad') ? 'bad'
        : findings.some((f) => f.tone === 'warn') ? 'warn'
            : 'good';
    if (verdict === 'good') {
        findings.unshift({ tone: 'good', text: 'Sounds healthy. Listen to the playback to be sure it sounds like you.' });
    }
    return { verdict, findings };
}

/** Which asked-for processing the device declined, in words. */
export function ignoredConstraints(asked = {}, got = {}) {
    const names = {
        echoCancellation: 'echo cancellation',
        noiseSuppression: 'noise suppression',
        autoGainControl: 'automatic gain',
    };
    return Object.entries(names)
        .filter(([key]) => asked[key] === true && got[key] === false)
        .map(([, name]) => name);
}

/* ── the runner: the part that needs a microphone ─────────────────────── */

/** A peak meter on a stream, read on demand. */
function peakMeter(context, stream) {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
        read() {
            analyser.getFloatTimeDomainData(buffer);
            let peak = 0;
            for (const sample of buffer) {
                const magnitude = sample < 0 ? -sample : sample;
                if (magnitude > peak) peak = magnitude;
            }
            return peak;
        },
        stop() { try { source.disconnect(); } catch { /* closing */ } },
    };
}

/** Sample `meters` every SAMPLE_MS for `ms`, unless cancelled. */
function collect(meters, ms, signal) {
    const out = meters.map(() => []);
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(out); return; }
        const timer = setInterval(() => {
            meters.forEach((meter, i) => out[i].push(meter.read()));
        }, SAMPLE_MS);
        const done = () => { clearInterval(timer); resolve(out); };
        setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * A short rising tone through the chosen output, so the microphone can be caught hearing
 * the speakers. Quiet on purpose — loud enough to measure, not enough to make anybody jump.
 */
async function playTone(context, outputId, ms) {
    if (outputId && context.setSinkId) await context.setSinkId(outputId).catch(() => {});
    const osc = context.createOscillator();
    const level = context.createGain();
    level.gain.value = 0;
    osc.frequency.setValueAtTime(300, context.currentTime);
    osc.frequency.exponentialRampToValueAtTime(3000, context.currentTime + ms / 1000);
    level.gain.setTargetAtTime(0.2, context.currentTime, 0.02);
    level.gain.setTargetAtTime(0, context.currentTime + ms / 1000 - 0.1, 0.03);
    osc.connect(level).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + ms / 1000);
}

/**
 * Run the whole test.
 *
 * @param {object}   options
 * @param {object}   options.prefs     this device's settings: device, flags, chain
 * @param {Function} options.onPhase   called with 'room' | 'tone' | 'speak' as each starts
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ verdict, findings, recording: Blob|null }>}
 */
export async function runMicTest({ prefs = {}, onPhase = () => {}, signal } = {}) {
    const asked = micConstraints(prefs);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: asked });
    const [track] = stream.getAudioTracks();
    const context = new AudioContext();
    let chain = null;
    const meters = [];
    try {
        await context.resume().catch(() => {});
        chain = await createMicChain(context, stream, {
            workletUrl: GATE_WORKLET_URL,
            gain: gainToLinear(prefs.micGain ?? 100),
            gateEnabled: Boolean(prefs.noiseGate),
            gateThresholdDb: sensitivityToDb(prefs.gateSensitivity ?? 64),
            optimize: Boolean(prefs.voiceOptimize),
        });
        const raw = peakMeter(context, stream);
        // The track the room would be SENT, metered after the gate — the one place a shut
        // gate or a silent worklet shows up.
        const sentStream = new MediaStream([chain.track]);
        const sent = peakMeter(context, sentStream);
        meters.push(raw, sent);

        onPhase('room');
        const [baseline] = await collect([raw], BASELINE_MS, signal);
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        onPhase('tone');
        await playTone(context, prefs.audioOutput, TONE_MS);
        const [duringTone] = await collect([raw], TONE_MS, signal);
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        onPhase('speak');
        const recorder = typeof MediaRecorder === 'function' ? new MediaRecorder(sentStream) : null;
        const chunks = [];
        if (recorder) {
            recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
            recorder.start();
        }
        const [rawLevels, sentLevels] = await collect([raw, sent], RECORD_MS, signal);
        const stopped = recorder
            ? new Promise((resolve) => { recorder.onstop = resolve; })
            : Promise.resolve();
        if (recorder?.state === 'recording') recorder.stop();
        await stopped;
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        const result = assessMicTest({
            label: track?.label ?? '',
            raw: rawLevels,
            sent: sentLevels,
            baseline,
            duringTone,
            processed: chain.processed,
            gateEnabled: Boolean(prefs.noiseGate),
            ignored: ignoredConstraints(asked, track?.getSettings?.() ?? {}),
        });
        return {
            ...result,
            recording: chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null,
        };
    } finally {
        for (const meter of meters) meter.stop();
        chain?.stop();
        for (const t of stream.getTracks()) t.stop();
        context.close().catch(() => {});
    }
}
