// The signalling connection.
//
// The whole point of this module is what it does when things go wrong, so that is what is
// tested: a dead-but-open socket, a server asking us to slow down, a token that is no
// longer valid, and an outage long enough that a naive client would either spin or leak.
//
// Everything runs on an injected clock and an injected WebSocket, so there is no waiting
// and no flake.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLink, LINK, CLIENT_PROTOCOL } from '../src/net/link.js';

/** A WebSocket the test drives by hand. */
class FakeSocket {
    static last = null;
    static opened = 0;

    constructor(url) {
        this.url = url;
        this.readyState = 0;          // CONNECTING
        this.sent = [];
        this.closedWith = null;
        FakeSocket.last = this;
        FakeSocket.opened += 1;
    }

    send(data) { this.sent.push(JSON.parse(data)); }

    close(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.closedWith = { code, reason };
        this.onclose?.({ code, reason });
    }

    /* — things the far end does — */
    accept() { this.readyState = 1; this.onopen?.(); }
    deliver(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    dropByServer(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }

    get types() { return this.sent.map((m) => m.type); }
    lastOf(type) { return [...this.sent].reverse().find((m) => m.type === type); }
}

/** A clock the test advances, running any timer that has come due. */
function fakeClock() {
    let t = 100_000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
        clearTimer: (id) => timers.delete(id),
        /** Advance, firing due timers in time order. */
        advance(ms) {
            const until = t + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, v]) => v.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, timer] = due;
                timers.delete(id);
                t = timer.at;
                timer.fn();
            }
            t = until;
        },
        get pending() { return timers.size; },
    };
}

function harness({ origin = 'weave.example.com', token = 'tok', channelId = null, random = () => 1 } = {}) {
    FakeSocket.last = null;
    FakeSocket.opened = 0;

    const clock = fakeClock();
    const states = [];
    const events = [];

    const link = createLink({
        origin,
        token,
        channelId,
        WebSocketImpl: FakeSocket,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random,
        onState: (s) => states.push(s),
        onEvent: (e) => events.push(e),
    });

    /** Take a link all the way to LIVE. */
    const goLive = (channel = { id: 'great-hall', name: 'The Great Hall' }) => {
        link.connect();
        FakeSocket.last.accept();
        FakeSocket.last.deliver({ type: 'hello', cid: 'CID1' });
        FakeSocket.last.deliver({ type: 'joined', channel, self: {}, peers: [] });
    };

    return { link, clock, states, events, goLive, get sock() { return FakeSocket.last; }, FakeSocket };
}

test('the socket URL is derived, never typed', () => {
    const h = harness({ origin: 'weave.example.com' });
    h.link.connect();
    assert.equal(h.sock.url, 'wss://weave.example.com/ws');

    // A private address stays on plain ws, matching how its origin was resolved.
    const lan = harness({ origin: '192.168.0.50:3002' });
    lan.link.connect();
    assert.equal(lan.sock.url, 'ws://192.168.0.50:3002/ws');
});

test('the server speaks first; we do not join until it has', () => {
    const h = harness();
    h.link.connect();
    h.sock.accept();
    // Joining on open would race the correlation id we want to quote in every log line.
    assert.deepEqual(h.sock.types, []);

    h.sock.deliver({ type: 'hello', cid: 'CID1' });
    assert.deepEqual(h.sock.types, ['join']);

    const join = h.sock.lastOf('join');
    assert.equal(join.token, 'tok');
    assert.deepEqual(join.protocol, { min: CLIENT_PROTOCOL.MIN, max: CLIENT_PROTOCOL.MAX });
    assert.equal(h.link.cid, 'CID1');
});

test('a successful join reports live and remembers the room', () => {
    const h = harness();
    h.goLive();
    assert.equal(h.link.state, LINK.LIVE);
    assert.equal(h.link.channelId, 'great-hall');
    assert.ok(h.states.some((s) => s.state === LINK.LIVE));
});

test('the heartbeat runs on our schedule, inside the server timeout', () => {
    // The server terminates a socket after 70s of silence. Two pings must fit inside that,
    // because the server giving up and us noticing are different events.
    const h = harness();
    h.goLive();
    assert.deepEqual(h.sock.types.filter((t) => t === 'ping'), []);

    h.clock.advance(25_000);
    assert.equal(h.sock.types.filter((t) => t === 'ping').length, 1);
    assert.ok(25_000 * 2 < 70_000, 'two heartbeats must fit inside the server window');

    h.sock.deliver({ type: 'pong', t: h.sock.lastOf('ping').t });
    assert.equal(h.link.state, LINK.LIVE);
});

test('a round trip is measured from our own timestamp', () => {
    const h = harness();
    h.goLive();
    h.clock.advance(25_000);
    const sentAt = h.sock.lastOf('ping').t;
    h.clock.advance(40);
    h.sock.deliver({ type: 'pong', t: sentAt });
    assert.equal(h.link.rttMs, 40);
});

