// How the settings dialog loads, and how long it waits.
//
// The bug these pin down had two halves. The dialog asked for seven things one after another
// and showed nothing until the last answer, so a slow server meant a dead button for as long
// as fifteen seconds a request; and the clicks people made while waiting are what broke it.
// So: everything starts at once, nothing waits past the grace, and a second click joins the
// first instead of starting another.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    startLoads, settleWithin, singleFlight, LOAD_PANELS, OPEN_GRACE_MS,
} from '../src/settings/loading.js';

const ALL_FEATURES = ['module.afk', 'module.sounds', 'account.sessions', 'account.security'];

/** Let every queued promise callback run, without touching (mocked) timers. */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** An API whose every call is recorded and stays unanswered until told otherwise. */
function pendingApi() {
    const started = [];
    const call = (label) => {
        started.push(label);
        return new Promise(() => {});
    };
    return {
        started,
        me: () => call('GET /api/me'),
        securityQuestions: () => call('GET /api/auth/questions'),
        request: (method, path) => call(`${method} ${path}`),
    };
}

test('every load starts before any of them has answered', () => {
    const api = pendingApi();
    const diagnostics = { available: true, readAppLog: () => { api.started.push('app log'); return new Promise(() => {}); } };

    const loads = startLoads({ api, features: ALL_FEATURES, diagnostics });

    // Nothing has answered — none of these promises ever will — and all of them are out.
    assert.deepEqual(api.started.sort(), [
        'GET /api/afk/opt-out',
        'GET /api/auth/questions',
        'GET /api/me',
        'GET /api/me/security-question',
        'GET /api/me/sessions',
        'GET /api/sounds',
        'GET /api/sounds/me',
        'app log',
    ]);
    assert.deepEqual(Object.keys(loads).sort(), Object.keys(LOAD_PANELS).sort(),
        'every load knows which panel it repaints');
});

test('a server is asked only about what it advertises', () => {
    const bare = pendingApi();
    startLoads({ api: bare, features: [] });
    assert.deepEqual(bare.started, ['GET /api/me'], 'an older server is not sent requests it can only 404');

    const someOf = pendingApi();
    const loads = startLoads({ api: someOf, features: ['module.afk'], diagnostics: { available: false } });
    assert.deepEqual(Object.keys(loads).sort(), ['afk', 'me']);
});

test('a call that throws is a failed load, not a failed open', async () => {
    const api = { ...pendingApi(), me: () => { throw new TypeError('no session'); } };
    const loads = startLoads({ api, features: [] });
    await assert.rejects(loads.me, /no session/);
});

test('the wait ends as soon as everything has answered', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const loads = { a: Promise.resolve(1), b: Promise.reject(new Error('refused')) };

    // No clock has moved: answering is enough. A refusal counts as an answer — each caller
    // has its own fallback for one.
    const result = await settleWithin(loads, OPEN_GRACE_MS);
    assert.deepEqual(result, { timedOut: false, pending: [] });
});

test('one load that never answers holds the dialog for the grace and no longer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const loads = {
        me: Promise.resolve({ user: {} }),
        sessions: new Promise(() => {}),     // a half-dead connection
        sounds: Promise.reject(new Error('timeout')),
    };

    let result = null;
    settleWithin(loads, OPEN_GRACE_MS).then((r) => { result = r; });
    await flush();
    assert.equal(result, null, 'still inside the grace');

    t.mock.timers.tick(OPEN_GRACE_MS - 1);
    await flush();
    assert.equal(result, null);

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(result, { timedOut: true, pending: ['sessions'] }, 'and it says which one it gave up on');
});

test('the grace is short enough that a click never feels unanswered', () => {
    // It used to be the sum of seven round trips. Anything past a few hundred milliseconds
    // reads as a button that did not work, and that is what made people click twice.
    assert.ok(OPEN_GRACE_MS > 0 && OPEN_GRACE_MS <= 300, `${OPEN_GRACE_MS}ms`);
});

test('a second call while the first is under way joins it', async () => {
    let runs = 0;
    let finish;
    const open = singleFlight(() => {
        runs += 1;
        return new Promise((resolve) => { finish = resolve; });
    });

    const first = open('button');
    const second = open('button');
    assert.equal(first, second, 'the same promise, not a second dialog');
    assert.equal(runs, 1);

    finish('opened');
    assert.equal(await second, 'opened');

    // Once it has settled, the next click is a new open.
    const third = open('button');
    assert.notEqual(third, first);
    assert.equal(runs, 2);
    finish('again');
    await third;
});

test('a failed run does not leave the door shut', async () => {
    let attempts = 0;
    const open = singleFlight(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('InvalidStateError');
        return 'opened';
    });

    await assert.rejects(open(), /InvalidStateError/);
    assert.equal(await open(), 'opened', 'the next click still gets its own try');
});

test('a call that throws before it returns a promise still rejects, and still releases', async () => {
    let calls = 0;
    const open = singleFlight(() => {
        calls += 1;
        if (calls === 1) throw new TypeError('synchronous');
        return 'fine';
    });
    await assert.rejects(open(), /synchronous/);
    assert.equal(await open(), 'fine');
});
