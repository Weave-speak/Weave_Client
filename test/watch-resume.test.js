// Which watches survive a reconnection.
//
// The bug this exists for: a viewer watching somebody's screen loses it when THEIR OWN
// line blips, because every choice was remembered as a connection id and a reconnection
// renames everybody. The tile falls back to a placeholder and the viewer is left to work
// out that they have to click Watch again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { watchesToRestore } from '../src/media/watch-resume.js';

const peer = (cid, userId, slots = [], channelId = 'hall') => ({
    cid, userId, channelId, producers: slots.map((slot) => ({ slot, id: `p-${cid}-${slot}` })),
});

test('a watch follows the person through their new connection id', () => {
    const restore = watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [peer('NEW-CID', 'u-chris', ['audio', 'screen', 'screen-audio'])],
        channelId: 'hall',
    });
    assert.deepEqual(restore, [{ cid: 'NEW-CID', slot: 'screen', userId: 'u-chris' }]);
});

test('a share that ended in the meantime is not re-armed', () => {
    // Watching a producer nobody is sending is a consume the server rightly refuses.
    const restore = watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [peer('NEW-CID', 'u-chris', ['audio'])],
        channelId: 'hall',
    });
    assert.deepEqual(restore, []);
});

test("system audio rides its screen rather than being restored in its own right", () => {
    // Consuming screen-audio is setWatching('screen')'s job. An entry of its own here
    // would ask for the same stream twice.
    const restore = watchesToRestore({
        watched: ['u-chris:screen', 'u-chris:screen-audio'],
        peers: [peer('NEW-CID', 'u-chris', ['screen', 'screen-audio'])],
        channelId: 'hall',
    });
    assert.deepEqual(restore.map((r) => r.slot), ['screen']);
});

test('only inside the room we are actually standing in', () => {
    const restore = watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [peer('NEW-CID', 'u-chris', ['screen'], 'the-library')],
        channelId: 'hall',
    });
    assert.deepEqual(restore, []);
});

test('a person nobody chose to watch stays a placeholder', () => {
    const restore = watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [peer('C1', 'u-chris', ['screen']), peer('C2', 'u-sinister', ['screen', 'webcam'])],
        channelId: 'hall',
    });
    assert.deepEqual(restore.map((r) => r.userId), ['u-chris']);
});

test('the same account on two connections restores both, because both are real', () => {
    const restore = watchesToRestore({
        watched: ['u-chris:webcam'],
        peers: [peer('C1', 'u-chris', ['webcam']), peer('C2', 'u-chris', ['webcam'])],
        channelId: 'hall',
    });
    assert.deepEqual(restore.map((r) => r.cid), ['C1', 'C2']);
});

test('nothing remembered, nothing done — and a ragged roster cannot throw', () => {
    assert.deepEqual(watchesToRestore(), []);
    assert.deepEqual(watchesToRestore({ watched: [], peers: [peer('C1', 'u', ['screen'])] }), []);
    assert.deepEqual(watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [null, {}, { cid: 'C1' }, { userId: 'u-chris' }, peer('C2', 'u-chris')],
        channelId: null,
    }), []);
});

test('a null channel means anywhere, which is what a roomless roster needs', () => {
    const restore = watchesToRestore({
        watched: ['u-chris:screen'],
        peers: [peer('C1', 'u-chris', ['screen'], null)],
        channelId: null,
    });
    assert.deepEqual(restore.map((r) => r.cid), ['C1']);
});
