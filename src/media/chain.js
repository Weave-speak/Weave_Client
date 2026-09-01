// The microphone chain: what sits between the device and the room.
//
//   device → [input gain 0–2×] → [optional: highpass → compressor → trim] → [noise gate]
//            → destination → the producer's track
//
// Chromium's own processing (echo cancellation, noise suppression, auto gain) runs
// INSIDE getUserMedia, before this chain — those stay constraints. This chain adds the
// three things constraints cannot do: a boost past unity for quiet microphones, a gate
// with a threshold the user can SEE against a live meter, and an opt-in tone shaping that
// stops one shouty person blasting the channel.
//
// The chain is built once and adjusted live: changing gain nudges an AudioParam, toggling
// the gate flips a parameter, toggling the shaping rewires three nodes — nothing
// re-produces, nothing re-prompts, and the person keeps talking through every adjustment.
// That is worth protecting, and it is why the shaping is Web Audio rather than the codec
// options the web app uses for the same feature: a codec option is negotiated once at
// produce() time, so changing one costs a closed producer and a gap in the conversation.

/** Map the settings slider (0–100) onto a gate threshold in dBFS. */
export function sensitivityToDb(value) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    // 0 = -100dB (gate never closes on anything audible), 100 = -30dB (only loud speech
    // passes). Linear in dB, which is how ears and meters both think.
    return -100 + (v * 0.7);
}

/** Map a gain slider (0–200, 100 = unity) onto the GainNode value. */
export function gainToLinear(value) {
    const v = Math.max(0, Math.min(200, Number(value) ?? 100));
    return v / 100;
}

/**
 * The compressor, in one place so the live graph and the calibration probe below cannot
 * drift apart.
 *
 * These numbers are MEASURED, and the obvious first guess was wrong. What matters is the
 * DIFFERENCE in gain reduction between quiet and loud speech; a compressor that pulls both
 * down equally just makes everyone quieter. Measured against quiet / normal / loud tones:
 *   threshold -24, ratio 4, knee 30  ->  only ~3 dB apart: useless
 *   threshold -30, ratio 6, knee 20  ->  ~15 dB apart: real
 * The wide knee was the trap — knee 30 starts compressing at -39 dB, below all speech, so
 * it compressed everything and evened out nothing.
 */
export const COMPRESSOR = Object.freeze({
    threshold: -30,
    knee: 20,
    ratio: 6,
    attack: 0.003,
    release: 0.25,
});

/** The amplitude taken to be ordinary speech, and the level the trim holds at unity. */
export const REFERENCE_AMPLITUDE = 0.25;

/**
 * What the trim falls back to when the engine cannot be measured.
 *
 * Chrome's DynamicsCompressorNode applies its own internal makeup gain, which is not in the
 * spec and not documented anywhere useful — so the shaped chain comes out HOTTER than the
 * plain one unless something takes it back off. That is the opposite of the point, and
 * actively worse, since a hotter signal drives a leaky monitoring path harder.
 *
 * The web app this is ported from hardcodes 0.37 for this. That number is right for the
 * Chrome it was measured on and wrong here: on Chrome 148 it lands ordinary speech about
 * 5 dB BELOW where it started, which is the "turning it on made me quiet" complaint that
 * feature has already had to fix twice. A number that depends on an undocumented internal
 * of one browser version has no business being a constant, so it is measured instead — see
 * measureCompressorTrim. This value is only the starting point, and what is used if the
 * measurement is unavailable.
 */
export const FALLBACK_COMPRESSOR_TRIM = 0.647;

/** Memoised: the makeup gain is a property of the engine, not of any one microphone. */
let measuredTrim = null;

/**
 * Measure how much the compressor lifts ordinary speech, so the trim can put it back.
 *
 * Renders half a second of a 500 Hz tone at REFERENCE_AMPLITUDE through the same nodes the
 * live graph uses, and reads the peak once the envelope has settled. An OfflineAudioContext
 * renders far faster than realtime — about 2 ms — and gives the same answer as measuring
 * the live graph by hand, which is what makes this worth doing at all.
 *
 * @returns {Promise<number>} the trim to apply, or the fallback if nothing can be measured.
 */
