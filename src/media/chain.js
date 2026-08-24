// The microphone chain: what sits between the device and the room.
//
//   device → [input gain 0–2×] → [noise gate] → destination → the producer's track
//
// Chromium's own processing (echo cancellation, noise suppression, auto gain) runs
// INSIDE getUserMedia, before this chain — those stay constraints. This chain adds the
// two things constraints cannot do: a boost past unity for quiet microphones, and a gate
// with a threshold the user can SEE against a live meter.
//
// The chain is built once and adjusted live: changing gain nudges an AudioParam,
// toggling the gate flips a parameter — nothing re-produces, nothing re-prompts, and the
// person keeps talking through every adjustment.

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
    onTelemetry = () => {},
} = {}) {
    const [rawTrack] = micStream.getAudioTracks();
    const fallback = {
        track: rawTrack,
        processed: false,
        setGain() {}, setGate() {}, setThresholdDb() {},
        stop() {},
    };
    if (!context || !rawTrack) return fallback;

    try {
        await context.audioWorklet.addModule(workletUrl);

        const source = context.createMediaStreamSource(micStream);
        const gainNode = context.createGain();
        gainNode.gain.value = Math.max(0, Math.min(2, gain));

        const gate = new AudioWorkletNode(context, 'weave-noise-gate', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        });
        gate.parameters.get('enabled').value = gateEnabled ? 1 : 0;
        gate.parameters.get('thresholdDb').value = gateThresholdDb;
        gate.port.onmessage = (event) => onTelemetry(event.data);

        const destination = context.createMediaStreamDestination();
        source.connect(gainNode).connect(gate).connect(destination);

        const [track] = destination.stream.getAudioTracks();
        if (!track) return fallback;

        return {
            track,
            processed: true,
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
            stop() {
                try { source.disconnect(); } catch { /* closing */ }
                try { gainNode.disconnect(); } catch { /* closing */ }
                try { gate.disconnect(); } catch { /* closing */ }
                try { gate.port.onmessage = null; } catch { /* closing */ }
            },
        };
    } catch {
        return fallback;
    }
}
