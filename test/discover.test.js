// Discovery decides what the user is told when an address does not work. The distinctions
// it draws have to be ones it can actually make — an honest vague answer beats a specific
// wrong one — so these tests pin both the outcomes and the boundary between them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { discover, OUTCOME, CLIENT_PROTOCOL } from '../src/server/discover.js';

const ok = (body, { status = 200 } = {}) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const throws = (err) => async () => { throw err; };

const weave = (over = {}) => ({
    product: 'weave',
    version: '0.1.0',
    protocol: { min: 1, max: 1 },
    instance: { name: 'Test Weave', registration: 'invite' },
    features: ['text-chat'],
    ...over,
});

test('a healthy server returns OK with the negotiated protocol', async () => {
    const r = await discover('weave.example.com', { fetchImpl: ok(weave()) });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.protocol, 1);
    assert.equal(r.address.origin, 'https://weave.example.com');
    assert.equal(r.info.instance.name, 'Test Weave');
});

test('discovery asks the unauthenticated info endpoint and sends no credentials', async () => {
    // This runs before anyone has signed in. Sending credentials would force a preflight
    // and, on a cross-origin desktop build, fail for reasons unrelated to the server.
    let seen;
    await discover('weave.example.com', {
        fetchImpl: async (url, init) => { seen = { url, init }; return (await ok(weave())())
            ; },
    });
    assert.equal(seen.url, 'https://weave.example.com/api/server-info');
    assert.equal(seen.init.credentials, 'omit');
    assert.equal(seen.init.method, 'GET');
});

test('a bad address fails before any network call is made', async () => {
    let called = false;
    const r = await discover('', { fetchImpl: async () => { called = true; } });
    assert.equal(r.outcome, OUTCOME.BAD_ADDRESS);
    assert.equal(called, false);
});

test('a timeout is reported as a timeout, not as unreachable', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const r = await discover('weave.example.com', { fetchImpl: throws(err) });
    assert.equal(r.outcome, OUTCOME.TIMEOUT);
    assert.match(r.message, /didn't respond/);
});

test('an opaque browser fetch failure gets the single honest unreachable message', async () => {
    // In a browser, DNS failure, connection refused, TLS failure, CORS and mixed content
    // are indistinguishable. The message names those possibilities rather than picking one.
    const r = await discover('weave.example.com', { fetchImpl: throws(new TypeError('Failed to fetch')) });
    assert.equal(r.outcome, OUTCOME.UNREACHABLE);
    assert.match(r.message, /Couldn't reach a Weave server/);
});

test('a Node error code sharpens the message on desktop', async () => {
    const cases = [
        ['ENOTFOUND', /doesn't resolve/],
        ['ECONNREFUSED', /Nothing is listening/],
        ['CERT_HAS_EXPIRED', /expired certificate/],
        ['DEPTH_ZERO_SELF_SIGNED_CERT', /can't verify/],
    ];
    for (const [code, expected] of cases) {
        const err = new TypeError('fetch failed');
        err.cause = { code };
        const r = await discover('weave.example.com', { fetchImpl: throws(err) });
        assert.equal(r.outcome, OUTCOME.UNREACHABLE);
        assert.match(r.message, expected, `code ${code}`);
    }
});

test('something that answers but is not Weave is called out as such', async () => {
    const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('nope'); } };
    for (const impl of [
        ok({}, { status: 404 }),
        ok({ hello: 'world' }),
        ok({ product: 'jellyfin', protocol: { min: 1, max: 1 } }),
        async () => notJson,
    ]) {
        const r = await discover('weave.example.com', { fetchImpl: impl });
        assert.equal(r.outcome, OUTCOME.NOT_WEAVE);
    }
});

test('protocol negotiation overlaps ranges rather than demanding equality', async () => {
    // A server that speaks 1-3 and a client that speaks 1-1 agree on 1. Requiring equality
    // here is what makes a slightly newer client refuse a server that works perfectly well.
    const r = await discover('weave.example.com', {
        fetchImpl: ok(weave({ protocol: { min: 1, max: 3 } })),
    });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.protocol, CLIENT_PROTOCOL.MAX);
});

test('no overlap says which side is behind', async () => {
    const tooNew = await discover('weave.example.com', {
        fetchImpl: ok(weave({ protocol: { min: 9, max: 9 } })),
    });
    assert.equal(tooNew.outcome, OUTCOME.INCOMPATIBLE);
    assert.match(tooNew.message, /app is too old/i);

    const tooOld = await discover('weave.example.com', {
        fetchImpl: ok(weave({ protocol: { min: 0, max: 0 } })),
    });
    assert.equal(tooOld.outcome, OUTCOME.INCOMPATIBLE);
    assert.match(tooOld.message, /too old for this app/i);
    // The detail line quotes both ranges, so a bug report carries the numbers.
    assert.match(tooOld.detail, /0–0/);
});

test('a server that has never been set up says so instead of failing at login', async () => {
    const r = await discover('weave.example.com', {
        fetchImpl: ok(weave({ setupRequired: true })),
    });
    assert.equal(r.outcome, OUTCOME.NEEDS_SETUP);
    assert.match(r.message, /no administrator yet/);
});