test('one missed heartbeat degrades; two closes a socket that still claims to be open', () => {
    // This is the half-open socket. Through a tunnel it looks identical to a healthy one:
    // frames go out, nothing errors, and readyState stays OPEN forever.
    const h = harness();
    h.goLive();

    h.clock.advance(25_000);                 // ping 1, unanswered
    assert.equal(h.link.state, LINK.LIVE);

    h.clock.advance(25_000);                 // ping 2, still unanswered
    assert.equal(h.link.state, LINK.DEGRADED, 'say so before acting on it');
    assert.equal(h.sock.readyState, 1, 'the socket still claims to be fine');

    h.clock.advance(25_000);                 // the third beat gives up
    assert.equal(h.FakeSocket.last.closedWith?.code, 4001);
});

test('a pong after a degraded beat brings it back without reconnecting', () => {
    const h = harness();
    h.goLive();
    const openedBefore = h.FakeSocket.opened;

    h.clock.advance(50_000);
    assert.equal(h.link.state, LINK.DEGRADED);

    h.sock.deliver({ type: 'pong', t: h.sock.lastOf('ping').t });
    assert.equal(h.link.state, LINK.LIVE);
    assert.equal(h.FakeSocket.opened, openedBefore, 'no reconnect was needed');
});

test('reconnect backs off instead of spinning', () => {
    // The production client once rebuilt its media path 51 times in 18 minutes. A tight
    // retry loop against a struggling server is indistinguishable from an attack.
    const h = harness({ random: () => 1 });   // no jitter, so the ceiling is observable
    h.goLive();

    const delays = [];
    const originalPush = h.states.push.bind(h.states);
    h.states.push = (s) => { if (s.retryInMs != null) delays.push(s.retryInMs); return originalPush(s); };

    for (let i = 0; i < 6; i++) {
        h.sock.dropByServer();
        h.clock.advance(60_000);
        h.sock.accept();
        h.sock.deliver({ type: 'hello', cid: 'C' });
        // Never completes the join, so the ladder keeps climbing.
        h.sock.dropByServer();
        h.clock.advance(60_000);
    }

    assert.ok(delays.length >= 4, 'each failure schedules a retry');
    for (let i = 1; i < delays.length; i++) {
        assert.ok(delays[i] >= delays[i - 1], `delay ${i} (${delays[i]}) must not shrink`);
    }
    assert.ok(Math.max(...delays) <= 30_000, 'and it is capped, not unbounded');
});

test('jitter spreads clients out rather than syncing them', () => {
    // Partial jitter still leaves every client retrying in the same narrow window, which is
    // the thundering herd the backoff exists to prevent.
    const seen = new Set();
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const h = harness({ random: () => r });
        h.goLive();
        h.sock.dropByServer();
        seen.add(h.states.filter((s) => s.retryInMs != null).pop().retryInMs);
    }
    assert.ok(seen.size >= 4, `expected a spread of delays, got ${[...seen]}`);
    assert.ok(seen.has(0), 'full jitter can retry immediately');
});

test('a successful join resets the ladder', () => {
    const h = harness({ random: () => 1 });
    h.goLive();

    h.sock.dropByServer();
    const first = h.states.filter((s) => s.retryInMs != null).pop().retryInMs;
    h.clock.advance(60_000);
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C' });
    h.sock.deliver({ type: 'joined', channel: { id: 'great-hall' } });
    assert.equal(h.link.state, LINK.LIVE);

    h.sock.dropByServer();
    const afterSuccess = h.states.filter((s) => s.retryInMs != null).pop().retryInMs;
    assert.equal(afterSuccess, first, 'a reconnect that worked must not leave the ladder raised');
});

test('a reconnect returns to the room you were in', () => {
    // Otherwise a blip silently moves you to the default channel, and the first you know is
    // that nobody can hear you.
    const h = harness();
    h.goLive({ id: 'great-hall', name: 'The Great Hall' });
    h.link.noteChannel('the-library');

    h.sock.dropByServer();
    h.clock.advance(60_000);
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C2' });

    assert.equal(h.sock.lastOf('join').channelId, 'the-library');
});

test('a rate limit is not retried immediately, because that is what caused it', () => {
    const h = harness({ random: () => 1 });
    h.goLive();
    h.sock.deliver({ type: 'error', code: 'rate_limited', message: 'Too many messages.' });
    h.sock.close(1008, 'rate limited');

    const delay = h.states.filter((s) => s.retryInMs != null).pop().retryInMs;
    assert.ok(delay >= 20_000, `expected a punitive delay, got ${delay}`);
});

test('a rejected token stops trying and says why', () => {
    const h = harness();
    h.link.connect();
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C' });
    h.sock.deliver({ type: 'error', code: 'unauthenticated', message: 'Your session has expired.' });

    assert.equal(h.link.state, LINK.FAILED);
    assert.equal(h.link.failure.code, 'unauthenticated');
    assert.match(h.link.failure.message, /expired/);

    // And it stays stopped. Retrying a dead token forever is noise for both sides.
    const opened = h.FakeSocket.opened;
    h.clock.advance(600_000);
    assert.equal(h.FakeSocket.opened, opened);
});

