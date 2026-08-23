// The server list. Two behaviours here are load-bearing and were both got wrong once:
// a server is only remembered after it has been proven to work, and anything displaying
// the current server has to be told when it changes.

import test from 'node:test';
import assert from 'node:assert/strict';

// The build normally injects these. Setting them before the import is what lets the
// desktop code path — the only one with a server list at all — be exercised under Node.
globalThis.__WEAVE_TARGET__ = 'desktop';
globalThis.__WEAVE_VERSION__ = '0.0.0-test';

/** Enough of the two browser globals the store touches. */
function installDom() {
    const map = new Map();
    const store = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
    };
    // Object.keys(localStorage) is how forgetServer sweeps namespaced settings.
    globalThis.localStorage = new Proxy(store, {
        ownKeys: () => [...map.keys()],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });

    const listeners = new Map();
    globalThis.window = {
        addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
        dispatchEvent: (e) => { for (const fn of listeners.get(e.type) ?? []) fn(e); return true; },
    };
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    return { map, listeners };
}

const dom = installDom();
const store = await import('../src/server/store.js');

const found = (origin, over = {}) => ({
    address: { origin },
    info: { version: '0.1.0', protocol: { min: 1, max: 1 }, instance: { name: 'Test Weave' }, features: [], ...over },
});

test.beforeEach(() => {
    globalThis.localStorage.clear();
});

test('a blank client has no servers and no active one', () => {
    assert.deepEqual(store.listServers(), []);
    assert.equal(store.activeServer(), null);
});

test('a discovered server is remembered and becomes active', () => {
    const rec = store.rememberServer(found('https://weave.example.com'));
    assert.equal(store.listServers().length, 1);
    assert.equal(store.activeServer().id, rec.id);
    // The server's own name is the better default label than the hostname.
    assert.equal(rec.label, 'Test Weave');
    assert.equal(rec.lastSeen.version, '0.1.0');
});

test('re-adding the same origin updates in place rather than duplicating', () => {
    const first = store.rememberServer(found('https://weave.example.com'));
    const again = store.rememberServer(found('https://weave.example.com', { version: '0.2.0' }));
    assert.equal(store.listServers().length, 1);
    // The id is stable, so per-server settings survive the server being re-added.
    assert.equal(again.id, first.id);
    assert.equal(again.lastSeen.version, '0.2.0');
});

test('a custom label survives a later re-discovery', () => {
    const rec = store.rememberServer(found('https://weave.example.com'), { label: 'Crew' });
    assert.equal(store.rememberServer(found('https://weave.example.com')).label, 'Crew');
    assert.equal(store.getServer(rec.id).label, 'Crew');
});

test('every change announces itself, because nothing else signals it', () => {
    // Adding or switching a server does not change the URL, so a view that renders once
    // would keep showing whatever was true at boot. That is exactly the bug this prevents.
    let beats = 0;
    globalThis.window.addEventListener('weave:server-changed', () => { beats += 1; });

    const a = store.rememberServer(found('https://a.example.com'));
    const b = store.rememberServer(found('https://b.example.com'));
    store.setActive(a.id);
    store.forgetServer(b.id);

    assert.equal(beats, 4);
});

test('forgetting a server takes its namespaced settings with it', () => {
    const a = store.rememberServer(found('https://a.example.com'));
    const b = store.rememberServer(found('https://b.example.com'));

    store.settingsFor(a.id).set('micGain', 1.5);
    store.settingsFor(b.id).set('micGain', 0.5);

    store.forgetServer(a.id);

    assert.equal(store.settingsFor(a.id).get('micGain'), null);
    // The other server's settings are untouched — that is the whole point of namespacing.
    assert.equal(store.settingsFor(b.id).get('micGain'), 0.5);
    assert.equal(store.activeServer().id, b.id);
});

test('forgetting the active server falls back to one that still exists', () => {
    const a = store.rememberServer(found('https://a.example.com'));
    const b = store.rememberServer(found('https://b.example.com'));
    assert.equal(store.activeServer().id, b.id);
    store.forgetServer(b.id);
    assert.equal(store.activeServer().id, a.id);
    store.forgetServer(a.id);
    assert.equal(store.activeServer(), null);
});

test('a duplicate is recognised from typed input, before anything is contacted', () => {
    store.rememberServer(found('https://weave.example.com'));
    // Same server, three ways of writing it.
    for (const typed of ['weave.example.com', 'https://weave.example.com', 'wss://weave.example.com/x']) {
        assert.ok(store.findByAddress(typed), typed);
    }
    assert.equal(store.findByAddress('other.example.com'), null);
    assert.equal(store.findByAddress(''), null);
});

test('corrupt storage reads as empty instead of throwing during render', () => {
    globalThis.localStorage.setItem('weave:servers:list', '{ not json');
    assert.deepEqual(store.listServers(), []);
    globalThis.localStorage.setItem('weave:servers:list', '"a string"');
    assert.deepEqual(store.listServers(), []);
});

void dom;
