// History paging: the bookkeeping that decides what to fetch and when to stop.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    freshHistory, advanceHistory, nextPageQuery, shouldLoadOlder, mergeOlder, PAGE_SIZE,
} from '../src/room/history.js';

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
