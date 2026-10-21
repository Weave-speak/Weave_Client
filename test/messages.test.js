// Turning stored messages into a timeline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { toTimelineItems, dayLabel, resolveMentions, GROUP_WINDOW_MS } from '../src/room/messages.js';
import { messageList } from '../src/room/views/timeline.js';

const ME = { id: 'u-me', username: 'ghostbyte', displayName: 'Ghostbyte' };
const users = new Map([
    ['u-me', ME],
    ['u-kes', { id: 'u-kes', username: 'kestrel', displayName: 'Kestrel', isAdmin: true }],
]);

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const record = (id, ms, extra = {}) => ({
    id, createdAt: ms, channelId: 'c1', userId: 'u-kes', authorName: 'Kestrel', body: 'hello', ...extra,
});

test('a day separator is inserted once per day, not once per message', () => {
    const day = at(2026, 8, 20, 9);
    const items = toTimelineItems([
        record('a', day),
        record('b', day + 60_000),
        record('c', day + 86_400_000),
    ], { users, me: ME, now: at(2026, 8, 21, 12) });

    const separators = items.filter((i) => i.kind === 'day');
    assert.equal(separators.length, 2, 'two days, two separators');
    assert.equal(items[0].kind, 'day', 'the timeline opens with one');
    assert.equal(items.filter((i) => i.kind === 'message').length, 3);
});

test('days read the way a person would say them', () => {
    const now = at(2026, 8, 23, 15);
    assert.equal(dayLabel(at(2026, 8, 23, 9), now), 'Today');
    assert.equal(dayLabel(at(2026, 8, 22, 23), now), 'Yesterday');
    // Within the week a weekday is more useful than a date; beyond it, it is worse.
    assert.match(dayLabel(at(2026, 8, 19), now), /^[A-Z][a-z]+day$/);
    assert.ok(!/day$/.test(dayLabel(at(2026, 7, 1), now)), 'a month ago is a date');
});

test('a message just before midnight is not filed under today', () => {
    // Off-by-one here puts last night under the wrong heading, which reads as the app
    // getting the date wrong.
    const now = at(2026, 8, 23, 0, 30);
    assert.equal(dayLabel(at(2026, 8, 22, 23, 59), now), 'Yesterday');
    assert.equal(dayLabel(at(2026, 8, 23, 0, 1), now), 'Today');
});

test('messages sharing a millisecond keep a stable order', () => {
    // The timestamp alone is not a total order. Without the id tiebreak an unstable sort
    // lets two messages swap places on every repaint, which looks like the conversation
    // rewriting itself.
    const same = at(2026, 8, 23, 10);
    const first = toTimelineItems([record('b', same), record('a', same)], { users, me: ME });
    const second = toTimelineItems([record('a', same), record('b', same)], { users, me: ME });

    const ids = (items) => items.filter((i) => i.kind === 'message').map((i) => i.id);
    assert.deepEqual(ids(first), ['a', 'b']);
    assert.deepEqual(ids(first), ids(second), 'input order must not change output order');
});

test('the author is resolved to an account where one exists', () => {
    const [, message] = toTimelineItems([record('a', at(2026, 8, 23))], { users, me: ME });
    assert.equal(message.author.username, 'kestrel');
    assert.equal(message.author.isAdmin, true);
});

test('a message from someone no longer on the server still shows who wrote it', () => {
    const [, message] = toTimelineItems([
        record('a', at(2026, 8, 23), { userId: 'u-gone', authorName: 'Departed' }),
    ], { users, me: ME });
    assert.equal(message.author.displayName, 'Departed');
});

test('only real accounts are marked as mentions', () => {
    // Otherwise anyone could fake a mention of anyone by typing an @.
    assert.deepEqual(resolveMentions('hi @kestrel and @nobody', ['kestrel', 'ghostbyte']), ['kestrel']);
    assert.deepEqual(resolveMentions('@KESTREL', ['kestrel']), ['KESTREL'], 'matching is case-insensitive');
    assert.deepEqual(resolveMentions('no mentions here', ['kestrel']), []);
    assert.deepEqual(resolveMentions(null, ['kestrel']), []);
});

