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
    assert.ok(!html.includes('class="members"'),
        'the members panel was removed — the sidebar already says who stands where');
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


test('an empty room reads as available, not as broken', () => {
    const html = sidebar({ rooms: [{ id: 'r', name: 'The Dungeon', occupants: [] }] });
    assert.ok(html.includes('(empty)'));
    assert.ok(html.includes('>0<'), 'the count is still shown');
});

test('every occupied voice room lists its people, current or not', () => {
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

    // The regression this pins: opening a text channel moved `current` off the room
    // someone was standing in, and the people they were WITH vanished from the sidebar.
    // Where everyone stands must not depend on what anyone is reading.
    assert.ok(sidebar({ rooms: [{ id: 'r', name: 'Hall', occupants: [{ username: 'x' }] }] })
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
    const namedByContent = /class="[^"]*\b(room-row|member-row|room-person|server-pick-btn|self-id|reaction|self-menu-item|peer-menu-item)\b/;
    const suspicious = unnamed.filter((tag) => !namedByContent.test(tag));
    assert.deepEqual(suspicious, [], 'icon-only buttons must carry aria-label');
});

test('the DM picker list is inert against hostile names', async () => {
    const { dmSearchResults } = await import('../src/room/views/rail.js');
    const markup = dmSearchResults([{ id: 'u1', username: '<script>x</script>', displayName: '<b>bold</b>' }]);
    assert.ok(!markup.includes('<script>'));
    assert.ok(!markup.includes('<b>bold</b>'));
    assert.match(dmSearchResults([]), /Nobody by that name/);
});

test('a private room you are not in reads as a locked door, not a button', () => {
    const html = sidebar({
        rooms: [
            { id: 'p1', name: 'the-plot', private: true, member: false, occupants: [] },
            { id: 'p2', name: 'my-plot', private: true, member: true, occupants: [] },
        ],
    });
    assert.match(html, /locked[^>]*data-room="p1"/);
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /a member has to add you/);
    assert.ok(!/locked[^>]*data-room="p2"/.test(html), 'your own huddle is a normal row');
    // No "(empty)" tease on a room whose inside is not your business.
    assert.equal((html.match(/\(empty\)/g) ?? []).length, 1, 'only the member row hints');
});

test('a live stream mark on a person is a door with an aim', async () => {
    const { personMarks } = await import('../src/room/views/parts.js');
    const marked = personMarks({ username: 'kes', displayName: 'Kestrel', cid: 'C1D2', sharing: true, camera: true });
    assert.match(marked, /data-watch="C1D2:screen"/);
    assert.match(marked, /data-watch="C1D2:webcam"/);
    assert.match(marked, /Watch Kestrel/);

    // Without a cid there is nothing to aim at; the mark stays a mark.
    const plain = personMarks({ username: 'kes', sharing: true });
    assert.ok(!plain.includes('data-watch'));
});

// ── A mute somebody else applied ─────────────────────────────────────────────

test('an administrator mute is marked apart from a self-mute', async () => {
    const { personMarks } = await import('../src/room/views/parts.js');

    const own = personMarks({ username: 'kes', muted: true });
    assert.match(own, /mark-muted/);
    assert.match(own, /title="Muted"/);

    const forced = personMarks({ username: 'kes', muted: true, forceMuted: true });
    assert.match(forced, /mark-forced/);
    assert.match(forced, /Muted by an administrator/);
    // One mark, not two: they are the same microphone, and stacking them reads as a bug.
    assert.ok(!forced.includes('mark-muted'), 'the administrator mute replaces the self one');
});

test('a server-muted person cannot reach their own mute button', async () => {
    const { selfBar } = await import('../src/room/views/sidebar.js');

    const muted = selfBar({ username: 'kes', displayName: 'Kestrel', forceMuted: true });
    assert.match(muted, /data-toggle-mic disabled/);
    assert.match(muted, /An administrator muted you/);

    // And a timed one says when, as a clock time — "for 10 minutes" starts lying the
    // moment it is rendered and the bar sits there for a while.
    const timed = selfBar({
        username: 'kes', displayName: 'Kestrel',
        forceMuted: true, forceMutedUntil: Date.parse('2026-08-31T19:14:00Z'),
    });
    assert.match(timed, /until \d{1,2}:\d{2}/);

    const free = selfBar({ username: 'kes', displayName: 'Kestrel' });
    assert.ok(!free.includes('data-toggle-mic disabled'), 'nobody else is disabled by this');
});

