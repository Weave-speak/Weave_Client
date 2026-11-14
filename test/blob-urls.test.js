// The cache of object URLs behind chat pictures and sounds.
//
// It was a Map that never let go of anything. What is pinned here is that it now does —
// and, just as much, the one thing it must NOT let go of: a picture that is on screen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlobUrls } from '../src/room/blob-urls.js';

/** A cache over fake URLs, recording what was revoked and letting the test say what is shown. */
function harness({ maxBytes = 100 } = {}) {
    let made = 0;
    const revoked = [];
    const shown = new Set();
    const cache = createBlobUrls({
        maxBytes,
        create: () => `blob:${++made}`,
        revoke: (url) => revoked.push(url),
        inUse: (url) => shown.has(url),
    });
    return { cache, revoked, shown };
}

const blob = (size) => ({ size });

test('bytes fetched once are handed back by the same URL', () => {
    const { cache, revoked } = harness();
    const url = cache.put('/a', blob(10));
    assert.equal(cache.get('/a'), url);
    assert.equal(cache.get('/missing'), undefined);
    assert.equal(cache.put('/a', blob(10)), url, 'a second fetch landing does not replace a URL already in an element');
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 10);
    assert.deepEqual(revoked, []);
});

test('over budget, the one asked for longest ago goes first — and is revoked', () => {
    const { cache, revoked } = harness({ maxBytes: 100 });
    const a = cache.put('/a', blob(40));
    cache.put('/b', blob(40));
    cache.get('/a');                    // a is now the more recently used of the two
    cache.put('/c', blob(40));          // 120 bytes: something has to go
    assert.deepEqual(revoked, ['blob:2'], 'b, not a');
    assert.equal(cache.get('/a'), a);
    assert.equal(cache.get('/b'), undefined, 'and a later look-up misses, so it is fetched again');
    assert.equal(cache.bytes, 80);
});

test('a picture on screen is never revoked, whatever the budget says', () => {
    // The lightbox opens by giving the same src to a new element. Revoke it and that
    // element loads nothing.
    const { cache, revoked, shown } = harness({ maxBytes: 100 });
    shown.add(cache.put('/a', blob(60)));
    shown.add(cache.put('/b', blob(60)));
    assert.deepEqual(revoked, [], 'over budget, and both still held');
    assert.equal(cache.bytes, 120);

    shown.clear();                       // the channel was switched; neither is shown now
    cache.put('/c', blob(10));
    assert.deepEqual(revoked, ['blob:1'], 'and the next arrival settles the debt, oldest first');
    assert.ok(cache.bytes <= 100);
});

test('the newest arrival survives its own insertion', () => {
    // It is about to be handed to an element that inUse cannot see yet.
    const { cache, revoked } = harness({ maxBytes: 100 });
    cache.put('/a', blob(90));
    const b = cache.put('/b', blob(90));
    assert.deepEqual(revoked, ['blob:1']);
    assert.equal(cache.get('/b'), b);
});

test('destroy releases every URL', () => {
    const { cache, revoked, shown } = harness();
    shown.add(cache.put('/a', blob(10)));
    cache.put('/b', blob(10));
    cache.destroy();
    assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2'], 'on screen or not: this is signing out');
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});
