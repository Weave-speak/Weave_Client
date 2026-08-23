// What the room says about voice.
//
// The rule is the same one the update bar follows: silent while it works. A status line
// that reports success on every launch is noise, and noise is what teaches people not to
// read the place real problems appear.

import test from 'node:test';
import assert from 'node:assert/strict';

import { voiceNotice, voiceNoticeMarkup } from '../src/room/views/timeline.js';

test('working voice says nothing at all', () => {
    for (const state of ['idle', 'ready', 'live', undefined]) {
        assert.equal(voiceNotice({ state }).show, false, `state ${state}`);
    }
    assert.equal(voiceNotice().show, false);
    assert.equal(voiceNoticeMarkup({ state: 'live' }), '');
});

test('a refused microphone says the room still works', () => {
    // Blocking the microphone is a completely normal thing to do, and you can still read,
    // type and listen. Telling someone their app is broken when it is not is worse than
    // saying nothing.
    const view = voiceNotice({ state: 'no-mic', message: 'Microphone blocked. You can still hear everyone.' });
    assert.equal(view.show, true);
    assert.equal(view.tone, 'warn');
    assert.match(view.text, /still hear everyone/);
});

test('a room with voice disabled reads as configuration, not failure', () => {
    const view = voiceNotice({ state: 'unavailable', message: 'Voice is off in Away.' });
    assert.equal(view.tone, 'quiet', 'a deliberate setting is not an alarm');
    assert.match(view.text, /Voice is off in Away/);
});

test('recovery shows which attempt it is on', () => {
    // The count is the honest part: it says this will not go on for ever, and it lets
    // somebody reporting a problem say how far it got.
    const view = voiceNotice({ state: 'recovering', attempt: 2, of: 4 });
    assert.equal(view.tone, 'warn');
    assert.match(view.text, /2 of 4/);
});

test('giving up says what to do next', () => {
    const view = voiceNotice({ state: 'failed', message: 'Voice could not be re-established. Rejoin the room to try again.' });
    assert.equal(view.tone, 'bad');
    assert.match(view.text, /Rejoin the room/);
});

test('blocked autoplay asks for the one thing that fixes it', () => {
    // Browsers refuse to play audio until the page has been interacted with. Without this
    // the room is silent and nothing anywhere explains why.
    assert.match(voiceNotice({ state: 'blocked' }).text, /Click anywhere/);
});

test('a hostile message cannot become markup', () => {
    // The text can carry a server error string, which is not ours.
    const markup = voiceNoticeMarkup({ state: 'failed', message: '<img src=x onerror="steal()">' });
    assert.ok(!markup.includes('<img'));
    assert.ok(!/\son\w+\s*=\s*["']/.test(markup));
    assert.ok(markup.includes('&lt;img'));
});
