// Refused administrator verbs: the pure half.
//
// What matters is that a refusal is never silent again and that nothing else is mistaken
// for one — a server mute that "did nothing" was a refusal nobody was shown.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    pendingModeration, readModerationFrame, REFUSAL_WINDOW_MS, MODERATION_REFUSALS,
} from '../src/room/moderation-refusal.js';
import { refusalItem } from '../src/room/commands.js';

const T = 1_000_000;

test('an administrator aimed at another administrator is told so, in words', () => {
    const pending = pendingModeration('mute', 'Threshpeke', T);
    const { pending: next, refusal } = readModerationFrame(pending, {
        type: 'error', code: 'target_is_admin',
        message: 'Administrators cannot server-mute one another.',
    }, T + 200);

    assert.equal(next, null, 'answered, so nothing is left in flight');
    assert.equal(refusal.text, 'Could not server-mute Threshpeke: Administrators cannot server-mute one another.');
    assert.equal(refusal.icon, 'micOff');
});

test('every verb has its own sentence', () => {
    const refuse = (action) => readModerationFrame(pendingModeration(action, 'Kestrel', T),
        { type: 'error', code: 'forbidden', message: 'This action requires an administrator account.' },
        T + 10).refusal.text;

    assert.match(refuse('move'), /^Could not move Kestrel: /);
    assert.match(refuse('mute'), /^Could not server-mute Kestrel: /);
    assert.match(refuse('unmute'), /^Could not lift Kestrel's server mute: /);
    assert.match(refuse('kick'), /^Could not kick Kestrel: /);
});

test('a refusal with no message still says what did not happen', () => {
    const { refusal } = readModerationFrame(pendingModeration('kick', 'Kestrel', T),
        { type: 'error', code: 'internal_error' }, T + 10);
    assert.equal(refusal.text, 'Could not kick Kestrel.');
});

test('the acknowledgement settles it without a word', () => {
    for (const type of ['adminMoved', 'serverMuteChanged', 'kickedPeer']) {
        const out = readModerationFrame(pendingModeration('mute', 'Kestrel', T), { type }, T + 10);
        assert.deepEqual(out, { pending: null, refusal: null }, type);
    }
});

test('unrelated traffic leaves the verb waiting for its answer', () => {
    const pending = pendingModeration('move', 'Kestrel', T);
    const out = readModerationFrame(pending, { type: 'peer_joined', peer: {} }, T + 10);
    assert.equal(out.pending, pending);
    assert.equal(out.refusal, null);

    // An error from some other part of the protocol is not this verb's refusal.
    const other = readModerationFrame(pending, { type: 'error', code: 'bad_usage' }, T + 10);
    assert.equal(other.pending, pending);
    assert.equal(other.refusal, null);
});

test('an error long after the verb is not blamed on it', () => {
    const out = readModerationFrame(pendingModeration('mute', 'Kestrel', T),
        { type: 'error', code: 'forbidden', message: 'x' }, T + REFUSAL_WINDOW_MS + 1);
    assert.deepEqual(out, { pending: null, refusal: null });
});

test('nothing in flight means nothing to say', () => {
    const out = readModerationFrame(null, { type: 'error', code: 'forbidden', message: 'x' }, T);
    assert.deepEqual(out, { pending: null, refusal: null });
});

test('the codes the server refuses moderation with are all recognised', () => {
    for (const code of ['forbidden', 'target_is_admin', 'not_permitted', 'not_yourself',
        'no_user', 'no_peer', 'text_channel', 'not_a_member']) {
        assert.ok(MODERATION_REFUSALS.has(code), code);
    }
});

test('a tester past the edge of what a tester may do is told which edge', () => {
    const { refusal } = readModerationFrame(pendingModeration('unmute', 'Kestrel', T), {
        type: 'error', code: 'not_permitted',
        message: 'Only an administrator or whoever placed it can lift this mute.',
    }, T + 10);
    assert.equal(refusal.text,
        "Could not lift Kestrel's server mute: Only an administrator or whoever placed it can lift this mute.");
});

test('the line it becomes is local, and carries the verb\'s icon', () => {
    const item = refusalItem('Could not kick Kestrel.', T, 'power');
    assert.equal(item.kind, 'system');
    assert.equal(item.local, true);
    assert.equal(item.icon, 'power');
    // And a slash command's refusal is unchanged by the new argument.
    assert.equal(refusalItem('nope', T).icon, 'dice');
});
