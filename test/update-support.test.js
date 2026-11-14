// When the updater should not even try.
//
// The updater asks GitHub for a platform-specific feed (latest.yml on Windows,
// latest-linux.yml on Linux). Releases carry only the Windows assets today, so a Linux
// build that checked would get a 404 on every launch and show "Update failed" forever,
// over the screen-share button. Not checking is the honest answer until there is a feed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { updateSkipReason } from '../electron/update-support.js';

test('an unpackaged build never checks', () => {
    assert.equal(updateSkipReason({ packaged: false, platform: 'win32' }), 'development build');
});

test('a packaged Windows build checks', () => {
    assert.equal(updateSkipReason({ packaged: true, platform: 'win32' }), null);
});

test('a packaged Linux build does not check while releases carry no Linux feed', () => {
    assert.match(updateSkipReason({ packaged: true, platform: 'linux' }), /linux/i);
});

test('development wins over platform, so the reason names what the developer is actually running', () => {
    assert.equal(updateSkipReason({ packaged: false, platform: 'linux' }), 'development build');
});
