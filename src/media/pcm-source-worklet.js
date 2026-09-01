// Plays a stream of interleaved float32 stereo PCM as an audio node.
//
// The process-audio sidecar emits 48 kHz / 2ch / float32 over IPC; this buffers it and hands
// it to the audio graph at the graph's own pace. A ring buffer decouples the two clocks: the
// sidecar delivers in ~20 ms bursts, the graph pulls 128 frames at a time, and neither should
// stall the other. Underrun outputs silence (a gap, not a click); overflow drops the oldest
// (a captured burst is not worth an ever-growing latency).

/* global AudioWorkletProcessor, registerProcessor */

class PcmSourceProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // ~2 seconds of interleaved stereo headroom. Generous: the steady state sits far below
        // this, and the cap only matters if the graph pauses (tab hidden) while data keeps coming.
        this.capacity = 48000 * 2 * 2;
        this.buf = new Float32Array(this.capacity);
        this.readIdx = 0;
        this.writeIdx = 0;
        this.filled = 0;
        this.port.onmessage = (e) => {
            const data = e.data;
            if (!data) return;
            const s = data instanceof Float32Array ? data : new Float32Array(data);
            for (let i = 0; i < s.length; i++) {
                if (this.filled >= this.capacity) { // overflow: drop oldest sample
                    this.readIdx = (this.readIdx + 1) % this.capacity;
                    this.filled--;
                }
                this.buf[this.writeIdx] = s[i];
                this.writeIdx = (this.writeIdx + 1) % this.capacity;
                this.filled++;
            }
        };
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length === 0) return true;
        const left = out[0];
        const right = out.length > 1 ? out[1] : null;
        const frames = left.length;
        for (let i = 0; i < frames; i++) {
            if (this.filled >= 2) {
                const l = this.buf[this.readIdx]; this.readIdx = (this.readIdx + 1) % this.capacity;
                const r = this.buf[this.readIdx]; this.readIdx = (this.readIdx + 1) % this.capacity;
                this.filled -= 2;
                left[i] = l;
                if (right) right[i] = r;
            } else {
                left[i] = 0;
                if (right) right[i] = 0;
            }
        }
        return true;
    }
}

registerProcessor('pcm-source', PcmSourceProcessor);
