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
        source.connect(gainNode).connect(gate).connect(destination);

        const [track] = destination.stream.getAudioTracks();
        if (!track) return fallback;
        console.warn('[weave] mic chain active (gate wired, telemetry on)');

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
    } catch (err) {
        // Falling back is correct; falling back SILENTLY cost a debugging session. One
        // line names the reason the enhancement is off.
        console.warn('[weave] mic chain fell back to the raw track:', err?.message ?? err);
        return fallback;
    }
}
