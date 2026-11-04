// The desktop app's right-click menu.
//
// Electron shows none unless the app builds one, which left the desktop app with no Paste in
// a message box and no way to copy a picture out of the chat. These hold what each kind of
// right-click offers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { contextMenuItems } from '../electron/context-menu.js';

const roles = (items) => items.map((i) => i.role ?? i.action ?? i.type);

test('a message box offers cut, copy, paste and select all', () => {
    const items = contextMenuItems({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    });
    assert.deepEqual(roles(items), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
    // Paste is what lets a picture copied elsewhere land in a bubble or a channel.
    assert.equal(items.find((i) => i.role === 'paste').enabled, true);
    assert.equal(items.find((i) => i.role === 'cut').enabled, false, 'greyed, not missing');
});

test('selected text outside a box can be copied', () => {
    assert.deepEqual(roles(contextMenuItems({ selectionText: 'hello there' })), ['copy']);
    assert.deepEqual(contextMenuItems({ selectionText: '   ' }), [], 'whitespace is not a selection');
});

test('a picture in the chat can be copied, to paste into a bubble or anywhere else', () => {
    const items = contextMenuItems({ mediaType: 'image', hasImageContents: true });
    assert.deepEqual(items, [{ action: 'copy-image', label: 'Copy image' }]);
    assert.deepEqual(contextMenuItems({ mediaType: 'image', hasImageContents: false }), [],
        'a picture that has not loaded has nothing to copy');
});

test('a link can be copied, and groups are kept apart by separators', () => {
    const items = contextMenuItems({ linkURL: 'https://example.com', selectionText: 'example' });
    assert.deepEqual(roles(items), ['copy-link', 'separator', 'copy']);
});

test('nowhere in particular offers nothing, so no empty menu pops up', () => {
    assert.deepEqual(contextMenuItems({}), []);
    assert.deepEqual(contextMenuItems(), []);
});

test('the window raises it', () => {
    const app = readFileSync(fileURLToPath(new URL('../electron/app.js', import.meta.url)), 'utf8');
    assert.match(app, /import \{ contextMenuItems \} from '\.\/context-menu\.js';/);
    assert.match(app, /win\.webContents\.on\('context-menu'/);
    assert.match(app, /copyImageAt\(params\.x, params\.y\)/);
});