export async function measureCompressorTrim(Offline = globalThis.OfflineAudioContext) {
    if (measuredTrim !== null) return measuredTrim;
    try {
        const rate = 48000;
        const frames = Math.floor(rate * 0.5);
        const offline = new Offline(1, frames, rate);

        const osc = offline.createOscillator();
        osc.frequency.value = 500;
        const amp = offline.createGain();
        amp.gain.value = REFERENCE_AMPLITUDE;
        const highpass = offline.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 85;
        const compressor = offline.createDynamicsCompressor();
        for (const [name, value] of Object.entries(COMPRESSOR)) compressor[name].value = value;

        osc.connect(amp).connect(highpass).connect(compressor).connect(offline.destination);
        osc.start();

        const data = (await offline.startRendering()).getChannelData(0);
        // The last fifth of a second only: the first moments are the attack, not the
        // steady state the trim is meant to correct.
        let peak = 0;
        for (let i = frames - Math.floor(rate * 0.2); i < frames; i += 1) {
            const magnitude = Math.abs(data[i]);
            if (magnitude > peak) peak = magnitude;
        }
        if (!(peak > 0)) return FALLBACK_COMPRESSOR_TRIM;

        // Clamped, because a wild reading would be worse than the fallback: this multiplies
        // somebody's voice, and there is no upper bound on what a broken probe could say.
        measuredTrim = Math.max(0.1, Math.min(2, REFERENCE_AMPLITUDE / peak));
        return measuredTrim;
    } catch {
        return FALLBACK_COMPRESSOR_TRIM;
    }
}

/**
 * Build the chain around a microphone stream.
 *
 * Returns the processed TRACK to produce, plus live controls. If anything fails — no
 * AudioWorklet, a refused context — the raw track is returned and the controls become
 * no-ops: a broken enhancement must never cost the voice itself.
 */
