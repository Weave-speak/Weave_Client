// The peer menu: the pure half.
//
// What is worth asserting here is the GATING, not the pixels. Every item in this menu does
// something to somebody, and two of them are irreversible from the other person's side, so
// "is this button present" is a security-shaped question and not a cosmetic one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { peerMenu, peerMenuHasContent, MUTE_DURATIONS } from '../src/room/views/peer-menu.js';

const kestrel = { username: 'kestrel', displayName: 'Kestrel', forceMuted: false };

test('anyone gets the listen controls, and nobody else gets the admin ones', () => {
    const plain = peerMenu({ person: kestrel });

    assert.match(plain, /data-peer-mute/);
    assert.match(plain, /data-peer-volume/);
    assert.ok(!plain.includes('data-server-mute'), 'a non-admin is offered no server mute');
    assert.ok(!plain.includes('data-kick'), 'and no kick');
    assert.ok(!plain.includes('peer-menu-admin-label'));
});

test('an administrator gets both halves, separated', () => {
    const menu = peerMenu({ person: kestrel, canModerate: true });

    assert.match(menu, /data-peer-mute/);
    assert.match(menu, /peer-menu-split/);
    assert.match(menu, /data-server-mute="on"/);
    assert.match(menu, /data-kick="arm"/);

    // The destructive verbs sit BELOW the harmless ones, so "right-click, first item"
    // can never land on a kick.
    assert.ok(menu.indexOf('data-peer-mute') < menu.indexOf('data-kick'));
});

test('your own row offers nothing — the self bar already has all of it', () => {
    assert.equal(peerMenuHasContent({ isSelf: true }), false);
    assert.equal(peerMenuHasContent({ isSelf: false }), true);

    const mine = peerMenu({ person: kestrel, isSelf: true, canModerate: true });
    assert.ok(!mine.includes('data-peer-mute'), 'you cannot mute yourself for yourself');
    assert.ok(!mine.includes('data-kick'), 'nor kick yourself');
});

test('the listen controls reflect what you currently hear', () => {
    const quiet = peerMenu({ person: kestrel, listen: { muted: true, volume: 0.35 } });
    assert.match(quiet, /aria-pressed="true"/);
    assert.match(quiet, /Unmute for you/);
    assert.match(quiet, /value="35"/);

    const loud = peerMenu({ person: kestrel, listen: { muted: false, volume: 1 } });
    assert.match(loud, /aria-pressed="false"/);
    assert.match(loud, /Mute for you/);
    assert.match(loud, /value="100"/);
});

test('an already server-muted person is offered the lift, not another mute', () => {
    const menu = peerMenu({ person: { ...kestrel, forceMuted: true }, canModerate: true });
    assert.match(menu, /data-server-mute="off"/);
    assert.match(menu, /Remove server mute/);
    assert.ok(!menu.includes('Server mute…'));
});

test('the duration page offers every duration, including the open-ended one', () => {
    const page = peerMenu({ person: kestrel, canModerate: true, page: 'duration' });

    for (const d of MUTE_DURATIONS) assert.ok(page.includes(d.label), `${d.label} is offered`);
    // The open-ended one carries an empty value, which is what "no expiry" is on the wire.
    assert.match(page, /data-mute-minutes=""/);
    assert.match(page, /data-mute-minutes="5"/);
    assert.match(page, /data-menu-back/);

    // Nothing destructive shares the page, so a mis-aimed click cannot kick.
    assert.ok(!page.includes('data-kick'));
});

test('the kick arms before it fires', () => {
    const cold = peerMenu({ person: kestrel, canModerate: true });
    assert.match(cold, /data-kick="arm"/);
    assert.ok(!cold.includes('press again'));

    const armed = peerMenu({ person: kestrel, canModerate: true, armed: true });
    assert.match(armed, /data-kick="confirm"/);
    assert.match(armed, /Kick — press again/);
});

test('a name is escaped, because it came from a server', () => {
    const nasty = { username: 'x', displayName: '<img src=x onerror=alert(1)>', forceMuted: false };
    const menu = peerMenu({ person: nasty, canModerate: true });

    assert.ok(!menu.includes('<img'), 'no markup from a display name');
    assert.match(menu, /&lt;img/);
    // And it is escaped ONCE — a doubly-escaped name reads as literal &amp;lt; on screen.
    assert.ok(!menu.includes('&amp;lt;'));
});
