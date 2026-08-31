// What this client tells the server about whether anyone is here.
//
// The distinction the whole thing rests on is null versus zero. Null means "this build
// cannot see OS input" — every browser — and it must leave the server on its older signal.
// Zero means "somebody just moved the mouse". Collapsing the two would claim permanent
// activity for every web client and silently switch the away feature off for them, which
// is a failure nobody would ever report as a bug.

import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveIdleMs, createIdleReporter } from '../src/room/idle.js';

test('a build with no shell to ask reports nothing, not zero', () => {
    assert.equal(effectiveIdleMs({ osIdleMs: null }), null);
    assert.equal(effectiveIdleMs({}), null);
    assert.equal(effectiveIdleMs(), null);
    // Nonsense from a bridge is also "I cannot tell you" rather than "wide awake".
    assert.equal(effectiveIdleMs({ osIdleMs: Number.NaN }), null);
    assert.equal(effectiveIdleMs({ osIdleMs: Infinity }), null);
});

test('OS idle time passes through, and never goes negative', () => {
    assert.equal(effectiveIdleMs({ osIdleMs: 0 }), 0);
    assert.equal(effectiveIdleMs({ osIdleMs: 90_000 }), 90_000);
    // A clock that went backwards must not turn into a claim about the future.
    assert.equal(effectiveIdleMs({ osIdleMs: -5000 }), 0);
});

test('watching a stream in Weave counts as being here', () => {
    // The case that makes a pure input-idle measure feel broken: an hour into somebody's
    // screen share, hands nowhere near the keyboard. It is also the ONLY version of that
    // case this side of the wire can answer, because the stream is being consumed here.
    assert.equal(effectiveIdleMs({ osIdleMs: 3_600_000, watchingVideo: true }), 0);
    assert.equal(effectiveIdleMs({ osIdleMs: 3_600_000, watchingVideo: false }), 3_600_000);

    // But it cannot invent a report where there is none to make. A browser watching a
    // stream still says nothing, because it has nothing to say.
    assert.equal(effectiveIdleMs({ osIdleMs: null, watchingVideo: true }), null);
});

test('the reporter is absent when there is no bridge, and says so', () => {
    const browser = createIdleReporter({ platform: { power: { available: false, idleSeconds: null } } });
    assert.equal(browser.available, false);
    assert.equal(browser.current(), null);

    // The desktop UI is routinely run in a plain browser during development, so a missing
    // platform entirely must not throw.
    assert.equal(createIdleReporter({ platform: {} }).current(), null);
    assert.equal(createIdleReporter({}).current(), null);
});

test('the reporter converts seconds to milliseconds', () => {
    const r = createIdleReporter({ platform: { power: { idleSeconds: () => 42 } } });
    assert.equal(r.available, true);
    assert.equal(r.current(), 42_000);
});

test('a bridge that throws or lies is treated as no bridge at all', () => {
    const throws = createIdleReporter({
        platform: { power: { idleSeconds: () => { throw new Error('no such API'); } } },
    });
    assert.equal(throws.current(), null, 'a bridge that throws is a bridge that is not there');

    const lies = createIdleReporter({ platform: { power: { idleSeconds: () => 'ages' } } });
    assert.equal(lies.current(), null);
});

test('the reporter asks about video every time, not once', () => {
    // Whether somebody is watching changes constantly; reading it at construction would
    // freeze the answer to whatever was true when the app started.
    let watching = false;
    const r = createIdleReporter({
        platform: { power: { idleSeconds: () => 600 } },
        isWatchingVideo: () => watching,
    });

    assert.equal(r.current(), 600_000);
    watching = true;
    assert.equal(r.current(), 0);
    watching = false;
    assert.equal(r.current(), 600_000);
});