test('an incompatible protocol is terminal and keeps the detail', () => {
    const h = harness();
    h.link.connect();
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C' });
    h.sock.deliver({
        type: 'error', code: 'protocol_mismatch',
        message: 'This app is too old for this server.',
        detail: { serverMin: 9, serverMax: 9 },
    });

    assert.equal(h.link.state, LINK.FAILED);
    assert.deepEqual(h.link.failure.detail, { serverMin: 9, serverMax: 9 });
    // The app needs the message to show it, so it is passed up as well as recorded.
    assert.ok(h.events.some((e) => e.code === 'protocol_mismatch'));
});

test('application messages are passed up untouched', () => {
    const h = harness();
    h.goLive();
    h.sock.deliver({ type: 'peer_joined', peer: { username: 'kestrel' } });
    const peer = h.events.find((e) => e.type === 'peer_joined');
    assert.equal(peer.peer.username, 'kestrel');

    // Transport frames are handled here and not passed on as application events.
    assert.ok(!h.events.some((e) => e.type === 'pong'));
    assert.ok(!h.events.some((e) => e.type === 'hello'));
});

test('a malformed frame costs one frame, not the connection', () => {
    const h = harness();
    h.goLive();
    h.sock.onmessage({ data: 'not json at all' });
    assert.equal(h.link.state, LINK.LIVE);
    h.sock.deliver({ type: 'peer_joined', peer: { username: 'a' } });
    assert.ok(h.events.some((e) => e.type === 'peer_joined'));
});

test('sends during an outage are held, then delivered in order', () => {
    const h = harness();
    h.goLive();
    h.sock.dropByServer();

    assert.equal(h.link.send('setMute', { muted: true }), false, 'held, not sent');
    h.link.send('move', { channelId: 'lobby' });
    assert.equal(h.link.queued, 2);

    h.clock.advance(60_000);
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C' });
    h.sock.deliver({ type: 'joined', channel: { id: 'lobby' } });

    assert.deepEqual(h.sock.types, ['join', 'setMute', 'move']);
    assert.equal(h.link.queued, 0);
});

test('the queue is bounded, and drops the oldest', () => {
    // Unbounded, a long outage becomes a memory leak and then a burst on reconnect — which
    // is the fastest possible way to be rate limited the moment you come back.
    const h = harness();
    h.goLive();
    h.sock.dropByServer();

    for (let i = 0; i < 100; i++) h.link.send('typing', { n: i });
    assert.equal(h.link.queued, 32);

    h.clock.advance(60_000);
    h.sock.accept();
    h.sock.deliver({ type: 'hello', cid: 'C' });
    h.sock.deliver({ type: 'joined', channel: { id: 'x' } });

    const typings = h.sock.sent.filter((m) => m.type === 'typing');
    assert.equal(typings.length, 32);
    assert.equal(typings.at(-1).n, 99, 'the newest intent survives');
    assert.equal(typings[0].n, 68, 'the oldest is what gets dropped');
});

test('closing is deliberate, and stays closed', () => {
    const h = harness();
    h.goLive();
    h.link.close();

    // 4000 tells the server this was intentional, so it announces the departure at once
    // rather than holding it open through the reconnect grace window.
    assert.equal(h.sock.closedWith.code, 4000);
    assert.equal(h.link.state, LINK.CLOSED);

    const opened = h.FakeSocket.opened;
    h.clock.advance(600_000);
    assert.equal(h.FakeSocket.opened, opened, 'a deliberate close must not reconnect');
    assert.equal(h.link.send('anything', {}), false);
});

test('closing while retrying cancels the pending attempt', () => {
    const h = harness();
    h.goLive();
    h.sock.dropByServer();
    assert.equal(h.link.state, LINK.RETRYING);

    h.link.close();
    const opened = h.FakeSocket.opened;
    h.clock.advance(600_000);
    assert.equal(h.FakeSocket.opened, opened);
    assert.equal(h.clock.pending, 0, 'and leaves no timer running');
});

test('an administrator close ends the link with the reason, and never reconnects', () => {
    // 4003 = password reset, 4004 = banned/removed, 4005 = server wiped. Each is a
    // deliberate act by a person; retrying would turn it into a mystery spinner.
    for (const [code, expect] of [
        [4003, 'password_reset'],
        [4004, 'access_revoked'],
        [4005, 'server_wiped'],
    ]) {
        const h = harness();
        h.goLive();
        h.sock.dropByServer(code);

        assert.equal(h.link.state, LINK.FAILED, `code ${code} is fatal`);
        const last = h.states.at(-1);
        assert.equal(last.failure?.code, expect);
        assert.ok(last.failure?.message, 'carries a sentence the person can read');

        const opened = h.FakeSocket.opened;
        h.clock.advance(600_000);
        assert.equal(h.FakeSocket.opened, opened, `code ${code} must not reconnect`);
    }
});
