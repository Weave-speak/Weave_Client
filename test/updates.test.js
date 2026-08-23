// What the update bar says.
//
// The states here are the ones a person sees at launch, and the two that matter most are
// the ones that look like a bug when they are not: a download that has gone quiet, and an
// update that failed but left a perfectly working app behind.

import test from 'node:test';
import assert from 'node:assert/strict';

import { describe as describeUpdate } from '../src/updates/banner.js';

test('nothing to report shows nothing', () => {
    // A bar that announces "you are up to date" on every single launch is noise, and noise
    // is what teaches people to ignore the place real messages appear.
    for (const status of ['idle', 'current', 'skipped', 'unsupported', undefined]) {
        assert.equal(describeUpdate({ status }).show, false, `status ${status}`);
    }
    assert.equal(describeUpdate().show, false);
});

test('checking is indeterminate, because there is no progress to report yet', () => {
    const view = describeUpdate({ status: 'checking' });
    assert.equal(view.show, true);
    assert.equal(view.indeterminate, true);
    assert.match(view.text, /Checking/);
});

test('a download names the version and its progress', () => {
    const view = describeUpdate({ status: 'downloading', version: '0.2.0', percent: 43, bytesPerSecond: 2_400_000 });
    assert.match(view.text, /Downloading Weave 0\.2\.0/);
    assert.equal(view.percent, 43);
    assert.equal(view.detail, '2.3 MB/s');
});

test('a download with no version yet still shows something true', () => {
    const view = describeUpdate({ status: 'downloading' });
    assert.equal(view.text, 'Downloading update');
    assert.equal(view.percent, 0);
});

test('a ready update offers the restart rather than taking it', () => {
    // Restarting underneath someone mid-conversation is the behaviour people uninstall over.
    const view = describeUpdate({ status: 'ready', version: '0.2.0' });
    assert.match(view.text, /0\.2\.0 is ready/);
    assert.equal(view.percent, 100);
    assert.equal(view.action, 'restart');
});

test('a failed update says the app still works', () => {
    // The app reached the login screen; the update is the only thing that broke. Saying so
    // is the difference between a notice and an alarm.
    const view = describeUpdate({ status: 'failed', message: 'ENOTFOUND' });
    assert.equal(view.failed, true);
    assert.match(view.text, /keep using this version/i);
    assert.equal(view.action, 'diagnose');
    // The raw error is not put in front of the user; it goes in the log they can send.
    assert.ok(!view.text.includes('ENOTFOUND'));
});

test('transfer rates read the way a person would say them', () => {
    const at = (bps) => describeUpdate({ status: 'downloading', bytesPerSecond: bps }).detail;
    assert.equal(at(512), '512 B/s');
    assert.equal(at(1024), '1.0 KB/s');
    assert.equal(at(1_500_000), '1.4 MB/s');
    assert.equal(at(0), '');
});
