// The noise gate, on the audio thread.
//
// An AudioWorkletProcessor: 128-sample blocks, no allocation in process(), and the
// decisions that make a gate sound like silence instead of like a fault:
//
//   - OPEN fast (~5ms). A gate that clips the first syllable teaches people to shout.
//   - HOLD before closing (~180ms). Speech is full of tiny gaps; closing inside them
//     turns a sentence into morse code.
//   - CLOSE slow (~120ms ramp). A hard cut at the end of a word is audible as a click.
//
// The threshold arrives as a parameter in dBFS (-100 quiet .. 0 loud) so the UI's
// sensitivity slider maps directly. Level telemetry posts back ~15 times a second for
// the settings meter — cheap, and only while someone is looking is it even rendered.

/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

class NoiseGate extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'thresholdDb', defaultValue: -55, minValue: -100, maxValue: 0 },
            { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1 },
        ];
    }

    constructor() {
        super();
        this.envelope = 0;        // smoothed input level, linear
        this.gain = 1;            // current gate gain, ramped
        this.holdUntil = 0;       // currentFrame until which the gate stays open
        this.framesSinceReport = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input.length) return true;

        const threshold = 10 ** (parameters.thresholdDb[0] / 20);
        const enabled = parameters.enabled[0] >= 0.5;

        // Envelope over the block: fast attack, slower release, so a syllable registers
        // instantly and the tail decays smoothly.
        let peak = 0;
        for (const sample of input[0]) {
            const magnitude = sample < 0 ? -sample : sample;
            if (magnitude > peak) peak = magnitude;
        }
        this.envelope = peak > this.envelope
            ? peak
            : this.envelope * 0.92 + peak * 0.08;

        const sampleFrames = input[0].length;
        const holdFrames = sampleRate * 0.18;
        const openStep = sampleFrames / (sampleRate * 0.005);
        const closeStep = sampleFrames / (sampleRate * 0.12);

        let target = 1;
        if (enabled) {
            if (this.envelope >= threshold) {
                this.holdUntil = currentFrame + holdFrames;
                target = 1;
            } else {
                target = currentFrame < this.holdUntil ? 1 : 0;
            }
        }
        this.gain = target > this.gain
            ? Math.min(1, this.gain + openStep)
            : Math.max(0, this.gain - closeStep);

        for (let channel = 0; channel < input.length; channel += 1) {
            const from = input[channel];
            const to = output[channel];
            for (let i = 0; i < from.length; i += 1) to[i] = from[i] * this.gain;
        }

        this.framesSinceReport += sampleFrames;
        if (this.framesSinceReport >= sampleRate / 15) {
            this.framesSinceReport = 0;
            this.port.postMessage({
                level: this.envelope,
                db: this.envelope > 0 ? 20 * Math.log10(this.envelope) : -100,
                open: this.gain > 0.5,
            });
        }
        return true;
    }
}

registerProcessor('weave-noise-gate', NoiseGate);
