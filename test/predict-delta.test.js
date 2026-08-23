// The delta predictor.
//
// This runs as a release gate, so it has to be right in both directions: it must not pass a
// release whose delta has blown up, and it must not fail one that is fine. Both halves are
// tested, because a gate that cries wolf gets bypassed and then it is not a gate at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planDownload } from '../scripts/predict-delta.mjs';

/** A blockmap file entry: parallel arrays of checksum and size, one pair per block. */
const file = (blocks) => ({
    checksums: blocks.map(([c]) => c),
    sizes: blocks.map(([, s]) => s),
});

test('an identical build downloads nothing', () => {
    const a = file([['a', 100], ['b', 200], ['c', 300]]);
    const plan = planDownload(a, a);
    assert.equal(plan.downloadBytes, 0);
    assert.equal(plan.changedBlocks, 0);
    assert.equal(plan.percent, 0);
    assert.equal(plan.reuseBytes, 600);
});

test('only the changed blocks are fetched', () => {
    const before = file([['a', 100], ['b', 200], ['c', 300]]);
    const after = file([['a', 100], ['X', 250], ['c', 300]]);
    const plan = planDownload(before, after);
    assert.equal(plan.downloadBytes, 250);
    assert.equal(plan.reuseBytes, 400);
    assert.equal(plan.changedBlocks, 1);
    assert.equal(plan.totalBytes, 650);
});

test('a repeated block can only be reused as many times as it existed', () => {
    // Runs of identical bytes are common in an installer. Treating the old blocks as a set
    // rather than a multiset over-counts reuse and predicts a smaller download than really
    // happens — which is the wrong direction for a gate to be wrong in.
    const before = file([['z', 10]]);
    const after = file([['z', 10], ['z', 10], ['z', 10]]);
    const plan = planDownload(before, after);
    assert.equal(plan.changedBlocks, 2, 'only one of the three can come from the old file');
    assert.equal(plan.downloadBytes, 20);
    assert.equal(plan.reuseBytes, 10);
});

test('adjacent changes coalesce into one range request', () => {
    // Request count is a better proxy for latency than block count: eight requests for a
    // megabyte is fine, and a thousand requests for the same megabyte is not.
    const before = file([['a', 10], ['b', 10], ['c', 10], ['d', 10], ['e', 10]]);

    const contiguous = planDownload(before, file([['a', 10], ['X', 10], ['Y', 10], ['d', 10], ['e', 10]]));
    assert.equal(contiguous.changedBlocks, 2);
    assert.equal(contiguous.rangeRequests, 1, 'two neighbouring blocks are one request');

    const scattered = planDownload(before, file([['X', 10], ['b', 10], ['Y', 10], ['d', 10], ['Z', 10]]));
    assert.equal(scattered.changedBlocks, 3);
    assert.equal(scattered.rangeRequests, 3, 'three separated blocks are three requests');
});

test('a completely recompressed payload reports as near-total', () => {
    // The failure this gate exists to catch: a different build machine or a bumped toolchain
    // recompresses everything, every block differs, and every user silently downloads the
    // whole installer again.
    const before = file([['a', 100], ['b', 100], ['c', 100]]);
    const after = file([['x', 100], ['y', 100], ['z', 100]]);
    const plan = planDownload(before, after);
    assert.equal(plan.percent, 100);
    assert.equal(plan.reuseBytes, 0);
});

test('an empty new build does not divide by zero', () => {
    const plan = planDownload(file([['a', 10]]), file([]));
    assert.equal(plan.percent, 0);
    assert.equal(plan.totalBytes, 0);
});

test('the real 0.1.0 to 0.1.1 shape: a small change is a small download', () => {
    // Proportions taken from the actual published blockmaps: 47 changed blocks of 5437.
    const unchanged = Array.from({ length: 5390 }, (_, i) => [`same-${i}`, 20_000]);
    const before = file([...unchanged, ...Array.from({ length: 47 }, (_, i) => [`old-${i}`, 20_000])]);
    const after = file([...unchanged, ...Array.from({ length: 47 }, (_, i) => [`new-${i}`, 20_000])]);

    const plan = planDownload(before, after);
    assert.equal(plan.changedBlocks, 47);
    assert.ok(plan.percent < 1, `expected under 1%, got ${plan.percent.toFixed(2)}%`);
});
