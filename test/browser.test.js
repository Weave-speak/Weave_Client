// The room browser.
//
// The sidebar answers "what rooms exist". This answers "where is everyone", which is a
// different question and the one you actually ask before deciding where to go. So the tests
// care most about whether a card tells the truth about the room behind it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    roomState, actionFor, applyFilter, headline, hueFor, browserView, createRoomForm, FILTERS,
} from '../src/rooms/browser.js';

const person = (username) => ({ id: `u-${username}`, username, displayName: username });

const room = (name, extra = {}) => ({
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    kind: 'voice',
    occupants: [],
    ...extra,
});

test('an empty room, a live room and the away room read differently', () => {
    // The away room is the reason this is not simply "occupied or not": people parked there
    // are present but not available, and calling that "live" sends you somewhere nobody is
    // actually talking.
    assert.equal(roomState(room('Lobby')).key, 'empty');
    assert.equal(roomState(room('Hall', { occupants: [person('a'), person('b')] })).label, '2 live');
    assert.equal(roomState(room('Away', { kind: 'afk', occupants: [person('a')] })).label, '1 idle');
});

test('the button says what pressing it will do', () => {
    assert.equal(actionFor(room('Lobby')).label, 'Start it', 'an empty room is one you start');
    assert.equal(actionFor(room('Hall', { occupants: [person('a')] })).label, 'Join');
    assert.equal(actionFor(room('notes', { kind: 'text' })).label, 'Open');

    const here = actionFor(room('Hall', { current: true, occupants: [person('a')] }));
    assert.equal(here.label, 'You are here');
    assert.equal(here.disabled, true, 'and it cannot be pressed');
});

test('the live filter shows only rooms with people in them', () => {
    const rooms = [
        room('Lobby'),
        room('Hall', { occupants: [person('a')] }),
        room('Away', { kind: 'afk', occupants: [person('b')] }),
    ];
    assert.equal(applyFilter(rooms, 'all').length, 3);
    assert.deepEqual(applyFilter(rooms, 'live').map((r) => r.name), ['Hall', 'Away']);
    assert.equal(applyFilter(rooms, 'nonsense').length, 3, 'an unknown filter shows everything');
});

test('the headline counts people, not occupancies', () => {
    // Somebody in two rooms at once — two connections — is one person. Counting rows would
    // report more people online than exist, which is the kind of number nobody trusts twice.
    const rooms = [
        room('Hall', { occupants: [person('a'), person('b')] }),
        room('Library', { occupants: [person('a')] }),
    ];
    assert.match(headline(rooms), /^2 people are in 2 rooms\.$/);
});

test('the headline reads correctly for one person in one room', () => {
    assert.match(headline([room('Hall', { occupants: [person('a')] })]), /^1 person is in 1 room\.$/);
});

test('an empty server says so and suggests the next move', () => {
    assert.match(headline([room('Lobby'), room('Away')]), /Nobody is in a room/);
});

test('a room colour is stable and differs between rooms', () => {
    assert.equal(hueFor('The Great Hall'), hueFor('The Great Hall'));
    assert.notEqual(hueFor('The Great Hall'), hueFor('The Library'));
    for (const name of ['', 'x', 'The Great Hall']) {
        const hue = hueFor(name);
        assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
    }
});

test('the view renders a card per room with its people', () => {
    const markup = browserView({
        rooms: [
            room('The Great Hall', { occupants: [person('kestrel'), person('moth')] }),
            room('Lobby'),
        ],
    });
    assert.match(markup, /The Great Hall/);
    assert.match(markup, /2 live/);
    assert.match(markup, /kestrel, moth/);
    assert.match(markup, /No one here yet/);
    assert.equal([...markup.matchAll(/data-room-card=/g)].length, 2);
});

test('more people than fit become a count rather than overflowing', () => {
    const many = Array.from({ length: 9 }, (_, i) => person(`p${i}`));
    const markup = browserView({ rooms: [room('Hall', { occupants: many })] });
    assert.match(markup, /\+4/, 'five faces and a remainder');
    assert.match(markup, /and 6 more/, 'and the names summarise too');
});

test('the filter chips report their own state', () => {
    const markup = browserView({ rooms: [room('Hall')], filter: 'live' });
    assert.match(markup, /data-filter="live"[^>]*aria-pressed="true"/);
    assert.match(markup, /data-filter="all"[^>]*aria-pressed="false"/);
    assert.equal(FILTERS.length, 2);
});

test('an empty result explains itself differently per filter', () => {
    // "No rooms exist" and "nobody is in one" are different situations and only one of them
    // is worth doing something about.
    assert.match(browserView({ rooms: [], filter: 'all' }), /no rooms yet/);
    assert.match(browserView({ rooms: [room('Lobby')], filter: 'live' }), /No one is in a room/);
});

test('creating a room is offered only to someone who can', () => {
    // POST /api/channels is admin-only, so offering the button to everyone would produce a
    // 403 and no explanation.
    assert.match(browserView({ rooms: [], canCreate: true }), /data-new-room-here/);

    const crew = browserView({ rooms: [], canCreate: false });
    assert.ok(!crew.includes('data-new-room-here'));
    assert.match(crew, /Only an administrator can create rooms/);
});

test('a hostile room name cannot become markup', () => {
    const markup = browserView({
        rooms: [room('<img src=x onerror="steal()">', { occupants: [person('<script>x</script>')] })],
    });
    assert.ok(!markup.includes('<img src=x'));
    assert.ok(!markup.includes('<script>'));
    assert.ok(!/\son\w+\s*=\s*["']/.test(markup));
    assert.match(markup, /&lt;img/);
});

test('the create form offers an admin both public kinds, starting on voice', () => {
    const markup = createRoomForm({ isAdmin: true });
    assert.match(markup, /value="both"[^>]*checked/);
    assert.match(markup, /value="text"/);
    assert.match(markup, /Create it/);
});

test('a server refusal is shown in the form, escaped', () => {
    const markup = createRoomForm({ error: '<img src=x onerror=steal()>' });
    assert.ok(!markup.includes('<img src=x'));
    assert.match(markup, /&lt;img/);
});

test('a busy form cannot be double-submitted', () => {
    assert.match(createRoomForm({ busy: true }), /Creating…/);
    assert.match(createRoomForm({ busy: true }), /<button type="submit"[^>]*disabled/);
});

test('the private card appears with the feature, and is the only card for non-admins', () => {
    const everyone = createRoomForm({ isAdmin: false, canPrivate: true });
    assert.match(everyone, /Private huddle/);
    assert.match(everyone, /value="private"[^>]*checked/);
    assert.ok(!everyone.includes('value="both"'), 'public kinds are the admin’s');

    const adminAll = createRoomForm({ isAdmin: true, canPrivate: true });
    assert.match(adminAll, /value="both"[^>]*checked/);
    assert.match(adminAll, /Private huddle/);

    const noFeature = createRoomForm({ isAdmin: true, canPrivate: false });
    assert.ok(!noFeature.includes('Private huddle'));
});
