// The microphone chain: the maps the sliders live on, and the fallback contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sensitivityToDb, dbToMeterPercent, levelToDb, gainToLinear, createMicChain,
    GATE_FLOOR_DB, GATE_CEILING_DB,
    COMPRESSOR, FALLBACK_COMPRESSOR_TRIM, REFERENCE_AMPLITUDE, measureCompressorTrim,
} from '../src/media/chain.js';

test('sensitivity maps linearly in decibels, clamped at both ends', () => {
    assert.equal(sensitivityToDb(0), GATE_FLOOR_DB, 'zero never gates anything audible');
    assert.equal(sensitivityToDb(100), GATE_CEILING_DB, 'full only passes loud speech');
    assert.equal(sensitivityToDb(50), -50);
    assert.equal(sensitivityToDb(-5), GATE_FLOOR_DB);
    assert.equal(sensitivityToDb(500), GATE_CEILING_DB);
    assert.equal(sensitivityToDb('nonsense'), GATE_FLOOR_DB, 'garbage reads as the safe end');
});

test('the gate can reject the noise a real room actually makes', () => {
    // The old ceiling was -30 dBFS, and that was the whole bug behind "the gate is too
    // sensitive": measured, broadband noise at -30.7 dBFS RMS peaks around -26, so at 100
    // out of 100 on the slider the gate still never closed. A gate whose maximum cannot
    // reject a fan is not a gate.
    assert.ok(sensitivityToDb(100) >= -20, 'the top must clear ordinary room noise');
    assert.ok(sensitivityToDb(0) <= -80, 'and the bottom must still mean "never close"');
});

test('the meter scale is exactly the inverse of the threshold scale', () => {
    // These were two separate pieces of arithmetic over two different ranges, which is how
    // the bar and the line came to describe different sounds. Round-tripping every slider
    // position is the assertion that they are now one scale.
    for (let slider = 0; slider <= 100; slider += 5) {
        assert.equal(Math.round(dbToMeterPercent(sensitivityToDb(slider))), slider);
    }
    assert.equal(dbToMeterPercent(GATE_FLOOR_DB - 20), 0, 'quieter than the floor pins at empty');
    assert.equal(dbToMeterPercent(GATE_CEILING_DB + 20), 100, 'louder than the ceiling pins at full');
    assert.equal(dbToMeterPercent(undefined), 0, 'and nothing readable draws nothing');
});

test('silence reads as the floor rather than negative infinity', () => {
    assert.equal(levelToDb(0), GATE_FLOOR_DB);
    assert.equal(levelToDb(1), 0, 'full scale is 0 dBFS');
    assert.equal(Math.round(levelToDb(0.1)), -20);
    assert.equal(levelToDb('nonsense'), GATE_FLOOR_DB);
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
    assert.doesNotThrow(() => {
        chain.setGain(2); chain.setGate(true); chain.setThresholdDb(-40);
        chain.setOptimize(true); chain.stop();
    });

    const context = { audioWorklet: { addModule: async () => { throw new Error('no worklet'); } } };
    const failed = await createMicChain(context, { getAudioTracks: () => [rawTrack] }, { workletUrl: 'x' });
    assert.equal(failed.track, rawTrack, 'a failed worklet load degrades the same way');
    assert.equal(failed.processed, false);
});

// ── the shaping stage, on a shimmed graph ────────────────────────────────────
//
// The interesting part of Sound Optimisation is not the filter values, it is that turning
// it on and off rewires a graph underneath somebody who is mid-sentence. A hand-rolled
// shim is enough to assert the wiring, and cheaper than a browser.

function shimContext() {
    const nodes = [];
    const make = (kind, extra = {}) => {
        const node = {
            kind, out: new Set(),
            connect(target) { node.out.add(target); return target; },
            disconnect() { node.out.clear(); },
            ...extra,
        };
        nodes.push(node);
        return node;
    };
    const param = (value) => ({ value, setTargetAtTime() {} });
    const context = {
        currentTime: 0,
        nodes,
        audioWorklet: { addModule: async () => {} },
        createMediaStreamSource: () => make('source'),
        createGain: () => make('gain', { gain: param(1) }),
        createBiquadFilter: () => make('highpass', { type: '', frequency: param(0) }),
        createDynamicsCompressor: () => make('compressor', {
            threshold: param(0), knee: param(0), ratio: param(0), attack: param(0), release: param(0),
        }),
        createAnalyser: () => make('analyser', {
            fftSize: 0,
            // A steady 0.5 so readLevel() has something to find a peak in.
            getFloatTimeDomainData(buf) { buf.fill(0.5); },
        }),
        createMediaStreamDestination: () => make('destination', {
            stream: { getAudioTracks: () => [{ kind: 'audio', id: 'processed' }] },
        }),
    };
    globalThis.AudioWorkletNode = class {
        constructor() {
            const node = make('gate', {
                parameters: new Map([['enabled', param(0)], ['thresholdDb', param(-55)]]),
                port: { onmessage: null },
            });
            return node;
        }
    };
    return context;
}

