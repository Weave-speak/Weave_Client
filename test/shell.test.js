// The shell views.
//
// Every one is a pure function of state, which is the point: the whole layout can be
// asserted on here, without a browser, before a socket exists. What these tests care about
// is that nothing a server sends can become markup, that nobody silently disappears from a
// roster, and that the awkward inputs — nobody in the room, a hundred unread, an unknown
// message kind — produce something sensible rather than an exception.

import test from 'node:test';
import assert from 'node:assert/strict';

import { shell, connection } from '../src/room/shell.js';
import { rail } from '../src/room/views/rail.js';
import { sidebar } from '../src/room/views/sidebar.js';
import { timeline, messageText, fileSize, typingLine } from '../src/room/views/timeline.js';
import { members, groupMembers } from '../src/room/views/members.js';
import { initials } from '../src/room/views/parts.js';

const HOSTILE = '<img src=x onerror="steal()">';

/**
 * Nothing from the payload may become structure.
 *
 * The event-handler check looks for a REAL quote after the `=`. Correctly escaped output
 * legitimately contains the characters `onerror=&quot;` as inert text, so asserting on the
 * bare string would fail on output that is perfectly safe — and a test that cries wolf gets
 * deleted, which costs more than never having written it.
 */
const noInjection = (html, payload = HOSTILE) => {
    assert.ok(!html.includes(payload), 'the raw payload must not appear');
    assert.ok(!/\son\w+\s*=\s*["']/.test(html), 'no event handler may reach the markup');
    assert.ok(html.includes('&lt;img'), 'it should be escaped into text');
};

test('a shell renders from nothing at all', () => {
    // First paint happens before any data arrives. It must not throw and must not be blank.
    const html = shell();
    assert.ok(html.includes('app-shell'));
    assert.ok(html.includes('class="rail"'));
    assert.ok(html.includes('class="sidebar"'));
    assert.ok(html.includes('class="room"'));
    assert.ok(html.includes('class="members"'));
    assert.ok(html.includes('roomBg'), 'the background canvas belongs to the shell, not to data');
});

test('the connection readout says what it knows and nothing more', () => {
    assert.match(connection({ state: 'live', rttMs: 24, codec: 'Opus', bitrateKbps: 64 }),
        /Connected[\s\S]*24 ms[\s\S]*Opus 64 kb\/s/);
    // Not connected means no numbers: a stale round-trip time next to "Reconnecting" is a
    // lie that looks like precision.
    const lost = connection({ state: 'lost', rttMs: 24, codec: 'Opus' });
    assert.match(lost, /Reconnecting/);
    assert.ok(!lost.includes('24 ms'));
    assert.match(connection(), /Connecting/);
    assert.match(connection({ state: 'live', rttMs: 24.6 }), /25 ms/, 'round it, do not print 24.6');
});

test('a hostile display name cannot become markup anywhere it appears', () => {
    const person = { username: 'evil', displayName: HOSTILE, presence: 'online' };
    noInjection(rail({ dms: [{ id: 'd1', ...person, unread: 3 }] }));
    noInjection(sidebar({ server: { name: HOSTILE }, rooms: [], me: person }));
    noInjection(members({ people: [person] }));
    noInjection(timeline({
        room: { name: HOSTILE },
        items: [{ kind: 'message', id: 'm', at: '10:00', author: person, text: HOSTILE }],
    }));
});

test('a hostile room name cannot escape the composer placeholder attribute', () => {
    // An attribute hole is the easier one to get wrong, and this one is inside a quoted
    // placeholder where a bare quote would break straight out.
    const html = timeline({ room: { name: '" onfocus="steal()' } });
    assert.ok(!html.includes('onfocus="steal()'), 'the attribute must not break out');
    assert.ok(html.includes('&quot;'));
});

test('only mentions the server resolved are highlighted', () => {
    // Otherwise anyone could fake a mention of anyone by typing it, including of you.
    const marked = messageText('@ghostbyte can you check @nobody', ['ghostbyte']);
    assert.ok(marked.includes('<span class="mention">@ghostbyte</span>'));
    assert.ok(marked.includes('@nobody'));
    assert.ok(!marked.includes('<span class="mention">@nobody'));
});

test('the mention pass runs over already-escaped text', () => {
    // Escaping first is the entire safety argument: escaping cannot introduce an "@", so
    // the second pass can only ever match text that is already inert.
    const out = messageText('<script>x</script> @dan', ['dan']);
    assert.ok(!out.includes('<script'));
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(out.includes('<span class="mention">@dan</span>'));
});

test('nobody falls out of the member list', () => {
    const people = [
        { username: 'a', roomId: 'here', presence: 'live' },
        { username: 'b', roomId: 'other', presence: 'live' },
        { username: 'c', presence: 'online' },
        { username: 'd', presence: 'offline' },
        { username: 'e' },                                  // no presence at all
    ];
    const groups = groupMembers(people, { roomId: 'here' });
    const placed = groups.flatMap((g) => g.people.map((p) => p.username));

    assert.equal(placed.length, people.length, 'every person lands in exactly one group');
    assert.deepEqual([...placed].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(groups.map((g) => g.key), ['here', 'elsewhere', 'online', 'offline']);
    assert.deepEqual(groups.find((g) => g.key === 'here').people.map((p) => p.username), ['a']);
});

test('empty groups are dropped rather than shown with a zero', () => {
    const groups = groupMembers([{ username: 'a', presence: 'offline' }], { roomId: 'here' });
    assert.deepEqual(groups.map((g) => g.key), ['offline']);
    assert.ok(!members({ people: [] }).includes('member-group'));
});

test('an empty room reads as available, not as broken', () => {
    const html = sidebar({ rooms: [{ id: 'r', name: 'The Dungeon', occupants: [] }] });
    assert.ok(html.includes('(empty)'));
    assert.ok(html.includes('>0<'), 'the count is still shown');
});

test('the current room lists its occupants and marks you', () => {
    const html = sidebar({
        rooms: [{
            id: 'r', name: 'Hall', current: true,
            occupants: [{ username: 'kestrel', priority: true }, { username: 'me', muted: true }],
        }],
        me: { username: 'me' },
    });
    assert.ok(html.includes('room-people'));
    assert.ok(html.includes('(you)'));
    assert.ok(html.includes('Priority speaker'));
    assert.ok(html.includes('title="Muted"'));
    // A room that is not current does not expand, or the sidebar becomes the roster.
    assert.ok(!sidebar({ rooms: [{ id: 'r', name: 'Hall', occupants: [{ username: 'x' }] }] })
        .includes('room-people'));
});

test('an unread count is capped so the tile cannot change size', () => {
    assert.ok(rail({ dms: [{ id: 'd', username: 'a', unread: 7 }] }).includes('>7'));
    assert.ok(rail({ dms: [{ id: 'd', username: 'a', unread: 143 }] }).includes('99+'));
    assert.ok(!rail({ dms: [{ id: 'd', username: 'a', unread: 0 }] }).includes('rail-badge'));
    assert.ok(!rail({ dms: [{ id: 'd', username: 'a' }] }).includes('rail-badge'));
});

test('an unknown message kind renders as a message rather than vanishing', () => {
    // A newer server may send a kind this build has never heard of. Dropping it silently
    // would leave a hole in the conversation with no indication anything was there.
    const html = timeline({
        items: [{ kind: 'something-new', id: 'm', at: '10:00', author: { username: 'a' }, text: 'hello' }],
    });
    assert.ok(html.includes('hello'));
    assert.ok(html.includes('data-message="m"'));
});

test('reactions carry their own state and an accessible name', () => {
    const html = timeline({
        items: [{
            kind: 'message', id: 'm', at: '1', author: { username: 'a' }, text: 'x',
            reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '🎉', count: 1 }],
        }],
    });
    assert.ok(html.includes('reaction mine'));
    assert.ok(html.includes('aria-pressed="true"'));
    assert.ok(html.includes('aria-pressed="false"'));
    assert.ok(html.includes('including you'));
});

test('typing reads the way a person would say it', () => {
    assert.equal(typingLine([]), '');
    assert.match(typingLine(['Moth']), /Moth is typing/);
    assert.match(typingLine(['Moth', 'Roan']), /Moth and Roan are typing/);
    assert.match(typingLine(['A', 'B', 'C']), /A, B and C are typing/);
    assert.match(typingLine(['A', 'B', 'C', 'D']), /A, B and 2 others are typing/);
    noInjection(typingLine([HOSTILE]));
});

test('file sizes are the units a person would say out loud', () => {
    assert.equal(fileSize(0), '0 B');
    assert.equal(fileSize(512), '512 B');
    assert.equal(fileSize(1024), '1.0 KB');
    assert.equal(fileSize(1_258_291), '1.2 MB');
    assert.equal(fileSize(15 * 1024 * 1024), '15 MB');
    assert.equal(fileSize(2 * 1024 ** 3), '2.0 GB');
    assert.equal(fileSize(undefined), '0 B');
});

test('initials survive the names people actually have', () => {
    assert.equal(initials({ displayName: 'Ghostbyte' }), 'GH');
    assert.equal(initials({ displayName: 'Warp Weft Winder' }), 'WW');
    assert.equal(initials({ username: 'vaporwave_dan' }), 'VD');
    assert.equal(initials({ username: 'a' }), 'A');
    assert.equal(initials({}), '?');
});

test('a mention of you is marked structurally, not only by colour', () => {
    const html = timeline({
        items: [{ kind: 'message', id: 'm', at: '1', author: { username: 'a' }, text: 'hi', mentionsMe: true }],
    });
    assert.ok(html.includes('mentions-me'), 'the row carries a class an edge marker can hang off');
});

test('every interactive control has an accessible name', () => {
    // Icon-only buttons are the whole vocabulary of this shell. Without a label a screen
    // reader announces every one of them as "button".
    const html = shell({
        dms: [{ id: 'd', username: 'a', unread: 2 }],
        rooms: [{ id: 'r', name: 'Hall', current: true, occupants: [] }],
        room: { id: 'r', name: 'Hall' },
        me: { username: 'me' },
        people: [{ username: 'a', presence: 'online' }],
        items: [{ kind: 'message', id: 'm', at: '1', author: { username: 'a' }, text: 'x', reactions: [{ emoji: '👍', count: 1 }] }],
    });

    const unnamed = [...html.matchAll(/<button\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => !/aria-label=/.test(tag));

    // A button whose visible text IS its name needs no aria-label. Everything else does.
    const namedByContent = /class="[^"]*\b(room-row|member-row|room-person|server-pick-btn|self-id|reaction)\b/;
    const suspicious = unnamed.filter((tag) => !namedByContent.test(tag));
    assert.deepEqual(suspicious, [], 'icon-only buttons must carry aria-label');
});