test('the room says why a microphone stopped working, ahead of anything else', async () => {
    const { voiceNotice } = await import('../src/room/views/timeline.js');

    const forced = voiceNotice({ state: 'idle', forceMuted: true });
    assert.equal(forced.show, true);
    assert.equal(forced.tone, 'bad');
    assert.match(forced.text, /An administrator muted you/);

    // Ahead of anything else voice is saying: a person looking for a fault in their own
    // hardware is owed the actual reason first.
    const alsoRecovering = voiceNotice({ state: 'recovering', attempt: 2, of: 5, forceMuted: true });
    assert.match(alsoRecovering.text, /An administrator/);

    assert.equal(voiceNotice({ state: 'idle' }).show, false, 'and silent when it is not true');
});

// ── Status, and a face ───────────────────────────────────────────────────────

test('status lives behind your own name, not in the settings panel', async () => {
    const { selfBar, selfMenu, STATUS_CHOICES } = await import('../src/room/views/sidebar.js');

    const bar = selfBar({ username: 'kes', displayName: 'Kestrel', status: 'away' });
    // The identity button opens the menu now; Settings is an entry inside it.
    assert.match(bar, /data-self-menu/);
    assert.match(bar, /data-open-settings/);
    assert.match(bar, /aria-haspopup="menu"/);

    for (const c of STATUS_CHOICES) assert.ok(bar.includes(`data-set-status="${c.value}"`));

    // The one you are on is ticked, and says so to a screen reader rather than only in ink.
    const menu = selfMenu({ username: 'kes', displayName: 'Kestrel', status: 'away' });
    assert.match(menu, /data-set-status="away"[^>]*/);
    assert.ok(/aria-checked="true"[\s\S]*?data-set-status="away"/.test(menu)
        || /data-set-status="away"[\s\S]*?aria-checked="true"/.test(menu.replace(/\n/g, '')),
    'the current status is checked');

    const online = selfMenu({ username: 'kes', status: 'online' });
    assert.match(online, /class="self-menu-item current"[\s\S]*?data-set-status="online"/);
});

test('the profile panel offers a picture and no longer pretends to offer a status', async () => {
    const { profilePanel } = await import('../src/settings/panels.js');

    const withProfile = profilePanel({ me: { username: 'kes' }, features: ['profile'] });
    assert.match(withProfile, /data-pick-avatar/);
    assert.match(withProfile, /data-crop-frame/);
    assert.match(withProfile, /data-crop-save/);
    // Status moved out. A dead "Status — not built yet" row would now be a lie twice over.
    assert.ok(!/not-yet-what">Status/.test(withProfile));

    // Someone with a picture is offered Remove; someone without is not.
    assert.ok(!withProfile.includes('data-remove-avatar'));
    const hasOne = profilePanel({ me: { username: 'kes', avatar: 'x.png' }, features: ['profile'] });
    assert.match(hasOne, /data-remove-avatar/);
    assert.match(hasOne, />\s*Change\s*</);

    // Against a server without the routes, the control is not offered at all.
    const without = profilePanel({ me: { username: 'kes' }, features: [] });
    assert.ok(!without.includes('data-pick-avatar'));
    assert.match(without, /no route to attach one/);
});

test('a face is drawn over the initials, and escaped like everything else', async () => {
    const { avatar } = await import('../src/room/views/parts.js');

    const plain = avatar({ username: 'kestrel' });
    assert.ok(!plain.includes('<img'), 'no picture, no element — the initials stand alone');

    const withFace = avatar({ username: 'kestrel', avatarUrl: 'blob:abc' });
    assert.match(withFace, /<img class="avatar-face" src="blob:abc"/);
    assert.match(withFace, /KE/, 'the initials stay underneath, so nothing reflows');

    const hostile = avatar({ username: 'kestrel', avatarUrl: '" onerror="alert(1)' });
    assert.ok(!hostile.includes('onerror="alert'), 'a URL is still a hole to be escaped');
});
