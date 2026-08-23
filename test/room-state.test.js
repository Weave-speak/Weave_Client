// The room's state.
//
// The distinction this file defends is between USERS (accounts, from HTTP) and PEERS (live
// connections, from the socket). Collapsing them into "users with an online flag" works
// until somebody signs in twice, and then produces ghosts that never leave — which is the
// bug the previous client had.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoomState } from '../src/room/state.js';

const ME = { id: 'u-me', username: 'ghostbyte', displayName: 'Ghostbyte' };

const users = [
    ME,
    { id: 'u-kes', username: 'kestrel', displayName: 'Kestrel', isAdmin: true },
    { id: 'u-moth', username: 'moth', displayName: 'Moth' },
];

const channels = [
    { id: 'c-hall', name: 'The Great Hall', kind: 'both' },
    { id: 'c-lib', name: 'The Library', kind: 'both' },
    { id: 'c-afk', name: 'Away', kind: 'afk' },
    { id: 'c-notes', name: 'patch-notes', kind: 'text' },
];

const peer = (cid, userId, username, extra = {}) => ({
    cid, userId, username, displayName: username, channelId: 'c-hall',
    muted: false, deafened: false, producers: [], ...extra,
});

function fresh() {
    const state = createRoomState({ me: ME, server: { name: 'Weave Dev' } });
    state.setChannels(channels);
    state.setUsers(users);
    return state;
}

test('a joined snapshot establishes the room and its occupants', () => {
    const state = fresh();
    state.apply({
        type: 'joined',
        channel: channels[0],
        self: peer('cid-me', 'u-me', 'ghostbyte'),
        peers: [peer('cid-kes', 'u-kes', 'kestrel')],
    });

    const view = state.toShell();
    assert.equal(view.room.name, 'The Great Hall');
    assert.equal(view.rooms.find((r) => r.current).id, 'c-hall');
    assert.deepEqual(
        view.rooms.find((r) => r.id === 'c-hall').occupants.map((p) => p.username).sort(),
        ['ghostbyte', 'kestrel'],
    );
});

test('a later snapshot replaces the roster rather than merging into it', () => {
    // Merging is how a peer that left while we were disconnected lingers for ever: nothing
    // ever tells us about a departure we were not there to hear.
    const state = fresh();
    state.apply({
        type: 'joined',
        channel: channels[0],
        self: peer('cid-me', 'u-me', 'ghostbyte'),
        peers: [peer('cid-kes', 'u-kes', 'kestrel'), peer('cid-moth', 'u-moth', 'moth')],
    });
    assert.equal(state.toShell().rooms.find((r) => r.id === 'c-hall').occupants.length, 3);

    // Reconnect: moth is gone, and nobody told us.
    state.apply({
        type: 'joined',
        channel: channels[0],
        self: peer('cid-me2', 'u-me', 'ghostbyte'),
        peers: [peer('cid-kes', 'u-kes', 'kestrel')],
    });

    const here = state.toShell().rooms.find((r) => r.id === 'c-hall').occupants.map((p) => p.username);
    assert.deepEqual(here.sort(), ['ghostbyte', 'kestrel'], 'moth must not linger');
});

test('presence is derived from peers, not stored on the user', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });

    const before = state.toShell().people;
    assert.equal(before.find((p) => p.username === 'kestrel').presence, 'offline');

    state.apply({ type: 'peer_joined', peer: peer('cid-kes', 'u-kes', 'kestrel') });
    const after = state.toShell().people;
    assert.equal(after.find((p) => p.username === 'kestrel').presence, 'live');
    assert.equal(after.find((p) => p.username === 'kestrel').roomId, 'c-hall');

    state.apply({ type: 'peer_left', cid: 'cid-kes' });
    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').presence, 'offline');
});

test('one person on two machines is one entry in the member list', () => {
    // Two peers, one user. Rendering two rows for one person is what "users with a flag"
    // produces, and it looks like a bug to everyone who sees it.
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({ type: 'peer_joined', peer: peer('cid-kes-1', 'u-kes', 'kestrel') });
    state.apply({ type: 'peer_joined', peer: peer('cid-kes-2', 'u-kes', 'kestrel', { channelId: 'c-lib' }) });

    const kestrels = state.toShell().people.filter((p) => p.username === 'kestrel');
    assert.equal(kestrels.length, 1);
    assert.equal(kestrels[0].presence, 'live');

    // And closing one connection does not make them vanish while the other is still open.
    state.apply({ type: 'peer_left', cid: 'cid-kes-2' });
    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').presence, 'live');
});

test('the AFK room reads as away rather than as live', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({ type: 'peer_joined', peer: peer('cid-moth', 'u-moth', 'moth', { channelId: 'c-afk' }) });

    const moth = state.toShell().people.find((p) => p.username === 'moth');
    assert.equal(moth.presence, 'away');
    assert.equal(moth.away, true);
});

