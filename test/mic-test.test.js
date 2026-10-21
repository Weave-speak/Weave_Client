// "Test my setup": the judgement, without a microphone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessMicTest, ignoredConstraints, looksLikeLoopback } from '../src/media/mic-test.js';

// Levels are linear peaks, 0–1. 0.3 is about -10 dBFS: a person talking normally.
const talking = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 0.3 : 0.05));
const silence = Array.from({ length: 40 }, () => 0.0001);
const room = Array.from({ length: 10 }, () => 0.004);

const codes = (result) => result.findings.map((f) => f.tone);

test('a normal voice through a working chain is healthy', () => {
    const result = assessMicTest({ label: 'Headset Microphone', raw: talking, sent: talking, baseline: room, duringTone: room });
    assert.equal(result.verdict, 'good');
    assert.deepEqual(codes(result), ['good']);
});

test('a microphone that heard nothing says so first', () => {
    const result = assessMicTest({ raw: silence, sent: silence });
    assert.equal(result.verdict, 'bad');
    assert.match(result.findings[0].text, /Nothing was heard/);
});

test('a chain that sends silence while the microphone hears speech is caught', () => {
    // The failure this test exists for: every indicator normal, and nobody hears you.
    const result = assessMicTest({ raw: talking, sent: silence, processed: true, gateEnabled: false });
    assert.equal(result.verdict, 'bad');
    assert.match(result.findings[0].text, /processing sent silence/);
});

test('a gate that never opened is blamed on the gate, with the fix', () => {
    const result = assessMicTest({ raw: talking, sent: silence, processed: true, gateEnabled: true });
    assert.equal(result.verdict, 'warn');
    assert.match(result.findings[0].text, /noise gate never opened/);
});

test('without a chain, the raw device is what is sent, so silence there is not a chain fault', () => {
    const result = assessMicTest({ raw: talking, sent: silence, processed: false });
    assert.ok(!result.findings.some((f) => /processing/.test(f.text)));
});

test('a quiet speaker is told to turn up, a loud one to turn down', () => {
    const quiet = assessMicTest({ raw: talking.map((v) => v / 30), sent: talking.map((v) => v / 30) });
    assert.match(quiet.findings.map((f) => f.text).join(' '), /You are quiet/);

    const clipped = [...talking, 0.99, 1, 1, 0.99];
    const loud = assessMicTest({ raw: clipped, sent: clipped });
    assert.match(loud.findings.map((f) => f.text).join(' '), /clipping/);
});

test('a microphone that hears the speakers is flagged', () => {
    const result = assessMicTest({
        raw: talking, sent: talking,
        baseline: room,
        duringTone: room.map(() => 0.1),   // ~28 dB louder than the room while the tone played
    });
    assert.equal(result.verdict, 'warn');
    assert.match(result.findings.map((f) => f.text).join(' '), /hears your speakers/);
});

test('a loopback device is named as one', () => {
    assert.ok(looksLikeLoopback('Stereo Mix (Realtek(R) Audio)'));
    assert.ok(looksLikeLoopback('CABLE Output (VB-Audio Virtual Cable)'));
    assert.ok(!looksLikeLoopback('Microphone (Blue Yeti)'));
    const result = assessMicTest({ label: 'Stereo Mix (Realtek(R) Audio)', raw: talking, sent: talking });
    assert.equal(result.verdict, 'bad');
    assert.match(result.findings[0].text, /Stereo Mix/);
});

test('processing a device declined is reported, but is not a fault', () => {
    assert.deepEqual(
        ignoredConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: false },
            { echoCancellation: false, noiseSuppression: true, autoGainControl: false }),
        ['echo cancellation'],
        'only what was ASKED for and refused');
    const result = assessMicTest({ raw: talking, sent: talking, ignored: ['echo cancellation'] });
    assert.equal(result.verdict, 'good');
    assert.ok(result.findings.some((f) => /ignored: echo cancellation/.test(f.text)));
});
