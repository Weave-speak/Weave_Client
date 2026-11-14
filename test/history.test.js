// History paging: the bookkeeping that decides what to fetch and when to stop.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    freshHistory, advanceHistory, nextPageQuery, shouldLoadOlder, mergeOlder, PAGE_SIZE,
    shouldTrim, rewindHistory, TRIM_ABOVE, TRIM_KEEP,
} from '../src/room/history.js';
import { createRoomState } from '../src/room/state.js';

test('a long timeline is cut back only when that disturbs nobody', () => {
    const long = TRIM_ABOVE + 1;
    assert.equal(shouldTrim({ length: TRIM_ABOVE, onScreen: true, atBottom: true }), false, 'not yet long');
    assert.equal(shouldTrim({ length: long, onScreen: true, atBottom: true }), true);
    assert.equal(shouldTrim({ length: long, onScreen: true, atBottom: false }), false,
        'somebody scrolled up is reading the rows that would go');
    assert.equal(shouldTrim({ length: long, onScreen: false }), true, 'a channel nobody is looking at has no reader');
    assert.equal(shouldTrim({ length: long, onScreen: false, busy: true }), false,
        'an older page in flight would land on a list that no longer reaches it');
    assert.ok(TRIM_KEEP < TRIM_ABOVE, 'or every message past the limit would trim again');
    assert.ok(TRIM_KEEP >= PAGE_SIZE, 'what is kept is at least what opening the channel would fetch');
});

test('after a trim, paging resumes from the oldest message still held', () => {
    // The cursor used to name the oldest message EVER fetched, and done had latched.
    const seen = { ...advanceHistory(freshHistory(), {}), nextBefore: 5, nextBeforeId: 'm-1' };
    assert.equal(seen.done, true);
    const entry = rewindHistory(seen, { id: 'm-300', createdAt: 9000 });
    assert.equal(entry.done, false);
    assert.equal(shouldLoadOlder(entry, 0), true);
    assert.match(nextPageQuery(entry), /before=9000&beforeId=m-300/);
    // Nothing to point at: leave the bookkeeping alone rather than aim it at undefined.
    assert.deepEqual(rewindHistory(seen, null), seen);
    assert.deepEqual(rewindHistory(undefined, { id: 'm-1', createdAt: 1 }),
        { ...freshHistory(), nextBefore: 1, nextBeforeId: 'm-1' });
});

test('the store lets go of the oldest messages and says where paging resumes', () => {
    const state = createRoomState({ me: { id: 'u1', username: 'me' }, server: { name: 'Weave' } });
    let emitted = 0;
    state.subscribe(() => { emitted += 1; });
    state.setMessages('c1', Array.from({ length: 10 }, (_, i) => ({ id: `m-${i}`, createdAt: i })));
    emitted = 0;

    assert.equal(state.trimMessages('c1', 10), null, 'nothing to drop');
    assert.equal(state.trimMessages('nowhere', 3), null);
    assert.equal(emitted, 0, 'and nothing to repaint');

    assert.deepEqual(state.trimMessages('c1', 3), { id: 'm-7', createdAt: 7 });
    assert.deepEqual(state.raw.messages.get('c1').map((m) => m.id), ['m-7', 'm-8', 'm-9']);
    assert.equal(emitted, 1);
});

test('a fresh channel asks for the newest page with no cursor', () => {
    const q = nextPageQuery(freshHistory());
    assert.equal(q, `limit=${PAGE_SIZE}`);
});

test('a full page advances the cursor; the next request carries it', () => {
    const entry = advanceHistory(freshHistory(), { nextBefore: 1700000000000, nextBeforeId: 'm-40' });
    assert.equal(entry.done, false);
    const q = new URLSearchParams(nextPageQuery(entry));
    assert.equal(q.get('before'), '1700000000000');
    assert.equal(q.get('beforeId'), 'm-40');
});

test('a short page means the beginning was reached, and done latches', () => {
    let entry = advanceHistory(freshHistory(), { nextBefore: 5, nextBeforeId: 'a' });
    entry = advanceHistory(entry, { nextBefore: null, nextBeforeId: null });
    assert.equal(entry.done, true);
    // A later response cannot un-finish a channel.
    entry = advanceHistory(entry, { nextBefore: 3, nextBeforeId: 'b' });
    assert.equal(entry.done, true);
});

test('loading is offered only near the top, once, and never past the beginning', () => {
    const ready = { ...freshHistory(), nextBefore: 5, nextBeforeId: 'a' };
    assert.equal(shouldLoadOlder(ready, 100), true);
    assert.equal(shouldLoadOlder(ready, 2000), false, 'mid-scroll asks for nothing');
    assert.equal(shouldLoadOlder({ ...ready, busy: true }, 100), false, 'one request at a time');
    assert.equal(shouldLoadOlder({ ...ready, done: true }, 100), false, 'the well is dry');
    assert.equal(shouldLoadOlder(freshHistory(), 100), false, 'no cursor before the first page');
    assert.equal(shouldLoadOlder(null, 100), false);
});

test('older messages join in front, and the page boundary cannot duplicate', () => {
    const existing = [{ id: 'c' }, { id: 'd' }];
    const merged = mergeOlder(existing, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c', 'd']);
});

test('merging into an empty timeline is just the page', () => {
    assert.deepEqual(mergeOlder([], [{ id: 'a' }]).map((m) => m.id), ['a']);
});