const gateOf = (ctx) => ctx.nodes.find((n) => n.kind === 'gate');
const meterOf = (ctx) => ctx.nodes.find((n) => n.kind === 'analyser');
const inputGainOf = (ctx) => ctx.nodes.find((n) => n.kind === 'gain');
const feeds = (from, to) => Boolean(from && to && from.out.has(to));

test('shaping off is the plain two-node graph, and building it costs nothing', async () => {
    const ctx = shimContext();
    const chain = await createMicChain(ctx, { getAudioTracks: () => [{ id: 'raw' }] }, { workletUrl: 'x' });

    assert.equal(chain.processed, true);
    assert.equal(chain.optimized, false);
    assert.ok(feeds(inputGainOf(ctx), gateOf(ctx)), 'gain goes straight to the gate');
    assert.equal(ctx.nodes.some((n) => n.kind === 'compressor'), false,
        'somebody who never turns it on never gets the nodes');
});

test('the meter reads whatever the gate reads, in both wirings', async () => {
    // THE BUG THIS EXISTS FOR: the meter used to be tapped on the raw microphone while the
    // gate judged the signal after the input gain. Turning the gain down moved the gate and
    // never moved the bar, so the threshold line was drawn against a sound nobody was
    // gating. Whatever feeds the gate must also feed the meter — in both wirings, because
    // disconnect() drops every output a node has and it would be easy to reattach one path
    // and forget the other.
    const ctx = shimContext();
    const chain = await createMicChain(ctx, { getAudioTracks: () => [{ id: 'raw' }] }, { workletUrl: 'x' });
    const gate = gateOf(ctx);
    const meter = meterOf(ctx);

    const inputGain = inputGainOf(ctx);
    assert.ok(feeds(inputGain, gate) && feeds(inputGain, meter), 'plain: one source, both taps');

    chain.setOptimize(true);
    const trim = ctx.nodes.filter((n) => n.kind === 'gain').at(-1);
    assert.ok(feeds(trim, gate) && feeds(trim, meter), 'shaped: still one source, both taps');
    assert.equal(feeds(inputGain, meter), false, 'and the old tap is gone, not left doubled');

    chain.setOptimize(false);
    assert.ok(feeds(inputGain, gate) && feeds(inputGain, meter), 'and back again');
    assert.equal(feeds(trim, meter), false);

    // The reading itself is a peak, matching the gate's own envelope rather than the RMS
    // the meter used to report about 12 dB hot.
    assert.equal(chain.readLevel(), 0.5);
});

test('turning shaping on splices the filter stage in, and off takes it back out', async () => {
    const ctx = shimContext();
    const chain = await createMicChain(ctx, { getAudioTracks: () => [{ id: 'raw' }] }, { workletUrl: 'x' });
    const gate = gateOf(ctx);
    const inputGain = inputGainOf(ctx);

    chain.setOptimize(true);
    const highpass = ctx.nodes.find((n) => n.kind === 'highpass');
    const compressor = ctx.nodes.find((n) => n.kind === 'compressor');
    const trim = ctx.nodes.filter((n) => n.kind === 'gain').at(-1);

    assert.equal(chain.optimized, true);
    assert.equal(feeds(inputGain, gate), false, 'the gain no longer bypasses the stage');
    assert.ok(feeds(inputGain, highpass) && feeds(highpass, compressor) && feeds(compressor, trim));
    assert.ok(feeds(trim, gate), 'and the stage lands back on the gate');

    // The measured values. -24/4/30 was the first draft and evened out nothing, because a
    // 30 dB knee starts compressing below all speech; see chain.js.
    assert.equal(highpass.type, 'highpass');
    assert.equal(highpass.frequency.value, 85);
    assert.deepEqual(
        [compressor.threshold.value, compressor.ratio.value, compressor.knee.value],
        [-30, 6, 20],
    );
    assert.equal(trim.gain.value, FALLBACK_COMPRESSOR_TRIM, 'Chrome compressors come out hot without it');

    chain.setOptimize(false);
    assert.equal(chain.optimized, false);
    assert.ok(feeds(inputGain, gate), 'back to the plain graph');
    assert.equal(feeds(trim, gate), false, 'with the stage detached rather than left dangling');
});

