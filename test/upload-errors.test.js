// What a failed picture upload tells the person.
//
// fetch() rejecting means no reply arrived at all, and the browser's own wording for that —
// "Failed to fetch" — was what a phone showed on a bubble's picture chip. It names nothing
// anyone can act on. uploadFile() now says what happened, and keeps the browser's words as
// the error's detail, for the log.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi, ApiError } from '../src/lib/api.js';

/** Runs `fn` with fetch replaced, and puts the real one back whatever happens. */
async function withFetch(fake, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try { return await fn(); } finally { globalThis.fetch = real; }
}

const picture = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

test('an upload that never got a reply says so, not "Failed to fetch"', async () => {
    const api = createApi({ origin: 'https://weave.example', token: 't' });
    const err = await withFetch(async () => { throw new TypeError('Failed to fetch'); },
        () => api.uploadFile(picture()).catch((e) => e));
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /could not reach the server/);
    assert.doesNotMatch(err.message, /Failed to fetch/);
    assert.equal(err.detail, 'Failed to fetch', 'the browser\'s own words are kept for the log');
    assert.equal(err.status, 0);
});

test('an upload that ran out of time says that instead', async () => {
    const api = createApi({ origin: 'https://weave.example', token: 't' });
    const timeout = new DOMException('signal timed out', 'TimeoutError');
    const err = await withFetch(async () => { throw timeout; }, () => api.uploadFile(picture()).catch((e) => e));
    assert.match(err.message, /took too long/);
});

test('a refusal from the server still comes through in its own words', async () => {
    const api = createApi({ origin: 'https://weave.example', token: 't' });
    const reply = new Response(JSON.stringify({ message: 'Request body too large (limit 10485760 bytes)' }),
        { status: 413, headers: { 'Content-Type': 'application/json' } });
    const err = await withFetch(async () => reply, () => api.uploadFile(picture()).catch((e) => e));
    assert.equal(err.status, 413);
    assert.match(err.message, /too large/);
});

test('the picture goes to the uploads endpoint with the session, as it did', async () => {
    const api = createApi({ origin: 'https://weave.example', token: 'secret-token' });
    let seen = null;
    const stored = await withFetch(async (url, init) => {
        seen = { url, method: init.method, auth: init.headers.Authorization, body: init.body };
        return new Response(JSON.stringify({ id: 'u1', url: '/api/uploads/u1', mime: 'image/png', bytes: 4 }),
            { status: 201, headers: { 'Content-Type': 'application/json' } });
    }, () => api.uploadFile(picture()));
    assert.equal(seen.url, 'https://weave.example/api/uploads');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.auth, 'Bearer secret-token');
    assert.ok(seen.body instanceof Blob);
    assert.equal(stored.id, 'u1');
});
