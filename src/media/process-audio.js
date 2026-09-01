// Turn the process-audio sidecar's PCM stream into a MediaStreamTrack.
//
// The desktop shell captures ONE program's audio (see electron/app.js) and streams 48 kHz /
// 2ch / float32 over IPC. This builds the audio graph that carries it: an AudioWorklet fed by
// those bytes, into a MediaStreamDestination whose track is what gets produced as screen-audio
// — a track that, unlike the loopback mix, never contains Weave's own call.
//
// Returns null whenever it cannot deliver — not desktop, not Windows, the sidecar refused, the
// worklet would not load — so the caller falls back to the loopback track and the share is
// never lost to a capture that did not work.

import { platform } from '../platform/index.js';

// Bundled beside the app, exactly like the mic gate worklet; Vite turns this into a real URL.
const WORKLET_URL = new URL('./pcm-source-worklet.js', import.meta.url);

// Renderer failures here are otherwise invisible — they land in the devtools console, not the
// main log — which is exactly how a silent fall-back to loopback hid for a whole release. This
// puts the decision in the file the operator actually reads.
const note = (level, msg) => {
    try { globalThis.window?.weaveNative?.log?.(level, `[process-audio] ${msg}`); } catch { /* no bridge */ }
};

export function processAudioAvailable() {
    return Boolean(platform.processAudio?.available);
}

/**
 * Capture only the picked share source's audio and return { track, stop }, or null.
 *
 * `stop` tears the whole thing down — the sidecar, the IPC subscriptions, the graph and the
 * track — and is idempotent, so a teardown path that calls it twice is fine.
 */
export async function captureProcessAudio(sourceId) {
    const pa = platform.processAudio;
    if (!pa?.available || !sourceId) return null;

    const id = (globalThis.crypto?.randomUUID?.() ?? `pc-${Date.now()}-${Math.random()}`).slice(0, 32);

    // Subscribe to the end signal BEFORE starting, so an immediate refusal (bad handle, no
    // audio session) is not missed in the gap between start resolving and us listening.
    let ended = false;
    const offEnd = pa.onEnd(id, () => { ended = true; });

    const started = await pa.start({ id, sourceId }).catch((e) => { note('error', `start threw: ${e}`); return null; });
    if (!started?.ok || ended) {
        note('warn', `start refused (${started?.reason ?? (ended ? 'ended-immediately' : 'no-result')}); using loopback`);
        offEnd?.(); try { pa.stop(id); } catch { /* nothing to stop */ } return null;
    }

    // 48 kHz to match the sidecar exactly — no resampling, so the interleave stays honest.
    let ctx;
    try {
        ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
        note('error', `audio graph failed: ${err}; using loopback`);
        offEnd?.(); try { pa.stop(id); } catch { /* */ } try { await ctx?.close?.(); } catch { /* */ }
        return null;
    }

    const node = new AudioWorkletNode(ctx, 'pcm-source', { outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    // A context can start suspended under the autoplay policy; the worklet then never runs and
    // the track is silent. Starting a share is a user gesture, so resuming here is permitted.
    try { await ctx.resume(); } catch { /* best effort */ }

    // IPC delivers Node Buffers as byte arrays that may split mid-frame. Keep any trailing
    // bytes that are not a whole stereo float frame (8 bytes) and prepend them next time, so
    // the left/right interleave never drifts.
    let leftover = new Uint8Array(0);
    const offData = pa.onData(id, (buf) => {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let joined;
        if (leftover.length) {
            joined = new Uint8Array(leftover.length + u8.length);
            joined.set(leftover); joined.set(u8, leftover.length);
        } else {
            joined = u8;
        }
        const whole = joined.length - (joined.length % 8); // whole L/R float frames
        if (whole > 0) {
            const f32 = new Float32Array(whole / 4);
            new Uint8Array(f32.buffer).set(joined.subarray(0, whole));
            node.port.postMessage(f32, [f32.buffer]);
        }
        const rest = joined.subarray(whole);
        leftover = rest.length ? new Uint8Array(rest) : new Uint8Array(0);
    });

    const track = dest.stream.getAudioTracks()[0] ?? null;

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        try { offData?.(); } catch { /* */ }
        try { offEnd?.(); } catch { /* */ }
        try { pa.stop(id); } catch { /* */ }
        try { node.disconnect(); } catch { /* */ }
        try { track?.stop(); } catch { /* */ }
        try { ctx.close(); } catch { /* */ }
    };

    // If the sidecar died between start and here, do not hand back a track that will only ever
    // carry silence — let the caller fall back to loopback instead.
    if (ended || !track) {
        note('warn', `no usable track (${ended ? 'sidecar ended' : 'no track'}); using loopback`);
        stop(); return null;
    }
    note('info', `capturing via ${started.mode ?? '?'} for ${sourceId}`);
    return { track, stop };
}
