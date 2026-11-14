// The ICE path voice writes to the app log: which candidate pair is carrying media.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickTransport } from '../src/media/ice-path.js';

const local = { id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.5' };
const remote = { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '203.0.113.9' };

test('the nominated, succeeded pair names the path and its round trip', () => {
    const path = pickTransport([
        local, remote,
        { type: 'candidate-pair', state: 'succeeded', nominated: true,
            localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.0234 },
    ]);
    assert.deepEqual(path, { rttMs: 23, localType: 'host', remoteType: 'host', protocol: 'udp' });
});

test('no address ever comes out, because this is written to a log that gets shared', () => {
    const path = pickTransport([
        local, remote,
        { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
    ]);
    assert.ok(!JSON.stringify(path).includes('192.168'));
    assert.ok(!JSON.stringify(path).includes('203.0.113'));
});

test('an engine that marks no pair nominated still reports the succeeded one', () => {
    const path = pickTransport([
        { ...local, protocol: 'tcp' }, remote,
        { type: 'candidate-pair', state: 'in-progress', localCandidateId: 'L', remoteCandidateId: 'R' },
        { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    ]);
    assert.equal(path.protocol, 'tcp', 'the TCP fallback is exactly what this exists to show');
    assert.equal(path.rttMs, null);
});

test('nothing connected yet is null, and a Map is read like an array', () => {
    assert.equal(pickTransport(null), null);
    assert.equal(pickTransport([{ type: 'candidate-pair', state: 'failed' }]), null);

    const asMap = new Map([
        ['L', local], ['R', remote],
        ['P', { type: 'candidate-pair', state: 'succeeded', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
    ]);
    assert.equal(pickTransport(asMap).localType, 'host');
});