test('moving rooms takes the occupancy with it', () => {
    // The `moved` frame carries the NEW room's roster with us excluded from it, and no
    // `self` at all — the shape the real server sends. An earlier version of this test
    // helpfully supplied `self`, which is why it passed while the counts were wrong in the
    // running app: the old room kept our tally and the new one never gained it.
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    assert.equal(state.toShell().rooms.find((r) => r.id === 'c-hall').occupants.length, 1);

    state.apply({ type: 'moved', channel: channels[1], reason: 'self', peers: [] });

    const view = state.toShell();
    assert.equal(view.room.id, 'c-lib');
    assert.equal(view.rooms.find((r) => r.id === 'c-lib').occupants.length, 1, 'we are in the new room');
    assert.equal(view.rooms.find((r) => r.id === 'c-hall').occupants.length, 0, 'and out of the old one');
    assert.equal(view.me.roomName, 'The Library');
});

test('being moved into a room that already has people keeps all of them', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({
        type: 'moved', channel: channels[1], reason: 'admin', by: 'Kestrel',
        peers: [peer('cid-kes', 'u-kes', 'kestrel', { channelId: 'c-lib' })],
    });

    const here = state.toShell().rooms.find((r) => r.id === 'c-lib').occupants.map((p) => p.username);
    assert.deepEqual(here.sort(), ['ghostbyte', 'kestrel']);
});

test('the AFK room does not read as "Away . Away"', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({ type: 'moved', channel: channels[2], peers: [] });

    const me = state.toShell().me;
    assert.equal(me.roomName, 'Away');
    assert.equal(me.status, null, 'the room name already says it');
});

test('producers become the marks the member list shows', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({ type: 'peer_joined', peer: peer('cid-kes', 'u-kes', 'kestrel') });

    state.apply({ type: 'producer_new', cid: 'cid-kes', slot: 'screen', kind: 'video', id: 'p1' });
    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').sharing, true);

    // A paused producer is not a live one — the tile is black, so the marker should be gone.
    state.apply({ type: 'producer_paused', cid: 'cid-kes', slot: 'screen', paused: true });
    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').sharing, false);

    state.apply({ type: 'producer_paused', cid: 'cid-kes', slot: 'screen', paused: false });
    state.apply({ type: 'producer_closed', cid: 'cid-kes', slot: 'screen' });
    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').sharing, false);
});

test('mute state is per peer and reaches the member list', () => {
    const state = fresh();
    state.apply({ type: 'joined', channel: channels[0], self: peer('cid-me', 'u-me', 'ghostbyte'), peers: [] });
    state.apply({ type: 'peer_joined', peer: peer('cid-kes', 'u-kes', 'kestrel') });
    state.apply({ type: 'peer_mute_changed', cid: 'cid-kes', muted: true, deafened: false });

    assert.equal(state.toShell().people.find((p) => p.username === 'kestrel').muted, true);
});

test('channel kinds map onto the two sidebar groups', () => {
    const state = fresh();
    const rooms = state.toShell().rooms;
    assert.equal(rooms.find((r) => r.id === 'c-notes').kind, 'text');
    // both, voice and afk are all places you go, not places you read.
    for (const id of ['c-hall', 'c-lib', 'c-afk']) {
        assert.equal(rooms.find((r) => r.id === id).kind, 'voice', id);
    }
});

test('an unknown frame is ignored rather than thrown on', () => {
    // A newer server may send events this build has never heard of. Refusing to run because
    // of one is worse than quietly not showing it.
    const state = fresh();
    assert.equal(state.apply({ type: 'something_from_the_future', payload: 1 }), false);
    assert.doesNotThrow(() => state.apply({ type: 'peer_left' }));
});

test('messages are de-duplicated by id', () => {
    // The server broadcasts to everyone in the channel including the sender, so our own
    // message can arrive alongside anything we already recorded.
    const state = fresh();
    const record = { id: 'm1', channelId: 'c-hall', userId: 'u-me', body: 'hello', createdAt: 1 };
    assert.equal(state.addMessage('c-hall', record), true);
    assert.equal(state.addMessage('c-hall', record), false);
    assert.equal(state.raw.messages.get('c-hall').length, 1);
});

test('subscribers are told when something changes', () => {
    const state = fresh();
    let calls = 0;
    const stop = state.subscribe(() => { calls += 1; });

    state.apply({ type: 'peer_joined', peer: peer('cid-kes', 'u-kes', 'kestrel') });
    assert.equal(calls, 1);

    stop();
    state.apply({ type: 'peer_left', cid: 'cid-kes' });
    assert.equal(calls, 1, 'unsubscribing must actually stop them');
});
