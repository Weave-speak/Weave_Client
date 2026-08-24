// The mute policy.
//
// Every case here is a bug report or the bug report's neighbours. The original sin was one
// boolean doing two jobs: with push-to-talk on, pressing the key MUTED a manually-unmuted
// user — the key gated the stream in exactly the wrong direction.

import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveMute, onPushToTalkChange, muteButtonDisabled } from '../src/media/mute-policy.js';

test('without push-to-talk, the standing choice is the whole story', () => {
    assert.equal(effectiveMute({ muted: false }), false);
    assert.equal(effectiveMute({ muted: true }), true);
});

test('with push-to-talk on, the key is the only thing that matters', () => {
    // THE reported bug: manually unmuted + push-to-talk on. Holding the key must open the
    // stream and releasing must close it — the standing `muted` flag is not consulted.
    assert.equal(effectiveMute({ pushToTalk: true, held: false, muted: false }), true,
        'idle key means closed stream, even for an "unmuted" user');
    assert.equal(effectiveMute({ pushToTalk: true, held: true, muted: false }), false);
    assert.equal(effectiveMute({ pushToTalk: true, held: true, muted: true }), false,
        'the stale standing flag cannot mute a held key');
});

test('deafened always means not transmitting, whatever else is set', () => {
    assert.equal(effectiveMute({ deafened: true }), true);
    assert.equal(effectiveMute({ pushToTalk: true, held: true, deafened: true }), true,
        'holding the key while deafened must not broadcast to a room you cannot hear');
});

test('turning push-to-talk on closes the gate immediately', () => {
    assert.deepEqual(onPushToTalkChange({ turnedOn: true }), { held: false, muted: true });
});

test('turning push-to-talk off returns to an open microphone', () => {
    // The other reported bug: switching it off left you muted, hunting for the unmute
    // button after every settings visit.
    assert.deepEqual(onPushToTalkChange({ turnedOn: false }), { held: false, muted: false });
});

test('turning push-to-talk off while deafened stays silent', () => {
    assert.deepEqual(onPushToTalkChange({ turnedOn: false, deafened: true }),
        { held: false, muted: true });
});

test('the mute button is unclickable exactly while push-to-talk owns the stream', () => {
    assert.equal(muteButtonDisabled({ pushToTalk: true }), true);
    assert.equal(muteButtonDisabled({ pushToTalk: false }), false);
    assert.equal(muteButtonDisabled({}), false);
});
