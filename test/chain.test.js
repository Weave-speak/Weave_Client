// The microphone chain: the maps the sliders live on, and the fallback contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sensitivityToDb, gainToLinear, createMicChain } from '../src/media/chain.js';

test('sensitivity maps linearly in decibels, clamped at both ends', () => {
    assert.equal(sensitivityToDb(0), -100, 'zero never gates anything audible');
    assert.equal(sensitivityToDb(100), -30, 'full only passes loud speech');
    assert.equal(sensitivityToDb(50), -65);
    assert.equal(sensitivityToDb(-5), -100);
    assert.equal(sensitivityToDb(500), -30);
    assert.equal(sensitivityToDb('nonsense'), -100, 'garbage reads as the safe end');
});

test('gain is unity at 100 and clamped to double', () => {
    assert.equal(gainToLinear(100), 1);
    assert.equal(gainToLinear(0), 0);
    assert.equal(gainToLinear(200), 2);
    assert.equal(gainToLinear(999), 2);
});

test('a chain that cannot build hands back the raw track and inert controls', async () => {
    // No AudioContext in node: the fallback IS the contract — a broken enhancement must
    // never cost the voice itself.
    const rawTrack = { kind: 'audio', id: 'raw' };
    const chain = await createMicChain(null, { getAudioTracks: () => [rawTrack] }, {});
    assert.equal(chain.track, rawTrack);
    assert.equal(chain.processed, false);
    assert.doesNotThrow(() => { chain.setGain(2); chain.setGate(true); chain.setThresholdDb(-40); chain.stop(); });

    const context = { audioWorklet: { addModule: async () => { throw new Error('no worklet'); } } };
    const failed = await createMicChain(context, { getAudioTracks: () => [rawTrack] }, { workletUrl: 'x' });
    assert.equal(failed.track, rawTrack, 'a failed worklet load degrades the same way');
    assert.equal(failed.processed, false);
});

// ── the gate itself, on a shimmed audio thread ───────────────────────────────
//
// The worklet is loaded by URL in the browser and never imported directly, so nothing
// exercised its process() until a stereo capture device turned the whole microphone into
// silence in production. These drive it the way the audio thread does.

let Registered = null;

async function loadGate() {
    // Memoised, because an ES module runs its body once per process: a second import()
    // returns the cached namespace and never calls registerProcessor again.
    if (Registered) return Registered;
    globalThis.AudioWorkletProcessor = class {
        constructor() { this.port = { postMessage() {}, onmessage: null }; }
    };
    globalThis.sampleRate = 48000;
    globalThis.currentFrame = 0;
    globalThis.registerProcessor = (_name, ctor) => { Registered = ctor; };
    await import('../src/media/gate-worklet.js');
    return Registered;
}

const block = (fill = 0) => Float32Array.from({ length: 128 }, () => fill);
const params = { thresholdDb: [-55], enabled: [0] };

test('a stereo microphone into a mono output does not kill the processor', async () => {
    const Gate = await loadGate();
    const gate = new Gate();

    // chain.js pins outputChannelCount to [1], but leaves channelCountMode at its default
    // 'max', so the node's INPUT follows the source. A stereo capture device — a USB
    // interface, a line-in, a headset driver exposing a stereo mix — therefore hands
    // process() two input channels against one output channel. Writing output[1] threw,
    // and Chromium answers a throw inside process() by never calling it again: the
    // produced track is silence for ever, with every API reporting success.
    const inputs = [[block(0.5), block(0.5)]];
    const outputs = [[block()]];

    assert.doesNotThrow(() => gate.process(inputs, outputs, params));
    assert.equal(gate.process(inputs, outputs, params), true, 'the processor stays alive');
    assert.ok(outputs[0][0].some((s) => s !== 0), 'and the mono output actually carries audio');
});

test('the gate never writes past the channels the output has', async () => {
    const Gate = await loadGate();
    const gate = new Gate();
    const inputs = [[block(0.5), block(0.5), block(0.5)]];
    const outputs = [[block()]];

    gate.process(inputs, outputs, params);
    assert.equal(outputs[0].length, 1, 'no channel is invented to match the input');
});
