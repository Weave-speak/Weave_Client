// When the stage is allowed to redraw.
//
// The bug these guard against: watching a shared screen in fullscreen ejected the viewer
// after a few seconds, seemingly at random. Painting the stage writes innerHTML, which
// detaches every tile, and detaching the element that is in fullscreen is how a browser is
// told to leave fullscreen. The heartbeat's producer truth arrives every 25 seconds and
// repainted unconditionally, so the eject was guaranteed — the randomness was only WHERE
// in the heartbeat cycle the viewer happened to go fullscreen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stageSignature, stagePaintDecision } from '../src/room/stage-paint.js';

const tile = (over = {}) => ({
    key: 'peer-a:screen',
    label: 'Chris',
    chipName: 'chris',
    slot: 'screen',
    self: false,
    live: true,
    frame: null,
    audio: null,
    ...over,
});

const decide = (over = {}) => {
    const tiles = over.tiles ?? [tile()];
    return stagePaintDecision({
        signature: stageSignature({ tiles, focus: over.focus ?? null, heightPx: null }),
        lastSignature: over.lastSignature ?? null,
        hasChildren: over.hasChildren ?? true,
        fullscreenKey: over.fullscreenKey ?? null,
        hold: over.hold ?? false,
        tiles,
    });
};

test('an unchanged stage is not redrawn', () => {
    const tiles = [tile()];
    const signature = stageSignature({ tiles, focus: null, heightPx: null });
    // This is the heartbeat case: the pong re-delivers the same producer list every 25s.
    assert.equal(
        stagePaintDecision({ signature, lastSignature: signature, hasChildren: true, tiles }),
        'skip',
    );
});

test('an unchanged stage IS drawn when the slot is empty', () => {
    // A matching signature must never win over an empty stage, or a remount renders nothing.
    const tiles = [tile()];
    const signature = stageSignature({ tiles, focus: null, heightPx: null });
    assert.equal(
        stagePaintDecision({ signature, lastSignature: signature, hasChildren: false, tiles }),
        'paint',
    );
});

test('a real change is drawn', () => {
    const before = stageSignature({ tiles: [tile()], focus: null, heightPx: null });
    assert.equal(decide({ lastSignature: before, tiles: [tile(), tile({ key: 'peer-b:webcam', slot: 'webcam' })] }), 'paint');
});

test('a change is DEFERRED while its tile is fullscreen', () => {
    // The heart of the bug: something changed, but drawing it would eject the viewer.
    assert.equal(
        decide({
            fullscreenKey: 'peer-a:screen',
            tiles: [tile(), tile({ key: 'peer-b:webcam', slot: 'webcam' })],
        }),
        'defer',
    );
});

test('a change is drawn when fullscreen is on a tile that has ended', () => {
    // Leaving fullscreen is the honest outcome here — the stream it showed is gone, and
    // holding the paint would leave the viewer staring at a frozen frame.
    assert.equal(decide({ fullscreenKey: 'peer-a:screen', tiles: [tile({ live: false })] }), 'paint');
});

test('a change is drawn when fullscreen is on a tile that no longer exists', () => {
    assert.equal(decide({ fullscreenKey: 'ghost:screen' }), 'paint');
});

test('nothing is deferred when the viewer is not in fullscreen', () => {
    assert.equal(decide({ fullscreenKey: null, tiles: [tile(), tile({ key: 'peer-b:webcam' })] }), 'paint');
});

test('an unchanged stage skips even while fullscreen', () => {
    // Skip is checked first: there is nothing to owe the viewer when nothing moved.
    const tiles = [tile()];
    const signature = stageSignature({ tiles, focus: null, heightPx: null });
    assert.equal(
        stagePaintDecision({
            signature, lastSignature: signature, hasChildren: true,
            fullscreenKey: 'peer-a:screen', tiles,
        }),
        'skip',
    );
});

// ---- a blip is not the end of a stream ------------------------------------------------

test('a fullscreen tile whose stream blinks out is HELD, not ejected', () => {
    // The second bug, and the harder one. A consumer dropped for a moment — a reconcile
    // against a roster in flux, an ICE rebuild — looks exactly like a share that ended, and
    // ejecting somebody for it is experienced as the picture throwing them out at random.
    assert.equal(
        decide({ fullscreenKey: 'peer-a:screen', hold: true, tiles: [tile({ live: false })] }),
        'defer',
    );
    // Same for the tile vanishing from the roster entirely for a beat.
    assert.equal(decide({ fullscreenKey: 'peer-a:screen', hold: true, tiles: [] }), 'defer');
});

test('holding ends, and then the honest paint lands', () => {
    // The hold is a short grace, not a veto: a share that really ended must still drop the
    // viewer out, or they are left staring at a frozen frame forever.
    assert.equal(
        decide({ fullscreenKey: 'peer-a:screen', hold: false, tiles: [tile({ live: false })] }),
        'paint',
    );
});

test('holding changes nothing when there is nothing to protect', () => {
    // A hold must not become a way to stop the stage repainting in general.
    assert.equal(decide({ fullscreenKey: null, hold: true, tiles: [tile({ live: false })] }), 'paint',
        'nobody is in fullscreen');
    assert.equal(decide({ fullscreenKey: 'peer-a:screen', hold: true, tiles: [tile()] }), 'defer',
        'still live: deferred for the ordinary reason, with or without a hold');

    const tiles = [tile({ live: false })];
    const signature = stageSignature({ tiles, focus: null, heightPx: null });
    assert.equal(
        stagePaintDecision({
            signature, lastSignature: signature, hasChildren: true,
            fullscreenKey: 'peer-a:screen', hold: true, tiles,
        }),
        'skip',
        'nothing moved, so nothing is owed',
    );
});

// ---- what the signature must and must not notice -------------------------------------

test('the signature moves when a stream goes live', () => {
    assert.notEqual(
        stageSignature({ tiles: [tile({ live: false })] }),
        stageSignature({ tiles: [tile({ live: true })] }),
    );
});

test('the signature moves when audio is muted', () => {
    const base = { slot: 'screen-audio', muted: false, volume: 1 };
    assert.notEqual(
        stageSignature({ tiles: [tile({ audio: base })] }),
        stageSignature({ tiles: [tile({ audio: { ...base, muted: true } })] }),
    );
});

test('the signature moves when focus changes', () => {
    assert.notEqual(
        stageSignature({ tiles: [tile()], focus: null }),
        stageSignature({ tiles: [tile()], focus: 'peer-a:screen' }),
    );
});

test('the signature moves when someone is renamed', () => {
    assert.notEqual(
        stageSignature({ tiles: [tile()] }),
        stageSignature({ tiles: [tile({ label: 'Christopher' })] }),
    );
});

test('the signature ignores the MediaStream object identity', () => {
    // Streams are attached after paint, so a new object for the same tile is not a redraw.
    assert.equal(
        stageSignature({ tiles: [tile({ stream: { id: 'one' } })] }),
        stageSignature({ tiles: [tile({ stream: { id: 'two' } })] }),
    );
});

test('the signature does not carry the frame data URL itself', () => {
    // Frames are tens of kilobytes; only their length participates.
    const big = `data:image/jpeg;base64,${'A'.repeat(4096)}`;
    const signature = stageSignature({ tiles: [tile({ live: false, frame: big })] });
    assert.ok(!signature.includes('AAAA'), 'the data URL must not be embedded in the signature');
    assert.ok(signature.includes(String(big.length)), 'its length is what participates');
});
