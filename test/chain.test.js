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
