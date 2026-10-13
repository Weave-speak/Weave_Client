// Shortcuts that work in every program.
//
// The rule that matters most is the one about what may NOT be a shortcut. A global
// shortcut takes its key from every other program on the machine, so binding a bare letter
// would stop somebody typing that letter anywhere until Weave was closed — a bug that
// shows up nowhere near Weave and is very hard to trace back to it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bindingFromKeydown, bindingError, acceleratorFor, labelFor, matchesKeydown,
} from '../src/ui/hotkey.js';

/** A keydown as the browser would hand it over. */
const press = (code, mods = {}) => ({
    code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

test('a modifier on its own is somebody part-way through a combination', () => {
    for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft']) {
        assert.deepEqual(bindingFromKeydown(press(code, { ctrlKey: true })), { pending: true }, code);
    }
});

test('a key nothing types with, or a combination with Ctrl, Alt or Win, is accepted', () => {
    assert.deepEqual(bindingFromKeydown(press('KeyM', { ctrlKey: true, shiftKey: true })),
        { binding: 'Control+Shift+KeyM' });
    assert.deepEqual(bindingFromKeydown(press('F9')), { binding: 'F9' });
    assert.deepEqual(bindingFromKeydown(press('F13', { shiftKey: true })), { binding: 'Shift+F13' });
    assert.deepEqual(bindingFromKeydown(press('Digit1', { altKey: true })), { binding: 'Alt+Digit1' });
    assert.deepEqual(bindingFromKeydown(press('KeyM', { metaKey: true })), { binding: 'Meta+KeyM' });
});

test('a key that types something everywhere is refused, Shift or no Shift', () => {
    // Shift+M is a capital M. Taking it would break typing in every program just as surely.
    for (const event of [press('KeyM'), press('KeyM', { shiftKey: true }), press('Space'), press('Digit5')]) {
        assert.deepEqual(bindingFromKeydown(event), { error: 'needs-modifier' }, event.code);
    }
    assert.match(bindingError('needs-modifier'), /Ctrl or Alt, or use an F-key/);
});

test('a key the operating system has no name for is refused rather than accepted and dead', () => {
    assert.deepEqual(bindingFromKeydown(press('IntlBackslash', { ctrlKey: true })), { error: 'unsupported' });
    assert.match(bindingError('unsupported'), /cannot be a shortcut/);
});

test('the binding is translated into what Electron registers', () => {
    assert.equal(acceleratorFor('Control+Shift+KeyM'), 'Control+Shift+M');
    assert.equal(acceleratorFor('Alt+Digit1'), 'Alt+1');
    assert.equal(acceleratorFor('F9'), 'F9');
    assert.equal(acceleratorFor('Meta+KeyM'), 'Super+M', 'Electron calls the Windows key Super');
    assert.equal(acceleratorFor('Control+Backquote'), 'Control+`');
    assert.equal(acceleratorFor('Control+Numpad5'), 'Control+num5');
    assert.equal(acceleratorFor('Control+ArrowUp'), 'Control+Up');
});

test('anything that is not a binding registers nothing', () => {
    for (const nonsense of [null, undefined, '', 'Control+', 'Hyper+KeyM', 'Control+IntlBackslash', 42]) {
        assert.equal(acceleratorFor(nonsense), null, String(nonsense));
    }
});

test('modifiers always come out in the same order, however they were pressed', () => {
    assert.equal(acceleratorFor('Shift+Control+KeyM'), 'Control+Shift+M');
    assert.equal(labelFor('Shift+Control+KeyM'), 'Ctrl + Shift + M');
});

test('the label is what is printed on the keys', () => {
    assert.equal(labelFor('Control+Shift+KeyM'), 'Ctrl + Shift + M');
    assert.equal(labelFor('Meta+Alt+F4'), 'Alt + Win + F4');
    assert.equal(labelFor('Control+Numpad5'), 'Ctrl + Num 5');
    assert.equal(labelFor('Control+Enter'), 'Ctrl + Enter');
    assert.equal(labelFor(''), 'Not set');
});

test('in a browser the binding matches exactly, extra modifiers included', () => {
    const binding = 'Control+Shift+KeyM';
    assert.equal(matchesKeydown(press('KeyM', { ctrlKey: true, shiftKey: true }), binding), true);
    assert.equal(matchesKeydown(press('KeyM', { ctrlKey: true }), binding), false);
    // Ctrl+Alt+Shift+M is very likely somebody else's shortcut.
    assert.equal(matchesKeydown(press('KeyM', { ctrlKey: true, shiftKey: true, altKey: true }), binding), false);
    assert.equal(matchesKeydown(press('KeyN', { ctrlKey: true, shiftKey: true }), binding), false);
    assert.equal(matchesKeydown(press('F9'), 'F9'), true);
    assert.equal(matchesKeydown(press('F9'), null), false);
});
