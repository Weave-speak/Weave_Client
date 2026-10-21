// Slash commands: which lines are commands, the offer while typing one, and the lines
// they leave in the timeline.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCommand, commandQuery, matchCommands, completeCommand, resultItem, refusalItem, COMMAND_REFUSALS,
} from '../src/room/commands.js';
import { messageList } from '../src/room/views/timeline.js';

const COMMANDS = [
    { name: 'roll', usage: '/roll [sides]', describe: 'Roll a die. Defaults to 100.' },
    { name: 'flip', usage: '/flip', describe: 'Flip a coin.' },
];

test('a known command is parsed with its arguments', () => {
    assert.deepEqual(parseCommand('/roll 20', COMMANDS), { command: 'roll', args: ['20'] });
    assert.deepEqual(parseCommand('/flip', COMMANDS), { command: 'flip', args: [] });
    assert.deepEqual(parseCommand('  /ROLL   6  ', COMMANDS), { command: 'roll', args: ['6'] },
        'surrounding space and case are forgiven');
});

test('anything the server did not advertise is a message, not a command', () => {
    // "/shrug" on a server without one, a pasted path, a fraction: all sent as text.
    assert.equal(parseCommand('/shrug', COMMANDS), null);
    assert.equal(parseCommand('/usr/bin/env', COMMANDS), null);
    assert.equal(parseCommand('1/2 a pizza', COMMANDS), null);
    assert.equal(parseCommand('/', COMMANDS), null);
    assert.equal(parseCommand('/roll 20', []), null, 'no list, no commands');
});

test('a doubled slash is the way to say a command name as text', () => {
    assert.equal(parseCommand('//roll', COMMANDS), null);
});

test('arguments are capped where the server caps them', () => {
    assert.equal(parseCommand('/roll a b c d e f', COMMANDS).args.length, 4);
});

test('the offer appears only while the name itself is being typed', () => {
    assert.deepEqual(commandQuery('/ro', 3), { query: 'ro' });
    assert.deepEqual(commandQuery('/', 1), { query: '' });
    assert.equal(commandQuery('/roll 2', 7), null, 'arguments are typed in peace');
    assert.equal(commandQuery('hi /roll', 8), null, 'only at the start of the line');
    assert.equal(commandQuery('//ro', 4), null);
});

test('matching is by prefix, and a name typed in full offers nothing', () => {
    assert.deepEqual(matchCommands('', COMMANDS).map((c) => c.name), ['roll', 'flip']);
    assert.deepEqual(matchCommands('r', COMMANDS).map((c) => c.name), ['roll']);
    // Otherwise Enter after "/flip" would complete it to itself instead of sending it.
    assert.deepEqual(matchCommands('flip', COMMANDS), []);
    assert.deepEqual(matchCommands('zzz', COMMANDS), []);
});

test('completing replaces the partial name and leaves room for arguments', () => {
    assert.deepEqual(completeCommand('/ro', 3, 'roll'), { text: '/roll ', caret: 6 });
    assert.deepEqual(completeCommand('/r 20', 2, 'roll'), { text: '/roll 20', caret: 6 });
});

test('a result is a line about the person, not a message from them', () => {
    const item = resultItem({
        command: 'roll', by: { cid: 'c1', username: 'kestrel', displayName: 'Kestrel' },
        text: 'rolled 42 (1–100)', at: 1000,
    });
    assert.equal(item.kind, 'system');
    assert.equal(item.who, 'Kestrel');
    assert.equal(item.text, 'rolled 42 (1–100)');
    assert.equal(item.icon, 'dice');

    const markup = messageList([{ ...item, at: '10:00' }]);
    assert.match(markup, /class="msg-system"/);
    assert.doesNotMatch(markup, /msg-author/, 'it must not look like they typed it');
});

test('a result is escaped like anything else the server relays', () => {
    const item = resultItem({
        command: 'roll', by: { cid: 'c1', username: '<b>x</b>' }, text: '<img src=x>', at: 1,
    });
    const markup = messageList([{ ...item, at: '00:00' }]);
    assert.doesNotMatch(markup, /<img src=x>/);
    assert.doesNotMatch(markup, /<b>x<\/b>/);
});

test('a refusal is local, and the codes that mean one are known', () => {
    const item = refusalItem('Usage: /roll [sides]', 5);
    assert.equal(item.local, true);
    assert.equal(item.text, 'Usage: /roll [sides]');
    assert.ok(COMMAND_REFUSALS.has('bad_usage'));
    assert.ok(COMMAND_REFUSALS.has('unknown_command'));
    assert.ok(!COMMAND_REFUSALS.has('rate_limited'), 'a refusal of everything is not about the command');
});
