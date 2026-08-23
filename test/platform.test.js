// Which server the app talks to, and who gets to decide.
//
// This file exists because of a real dead end: the browser build assumed the page had been
// served BY a Weave server, so when anything else served it — a dev server, a static host,
// a misconfigured deployment — you got a sign-in form aimed at something that could never
// answer, with no way to point it anywhere else. No error, no escape hatch, just a login
// that silently could not work.

import test from 'node:test';
import assert from 'node:assert/strict';

// No target set: this is the browser build, which is the one with the interesting behaviour.
const { platform, TARGET, noteOriginIsWeave } = await import('../src/platform/index.js');
const views = await import('../src/auth/views.js');

test('the browser build does not claim to know its server before it has asked', () => {
    assert.equal(TARGET, 'browser');
    assert.equal(platform.servedByWeave, null, 'unknown, not assumed');
    // While unknown, the app must not offer a picker it may turn out not to need.
    assert.equal(platform.canChooseServer, false);

    // The origin it would probe is wherever the page came from — never a baked-in address.
    globalThis.window = { location: { origin: 'https://weave.example.com' } };
    try {
        assert.equal(platform.defaultOrigin(), 'https://weave.example.com');
    } finally {
        delete globalThis.window;
    }
});

test('an origin that IS a Weave server keeps server management out of the way', () => {
    noteOriginIsWeave(true);
    assert.equal(platform.servedByWeave, true);
    // Nothing to choose: the page was served by the only server it can reach. A picker here
    // would offer a choice that cannot be honoured — a page served over HTTPS cannot reach
    // a different HTTP server, and another HTTPS one would fail CORS on credentialed routes.
    assert.equal(platform.canChooseServer, false);
});

test('an origin that is NOT a Weave server means the app has to ask', () => {
    noteOriginIsWeave(false);
    assert.equal(platform.servedByWeave, false);
    assert.equal(platform.canChooseServer, true, 'otherwise there is no way to sign in at all');
});

test('only a literal true counts as served-by-Weave', () => {
    // The probe returns an outcome, not a boolean. A truthy-but-wrong value must not be
    // read as "yes" and quietly restore the dead end.
    for (const value of [undefined, null, 0, '', 'ok', {}, NaN]) {
        noteOriginIsWeave(value);
        assert.equal(platform.servedByWeave, false, `${String(value)} is not a yes`);
        assert.equal(platform.canChooseServer, true);
    }
    noteOriginIsWeave(true);
    assert.equal(platform.canChooseServer, false);
});

test('the fallback screen says why it is being shown', () => {
    // Landing on "Connect to a server" when you expected a login form is confusing unless
    // the screen accounts for itself.
    const explained = views.servers({ firstRun: true, servedElsewhere: true });
    assert.match(explained, /wasn&#39;t served by a Weave server/);
    assert.match(explained, /Connect to a server/);
    assert.ok(explained.includes('id="serverAddress"'), 'and offers a way out');

    // The desktop first-run copy is different: nothing has gone wrong there, the app simply
    // ships blank.
    const blank = views.servers({ firstRun: true });
    assert.match(blank, /doesn&#39;t run in the cloud/);
    assert.ok(!blank.includes('wasn&#39;t served by'));

    // And once servers exist it is just a list, whatever the build.
    const later = views.servers({ firstRun: false, servedElsewhere: true });
    assert.match(later, /Add another server/);
});

test('a desktop build never probes, because it has no origin to probe', async () => {
    // Loaded in a separate realm so the module-level probe state cannot leak between them.
    globalThis.__WEAVE_TARGET__ = 'desktop';
    const fresh = await import(`../src/platform/index.js?desktop=${TARGET}`);

    assert.equal(fresh.TARGET, 'desktop');
    assert.equal(fresh.platform.canChooseServer, true, 'a blank app always chooses');
    assert.equal(fresh.platform.defaultOrigin(), null, 'there is no origin to inherit');
    delete globalThis.__WEAVE_TARGET__;
});
