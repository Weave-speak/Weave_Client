// Mention autocomplete: the pure parts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mentionQuery, matchMentions, insertMention } from '../src/room/mentions.js';

const person = (username, extra = {}) => ({ id: `u-${username}`, username, displayName: username, presence: 'offline', roomId: null, ...extra });

test('an @ at the start of a word opens a query', () => {
    assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
    assert.deepEqual(mentionQuery('hello @ch', 9), { start: 6, query: 'ch' });
});

test('an @ inside a word is an email, not a mention', () => {
    assert.equal(mentionQuery('einstein@exa', 12), null);
});

test('a finished word withdraws the offer', () => {
    assert.equal(mentionQuery('@chris hello', 12), null, 'whitespace after the token ends it');
    assert.equal(mentionQuery('no at sign', 10), null);
});

test('the caret position decides which token is live', () => {
    // Caret back inside an earlier token reopens THAT token.
    assert.deepEqual(mentionQuery('@chr hello', 4), { start: 0, query: 'chr' });
});

test('prefix matches outrank substring matches', () => {
    const people = [person('christoph'), person('mitch')];   // both contain "ch"
    const got = matchMentions('ch', people).map((p) => p.username);
    assert.deepEqual(got, ['christoph', 'mitch']);
});

test('people in this room come first, then online, then the rest', () => {
    const people = [
        person('anna', { presence: 'offline' }),
        person('anne', { presence: 'live', roomId: 'other' }),
        person('annette', { presence: 'live', roomId: 'here' }),
    ];
    const got = matchMentions('ann', people, { roomId: 'here' }).map((p) => p.username);
    assert.deepEqual(got, ['annette', 'anne', 'anna']);
});

test('an empty query offers everyone, still usefully ordered', () => {
    const people = [person('zed', { roomId: 'here' }), person('abe')];
    const got = matchMentions('', people, { roomId: 'here' }).map((p) => p.username);
    assert.deepEqual(got, ['zed', 'abe'], 'same room beats alphabetical');
});

test('you are not offered yourself, and the list is capped', () => {
    const people = Array.from({ length: 10 }, (_, i) => person(`user${i}`));
    const got = matchMentions('user', people, { exclude: 'user3', limit: 6 });
    assert.equal(got.length, 6);
    assert.ok(!got.some((p) => p.username === 'user3'));
});

test('display names match too', () => {
    const people = [{ id: 'u1', username: 'gb', displayName: 'Ghostbyte', presence: 'live', roomId: null }];
    assert.equal(matchMentions('ghost', people).length, 1);
});

test('inserting replaces the token and lands the caret after a space', () => {
    const { text, caret } = insertMention('hey @chr, hi', 4, 8, 'chris');
    assert.equal(text, 'hey @chris , hi');
    assert.equal(caret, 'hey @chris '.length);
});

test('inserting into a bare @ works from a standing start', () => {
    const { text, caret } = insertMention('@', 0, 1, 'chris');
    assert.equal(text, '@chris ');
    assert.equal(caret, 7);
});