export async function createMicChain(context, micStream, {
    workletUrl,
    gain = 1,
    gateEnabled = false,
    gateThresholdDb = -55,
    optimize = false,
    onTelemetry = () => {},
} = {}) {
    const [rawTrack] = micStream.getAudioTracks();
    const fallback = {
        track: rawTrack,
        processed: false,
        optimized: false,
        setGain() {}, setGate() {}, setThresholdDb() {}, setOptimize() {},
        stop() {},
    };
    if (!context || !rawTrack) return fallback;

    try {
        await context.audioWorklet.addModule(workletUrl);

        const source = context.createMediaStreamSource(micStream);
        const gainNode = context.createGain();
        gainNode.gain.value = Math.max(0, Math.min(2, gain));

        const gate = new AudioWorkletNode(context, 'weave-noise-gate', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            // channelCount + 'explicit' make the GRAPH do the downmix, before the
            // processor sees anything. Without them channelCountMode defaults to 'max',
            // which makes the node's input follow the source: a stereo capture device fed
            // process() two input channels against the one output pinned above, the write
            // to output[1] threw, and Chromium responds to a throw inside process() by
            // never calling it again — a producer track of pure silence, with every API
            // reporting success. Letting Web Audio mix is better than mixing by hand:
            // no channel arithmetic here, and it is correct for 3+ channel devices too.
            //
            // Mono is the right target and not a limitation: a microphone is one sound
            // source, and stereo capture would double the Opus bitrate to encode a phase
            // difference nobody wants in a voice mix.
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
        });
        gate.parameters.get('enabled').value = gateEnabled ? 1 : 0;
        gate.parameters.get('thresholdDb').value = gateThresholdDb;
        gate.port.onmessage = (event) => onTelemetry(event.data);

        const destination = context.createMediaStreamDestination();
        source.connect(gainNode);

        // The optional shaping stage, built on first use and then kept. Lazily, so somebody
        // who never turns it on has exactly the graph they always had; kept, so toggling it
        // twice does not churn nodes underneath a live conversation.
        let shaping = null;
        function buildShaping() {
            // ~85 Hz highpass: desk thumps, handling noise and mains hum all sit below
            // speech, and otherwise burn Opus bitrate on content nobody wants to hear.
            const highpass = context.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 85;

            // 6:1 above -30 dB, so one loud talker cannot blast the channel. See COMPRESSOR.
            const compressor = context.createDynamicsCompressor();
            for (const [name, value] of Object.entries(COMPRESSOR)) compressor[name].value = value;

            // Starts at the fallback and is corrected within a few milliseconds by a
            // measurement of THIS engine — see measureCompressorTrim for why a constant is
            // not good enough. Ramped rather than stepped, on the chance somebody is
            // already talking when the answer arrives.
            const trim = context.createGain();
            trim.gain.value = FALLBACK_COMPRESSOR_TRIM;
            measureCompressorTrim().then((value) => {
                trim.gain.setTargetAtTime(value, context.currentTime, 0.05);
            }).catch(() => { /* the fallback is already in place */ });

            highpass.connect(compressor).connect(trim);
            return { highpass, compressor, trim };
        }

        /**
         * Point the input gain at the gate, through the shaping stage or around it.
         *
         * Measured end to end through the real worklet at 500 Hz on Chrome 148, shaped
         * against plain, with the trim calibrated. By input amplitude:
         *   0.02  +6.0 dB   0.05  +5.7   0.15  +2.8   0.25  0.0   0.5  -4.9   0.9  -9.1
         * Fifteen decibels between a whisper and a shout, which is the entire point, and
         * ordinary speech landing exactly where it went in, which is the constraint — the
         * two previous attempts at this feature elsewhere both failed on the second half.
         * Off, the graph is the original two nodes exactly.
         */
        let shaped = false;
        function wire(on) {
            if (on && !shaping) shaping = buildShaping();
            try { gainNode.disconnect(); } catch { /* nothing attached yet */ }
            if (shaping) { try { shaping.trim.disconnect(); } catch { /* idem */ } }
            if (on) {
                gainNode.connect(shaping.highpass);
                shaping.trim.connect(gate);
            } else {
                gainNode.connect(gate);
            }
            shaped = on;
        }
        wire(Boolean(optimize));
        gate.connect(destination);

        const [track] = destination.stream.getAudioTracks();
        if (!track) return fallback;
        console.warn('[weave] mic chain active (gate wired, telemetry on)');

        return {
            track,
            processed: true,
            get optimized() { return shaped; },
            setGain(linear) {
                // A short ramp: a gain step lands as a click without one.
                gainNode.gain.setTargetAtTime(Math.max(0, Math.min(2, linear)), context.currentTime, 0.03);
            },
            setGate(enabled) {
                gate.parameters.get('enabled').value = enabled ? 1 : 0;
            },
            setThresholdDb(db) {
                gate.parameters.get('thresholdDb').value = Math.max(-100, Math.min(0, db));
            },
            setOptimize(enabled) {
                const on = Boolean(enabled);
                if (on !== shaped) wire(on);
            },
            stop() {
                try { source.disconnect(); } catch { /* closing */ }
                try { gainNode.disconnect(); } catch { /* closing */ }
                try { shaping?.highpass.disconnect(); } catch { /* closing */ }
                try { shaping?.compressor.disconnect(); } catch { /* closing */ }
                try { shaping?.trim.disconnect(); } catch { /* closing */ }
                try { gate.disconnect(); } catch { /* closing */ }
                try { gate.port.onmessage = null; } catch { /* closing */ }
            },
        };
    } catch (err) {
        // Falling back is correct; falling back SILENTLY cost a debugging session. One
        // line names the reason the enhancement is off.
        console.warn('[weave] mic chain fell back to the raw track:', err?.message ?? err);
        return fallback;
    }
}