// ── the compressor trim ──────────────────────────────────────────────────────
//
// The web app this is ported from hardcodes 0.37 here. That is correct for the Chrome it
// was measured on and about 5 dB wrong on Chrome 148 — which lands ordinary speech BELOW
// where it started, the "turning it on made me quiet" complaint that feature has already
// had to fix twice. Chrome's compressor makeup gain is an undocumented internal, so the
// only honest constant is one measured on whatever engine is actually running.
//
// These three run in this order on purpose: the measurement is memoised (it is a property
// of the engine, not of a microphone), so the failure path has to be asserted while
// nothing has been measured yet.

const trimShim = (rendered) => {
    const node = () => ({
        connect(target) { return target; }, start() {},
        type: '', frequency: { value: 0 }, gain: { value: 0 },
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
        attack: { value: 0 }, release: { value: 0 },
    });
    return class Offline {
        constructor() { this.destination = node(); }
        createOscillator() { return node(); }
        createGain() { return node(); }
        createBiquadFilter() { return node(); }
        createDynamicsCompressor() { return node(); }
        async startRendering() { return { getChannelData: () => rendered }; }
    };
};

test('an engine that cannot be measured falls back rather than failing', async () => {
    class Broken { constructor() { throw new Error('no OfflineAudioContext here'); } }
    assert.equal(await measureCompressorTrim(Broken), FALLBACK_COMPRESSOR_TRIM);
});

test('the compressor trim is measured off the engine, not assumed', async () => {
    // A compressor that renders the reference amplitude back at twice its size needs a
    // trim of one half to put ordinary speech back where it came in.
    const rendered = new Float32Array(48000 * 0.5).fill(REFERENCE_AMPLITUDE * 2);
    assert.equal(await measureCompressorTrim(trimShim(rendered)), 0.5);
});

test('the measurement is taken once, because it describes the engine', async () => {
    // A different answer from a second probe must not move somebody's voice mid-call.
    const other = new Float32Array(48000 * 0.5).fill(REFERENCE_AMPLITUDE * 4);
    assert.equal(await measureCompressorTrim(trimShim(other)), 0.5, 'the first answer stands');
});

test('the compressor settings the probe uses are the ones the graph uses', () => {
    // Two copies of these numbers would drift, and the trim would then be correcting for a
    // compressor nobody is listening through.
    assert.deepEqual(COMPRESSOR, { threshold: -30, knee: 20, ratio: 6, attack: 0.003, release: 0.25 });
    assert.ok(FALLBACK_COMPRESSOR_TRIM > 0 && FALLBACK_COMPRESSOR_TRIM < 1);
});

test('toggling shaping twice does not rebuild the nodes', async () => {
    // Kept rather than rebuilt, because this happens under a live conversation.
    const ctx = shimContext();
    const chain = await createMicChain(ctx, { getAudioTracks: () => [{ id: 'raw' }] }, { workletUrl: 'x' });
    chain.setOptimize(true);
    const built = ctx.nodes.length;
    chain.setOptimize(true);
    chain.setOptimize(false);
    chain.setOptimize(true);
    assert.equal(ctx.nodes.length, built);
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

test('a level between the two bars keeps the gate open', async () => {
    // Hysteresis. Opening and closing on one number means a voice resting exactly on the
    // line — which is what the end of a sentence does — chatters the gate several times a
    // second. The bar to STAY open is 85% of the bar to open, so there is a band the level
    // can sit in without either.
    //
    // Threshold -20 dBFS is 0.1 linear, so the band is 0.085 to 0.1. Blocks are driven
    // well past the 180 ms hold, so what is being measured is the band and not the hold.
    const Gate = await loadGate();
    const on = { thresholdDb: [-20], enabled: [1] };
    const run = (gate, level, blocks, from) => {
        for (let i = 0; i < blocks; i += 1) {
            globalThis.currentFrame = from + (i * 128);
            gate.process([[block(level)]], [[block()]], on);
        }
    };

    const inBand = new Gate();
    run(inBand, 0.3, 8, 0);                 // speak: opens
    run(inBand, 0.09, 400, 100_000);        // trail off into the band, long past the hold
    assert.equal(inBand.gain, 1, 'still open at 0.09, above the 0.085 close bar');

    const below = new Gate();
    run(below, 0.3, 8, 0);
    run(below, 0.05, 400, 100_000);         // properly quiet now
    assert.equal(below.gain, 0, 'and closed once the level drops through the band');
});

test('the gate never writes past the channels the output has', async () => {
    const Gate = await loadGate();
    const gate = new Gate();
    const inputs = [[block(0.5), block(0.5), block(0.5)]];
    const outputs = [[block()]];

    gate.process(inputs, outputs, params);
    assert.equal(outputs[0].length, 1, 'no channel is invented to match the input');
});
