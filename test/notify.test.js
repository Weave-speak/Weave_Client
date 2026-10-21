// When a message deserves a sound.

import test from 'node:test';
import assert from 'node:assert/strict';

import { messageCue } from '../src/room/notify.js';

const ON = { soundMessages: true, soundMentions: true };

test('somebody else talking in the conversation on screen is heard', () => {
    assert.equal(messageCue({ onScreen: true, prefs: ON }), 'message');
});

test('your own message coming back is never a sound', () => {
    assert.equal(messageCue({ fromSelf: true, onScreen: true, prefs: ON }), null);
    assert.equal(messageCue({ fromSelf: true, addressed: true, prefs: ON }), null);
});

test('elsewhere, only what is addressed to you sounds', () => {
    assert.equal(messageCue({ onScreen: false, addressed: true, prefs: ON }), 'message');
    assert.equal(messageCue({ onScreen: false, addressed: false, prefs: ON }), null,
        'a busy channel you are not reading stays a badge');
});

test('each half answers to its own switch', () => {
    const quietRoom = { soundMessages: false, soundMentions: true };
    assert.equal(messageCue({ onScreen: true, prefs: quietRoom }), null);
    assert.equal(messageCue({ addressed: true, prefs: quietRoom }), 'message');

    const noPings = { soundMessages: true, soundMentions: false };
    assert.equal(messageCue({ onScreen: true, prefs: noPings }), 'message');
    assert.equal(messageCue({ addressed: true, prefs: noPings }), null);
});

test('deafened means silence, chimes included', () => {
    assert.equal(messageCue({ onScreen: true, deafened: true, prefs: ON }), null);
    assert.equal(messageCue({ addressed: true, deafened: true, prefs: ON }), null);
});

test('a preference never written defaults to on, as the web app did', () => {
    assert.equal(messageCue({ onScreen: true, prefs: {} }), 'message');
    assert.equal(messageCue({ addressed: true }), 'message');
});