test('a mention of you is flagged, a mention of someone else is not', () => {
    const mine = toTimelineItems([record('a', at(2026, 8, 23), { body: 'hey @ghostbyte' })], { users, me: ME });
    assert.equal(mine.at(-1).mentionsMe, true);

    const theirs = toTimelineItems([record('a', at(2026, 8, 23), { body: 'hey @kestrel' })], { users, me: ME });
    assert.equal(theirs.at(-1).mentionsMe, false);
});

test('an empty history produces an empty timeline, not a stray separator', () => {
    assert.deepEqual(toTimelineItems([], { users, me: ME }), []);
    assert.deepEqual(toTimelineItems(undefined, { users, me: ME }), []);
});

test('times are rendered on a 24-hour clock with a leading zero', () => {
    const [, message] = toTimelineItems([record('a', at(2026, 8, 23, 9, 5))], { users, me: ME });
    assert.equal(message.at, '09:05');
});

/* ── grouping a person's turn ───────────────────────────────────────────── */

const messagesOf = (items) => items.filter((i) => i.kind === 'message');

test('the same person again within the window continues their turn', () => {
    const t = at(2026, 8, 23, 10);
    const [first, second, third] = messagesOf(toTimelineItems([
        record('a', t),
        record('b', t + 60_000),
        record('c', t + 120_000),
    ], { users, me: ME }));
    assert.equal(first.continued, false, 'a turn opens with a name');
    assert.equal(second.continued, true);
    assert.equal(third.continued, true, 'a run continues from the previous line, not from the first');
});

test('a pause longer than the window starts a fresh turn', () => {
    const t = at(2026, 8, 23, 10);
    const [, late] = messagesOf(toTimelineItems([
        record('a', t),
        record('b', t + GROUP_WINDOW_MS),
    ], { users, me: ME }));
    assert.equal(late.continued, false, 'exactly the window is already too long');
});

test('somebody else speaking in between breaks the turn', () => {
    const t = at(2026, 8, 23, 10);
    const [, other, back] = messagesOf(toTimelineItems([
        record('a', t),
        record('b', t + 1000, { userId: 'u-me', authorName: 'Ghostbyte' }),
        record('c', t + 2000),
    ], { users, me: ME }));
    assert.equal(other.continued, false);
    assert.equal(back.continued, false, 'coming back gets the name back');
});

test('a system line or a new day breaks the turn too', () => {
    // Otherwise a message reads as belonging to the "started streaming" line above it, or
    // carries no name at the top of a new day.
    const t = at(2026, 8, 23, 23, 59);
    const items = toTimelineItems([
        record('a', t - 60_000),
        { kind: 'system', id: 'sys-1', createdAt: t - 30_000, who: 'Kestrel', text: 'started streaming' },
        record('b', t),
        record('c', t + 2 * 60_000),   // past midnight
    ], { users, me: ME });
    const [, afterSystem, afterMidnight] = messagesOf(items);
    assert.equal(afterSystem.continued, false);
    assert.equal(afterMidnight.continued, false);
});

test('a continued row drops the face and name but keeps the name for a screen reader', () => {
    const t = at(2026, 8, 23, 10);
    const markup = messageList(toTimelineItems([record('a', t), record('b', t + 1000)], { users, me: ME }));
    const rows = markup.split('<li').slice(1);
    const second = rows.find((r) => r.includes('data-message="b"'));
    assert.match(second, /class="msg continued"/);
    assert.doesNotMatch(second, /msg-head/);
    assert.match(second, /class="sr-only">Kestrel, 10:00/);
});

test('a departed author keeps the face they had when they wrote it', () => {
    const [, message] = toTimelineItems([
        record('a', at(2026, 8, 23), { userId: 'u-gone', authorName: 'Departed', avatar: 'av-1' }),
    ], { users, me: ME });
    assert.equal(message.author.avatar, 'av-1');
});
