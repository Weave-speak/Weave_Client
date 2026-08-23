// One field has to accept everything a person might reasonably type into it. These are the
// things people actually type, and the rules that decide what each one means.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseAddress, displayAddress, AddressError } from '../src/server/address.js';

test('a bare public hostname defaults to https', () => {
    const a = normaliseAddress('weave.example.com');
    assert.equal(a.origin, 'https://weave.example.com');
    assert.equal(a.socket, 'wss://weave.example.com');
    assert.equal(a.secure, true);
    assert.equal(a.private, false);
});

test('an explicit scheme always wins, including a downgrade', () => {
    // Typing http:// is how someone insists. Overriding it would make the field a liar.
    assert.equal(normaliseAddress('http://weave.example.com').origin, 'http://weave.example.com');
    assert.equal(normaliseAddress('https://weave.local').origin, 'https://weave.local');
});

test('private addresses default to http, because https would simply fail there', () => {
    for (const host of [
        'localhost:3002',
        '127.0.0.1:3002',
        '192.168.0.50:3002',
        '10.1.2.3',
        '172.16.4.5',
        'weave.local',
        'pi.home.arpa',
    ]) {
        const a = normaliseAddress(host);
        assert.equal(a.secure, false, `${host} should not default to https`);
        assert.equal(a.private, true, `${host} should be recognised as private`);
        assert.ok(a.socket.startsWith('ws://'), `${host} socket should be ws://`);
    }
});

test('a public host that merely looks close to a private range is not downgraded', () => {
    // 172.32 is outside 172.16-172.31, and 11.x is not private at all. Getting this wrong
    // would silently send a public server's traffic over plain HTTP.
    for (const host of ['172.32.0.1', '11.0.0.1', '193.168.0.1', 'notlocalhost.com']) {
        assert.equal(normaliseAddress(host).secure, true, `${host} should default to https`);
    }
});

test('wss:// and ws:// are accepted and converted to their HTTP origin', () => {
    // People paste these out of documentation. It is one layer down, not wrong.
    assert.equal(normaliseAddress('wss://weave.example.com').origin, 'https://weave.example.com');
    assert.equal(normaliseAddress('ws://192.168.0.50:3002').origin, 'http://192.168.0.50:3002');
});

test('a pasted URL keeps its origin and discards the path', () => {
    const a = normaliseAddress('https://weave.example.com/admin/users?tab=1#x');
    assert.equal(a.origin, 'https://weave.example.com');
});

test('a non-default port survives; a default one does not appear twice', () => {
    assert.equal(normaliseAddress('weave.example.com:8443').origin, 'https://weave.example.com:8443');
    assert.equal(normaliseAddress('https://weave.example.com:443').origin, 'https://weave.example.com');
});

test('surrounding whitespace is forgiven', () => {
    assert.equal(normaliseAddress('  weave.example.com \n').origin, 'https://weave.example.com');
});

test('empty and unusable input raise AddressError, not a generic crash', () => {
    // The UI renders `err.message` straight to the user, so these must read as sentences.
    for (const bad of ['', '   ', null, undefined]) {
        assert.throws(() => normaliseAddress(bad), AddressError);
    }
    assert.throws(() => normaliseAddress('ftp://weave.example.com'), AddressError);
    assert.throws(() => normaliseAddress('http://'), AddressError);
});

test('display strips the scheme and a default port but keeps a real one', () => {
    assert.equal(displayAddress('https://weave.example.com'), 'weave.example.com');
    assert.equal(displayAddress('https://weave.example.com:443'), 'weave.example.com');
    assert.equal(displayAddress('http://192.168.0.50:3002'), '192.168.0.50:3002');
    // Never throws: it is called while rendering, on whatever is in storage.
    assert.equal(displayAddress('nonsense'), 'nonsense');
});
