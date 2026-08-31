// The signalling connection.
//
// One WebSocket to one server, kept alive and put back together when it breaks. Everything
// above this — rooms, messages, voice — assumes a link that either works or says clearly
// that it does not.
//
// Four behaviours here are not negotiable, and each exists because of a specific failure:
//
//  1. RECONNECT BACKS OFF, WITH JITTER. The production client once rebuilt its media path
//     51 times in 18 minutes because a retry counter was shared between two failure modes
//     and never reset. A tight loop against a struggling server is indistinguishable from
//     an attack, and it is how one broken client takes a server down for everyone.
//
//  2. THE HEARTBEAT IS OURS. Browsers never surface protocol ping/pong to JavaScript, so a
//     half-open socket through a tunnel looks exactly like a healthy one — traffic goes
//     out, nothing comes back, and nothing errors. The only way to know is to ask and time
//     the answer. Missing two in a row means the link is gone regardless of what the
//     readyState claims.
//
//  3. SOME FAILURES MUST NOT BE RETRIED. A rejected token, an incompatible protocol and a
//     rate limit are all permanent until something changes. Retrying them is pure noise:
//     it will not succeed, and it makes a rate limit worse by definition.
//
//  4. THE STATE IS REPORTED HONESTLY. "Connected" while nothing is arriving is the status
//     users learn to distrust, and once they do, every status is useless.

import { normaliseAddress } from '../server/address.js';

/** What the link is doing, in the words the connection pill uses. */
export const LINK = Object.freeze({
    IDLE: 'idle',
    CONNECTING: 'connecting',
    LIVE: 'live',
    DEGRADED: 'degraded',   // still open, but the last heartbeat went unanswered
    RETRYING: 'retrying',
    CLOSED: 'closed',       // deliberate; will not come back on its own
    FAILED: 'failed',       // needs a person: bad token, wrong protocol, rate limited
});

/** The protocol range this client speaks. Must match the vendored server contract. */
export const CLIENT_PROTOCOL = Object.freeze({ MIN: 1, MAX: 1 });

/**
 * Heartbeat, chosen against the server's 70s silence timeout.
 *
 * 25s gives two full chances to be heard before the server gives up on us, which matters
 * because the server terminating the socket and us noticing are different events.
 */
const PING_INTERVAL_MS = 25_000;
/** Two unanswered pings. One can be a hiccup; two in a row is a dead path. */
const PONG_GRACE = 2;

/** Backoff: gentle at first, then out of the way. Full jitter, so clients do not sync up. */
const RETRY_BASE_MS = 1_000;
const RETRY_FACTOR = 1.8;
const RETRY_CAP_MS = 30_000;

/** A rate limit means we are already sending too much. Start near the cap. */
const RATE_LIMIT_BACKOFF_MS = 20_000;

/**
 * Server error codes that no amount of retrying will fix.
 *
 * `kicked` is deliberately absent: a cooldown DOES pass. Giving up on it would leave the
 * person staring at a failure screen after the one thing that would fix it had happened.
 */
const FATAL = new Set(['protocol_mismatch', 'unauthenticated', 'no_channels', 'forbidden']);

/** Deliberate leave, so the server announces immediately instead of waiting out its grace. */
const LEAVE_CODE = 4000;

/**
 * Closes the server sends when an ADMINISTRATOR acted on this account. Reconnecting is
 * pointless — the session is already revoked — and retrying would turn a deliberate
 * kick into a mystery spinner. Each carries the sentence the person deserves to read.
 */
const ADMIN_CLOSES = new Map([
    [4003, ['password_reset', 'An administrator reset your password. Sign in with your old password to choose a new one.']],
    [4004, ['access_revoked', 'Your access to this server was revoked by an administrator.']],
    [4005, ['server_wiped', 'This server was wiped by its administrator. Nothing remains to reconnect to.']],
]);

/**
 * Kicked. Deliberately NOT one of the above.
 *
 * Those three mean the session is gone and coming back is pointless. A kick means come
 * back in a minute: the account is fine, the token still works, and the server is holding
 * a short cooldown. So this reconnects — after waiting out the cooldown the server named,
 * and standing NOWHERE, because being put straight back into the room you were removed
 * from is not what anybody meant by the word.
 */
const KICK_CLOSE = 4006;

/** If a kick arrives with no cooldown attached, wait this long rather than hammering. */
const KICK_FALLBACK_MS = 60_000;

/** Slack on a cooldown, so a second of clock skew is not a wasted refused attempt. */
const COOLDOWN_MARGIN_MS = 1500;

/**
 * How much may pile up while the link is down.
 *
 * Bounded on purpose. An unbounded queue turns a long outage into a memory leak and then
 * into a burst the moment the socket returns, which is the fastest way to be rate limited
 * the instant you reconnect.
 */
const MAX_QUEUE = 32;

export function createLink({
    origin,
    token,
    channelId = null,
    autoJoin = true,
    onEvent = () => {},
    onState = () => {},
    // Injected in tests. Nothing else about the logic changes.
    WebSocketImpl = (typeof WebSocket !== 'undefined' ? WebSocket : null),
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    random = () => Math.random(),
} = {}) {
    const socketUrl = `${normaliseAddress(origin).socket}/ws`;

    // Handlers are held in variables rather than used directly from the parameters, so they
    // can be replaced after construction. The link is created at sign-in and the room that
    // consumes its events is created afterwards; without this, assigning link.onEvent later
    // would set a property nothing reads, and every frame would vanish in silence.
    let handleEvent = onEvent;
    let handleState = onState;

    let ws = null;
    let state = LINK.IDLE;
    let attempt = 0;
    let retryTimer = null;
    let pingTimer = null;

    let outstandingPings = 0;
    let lastPingAt = 0;
    let rttMs = null;
    let cid = null;
    let wantOpen = false;
    let joined = false;
    // Standing NOWHERE is a standing too, and it must survive a reconnect: without
    // this, a network blip would rejoin a deliberately-roomless reader straight into
    // the default room. Seeded from the arrival preference, updated by noteChannel.
    let nowhere = autoJoin === false;
    let lastChannelId = channelId;
    let failure = null;
    const queue = [];

    function setState(next, detail = {}) {
        if (state === next && !detail.force) return;
        state = next;
        handleState({ state, rttMs, cid, failure, ...detail });
    }

    function raw(type, payload = {}) {
        if (ws?.readyState !== 1) return false;
        ws.send(JSON.stringify({ type, ...payload }));
        return true;
    }

    /* ── heartbeat ───────────────────────────────────────────────────────── */

    function stopHeartbeat() {
        if (pingTimer) clearTimer(pingTimer);
        pingTimer = null;
        outstandingPings = 0;
    }

    function beat() {
        if (outstandingPings >= PONG_GRACE) {
            // The socket still claims to be open. It is not: two heartbeats have gone
            // unanswered, which through a tunnel is what a dead path looks like from here.
            // Closing it ourselves is the only way to start recovering.
            setState(LINK.RETRYING, { reason: 'heartbeat' });
            try { ws?.close(4001, 'heartbeat timeout'); } catch { /* already gone */ }
            return;
        }
        lastPingAt = now();
        outstandingPings += 1;
        raw('ping', { t: lastPingAt });
        if (outstandingPings > 1) setState(LINK.DEGRADED);
        pingTimer = setTimer(beat, PING_INTERVAL_MS);
    }

    function startHeartbeat() {
        stopHeartbeat();
        pingTimer = setTimer(beat, PING_INTERVAL_MS);
    }

    /* ── retry ───────────────────────────────────────────────────────────── */

    /** Exponential with FULL jitter: a random point in [0, ceiling], not ceiling ± a bit.
     *  Partial jitter still leaves every client retrying in the same narrow window, which
     *  is exactly the thundering herd the backoff was meant to prevent. */
    function retryDelay(overrideBase) {
        const ceiling = Math.min(RETRY_CAP_MS, (overrideBase ?? RETRY_BASE_MS) * RETRY_FACTOR ** attempt);
        return Math.round(random() * ceiling);
    }

    function scheduleRetry(overrideBase) {
        if (!wantOpen) return;
        const delay = retryDelay(overrideBase);
        attempt += 1;
        setState(LINK.RETRYING, { retryInMs: delay, attempt, force: true });
        retryTimer = setTimer(() => { retryTimer = null; open(); }, delay);
    }

    /**
     * Come back when a cooldown says we may, and not before.
     *
     * Deliberately NOT scheduleRetry: that jitters between zero and its base, which is
     * right for an outage nobody can predict the end of and wrong here, where the server
     * has named the exact moment. Jittering would come back early, be refused, and turn one
     * kick into a handful of pointless attempts. The margin covers clock skew between the
     * two machines.
     */
    function scheduleAfterCooldown(ms) {
        if (!wantOpen) return;
        const delay = Math.max(1000, Math.round(ms) + COOLDOWN_MARGIN_MS);
        attempt += 1;
        setState(LINK.RETRYING, { retryInMs: delay, attempt, force: true });
        retryTimer = setTimer(() => { retryTimer = null; open(); }, delay);
    }

    /**
     * The `kicked` frame, held until onclose.
     *
     * It arrives immediately before the close, so recovery cannot read it from the close
     * event — the reason string is not structured and browsers give nothing else.
     */
    let kicked = null;

    function giveUp(code, message, detail) {
        wantOpen = false;
        failure = { code, message, detail };
        stopHeartbeat();
        setState(LINK.FAILED, { force: true });
    }

    /* ── the socket ──────────────────────────────────────────────────────── */

    function open() {
        if (!WebSocketImpl) throw new Error('No WebSocket implementation available');
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

        joined = false;
        setState(LINK.CONNECTING, { force: true });

        ws = new WebSocketImpl(socketUrl);

        ws.onopen = () => {
            // Nothing is sent yet. The server speaks first with `hello`, and joining before
            // it does would race the correlation id we want to quote in every log line.
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                // A server that sends us non-JSON is broken in a way we cannot fix by
                // reconnecting, but one bad frame is not worth dropping the link over.
                return;
            }
            handle(msg);
        };

        ws.onerror = () => {
            // Browsers deliberately give no detail here, to avoid leaking whether a host
            // exists. `onclose` always follows, and that is where recovery belongs.
        };

        ws.onclose = (event) => {
            stopHeartbeat();
            ws = null;
            joined = false;

            if (!wantOpen) {
                setState(LINK.CLOSED, { force: true });
                return;
            }
            const adminClose = ADMIN_CLOSES.get(event?.code);
            if (adminClose) {
                giveUp(adminClose[0], adminClose[1]);
                return;
            }
            if (event?.code === KICK_CLOSE) {
                const wait = kicked?.retryAfterMs ?? KICK_FALLBACK_MS;
                // Told, so the room can say what happened rather than showing a bare
                // reconnect spinner for a minute.
                handleEvent({ type: 'kicked', ...(kicked ?? {}) });
                // Standing nowhere on the way back. The room we remember is the room we
                // were removed from, and re-sending it would undo the kick.
                nowhere = true;
                kicked = null;
                scheduleAfterCooldown(wait);
                return;
            }
            // 1008 is the server's policy close, which here means the rate limiter. Coming
            // straight back is precisely what it is asking us not to do.
            scheduleRetry(event?.code === 1008 ? RATE_LIMIT_BACKOFF_MS : undefined);
        };
    }

    function handle(msg) {
        switch (msg.type) {
            case 'hello':
                cid = msg.cid ?? null;
                // The correlation id is worth having even if the join fails, so it is
                // surfaced before we try.
                handleState({ state, rttMs, cid, failure });
                raw('join', {
                    token,
                    protocol: { min: CLIENT_PROTOCOL.MIN, max: CLIENT_PROTOCOL.MAX },
                    ...(!nowhere && lastChannelId ? { channelId: lastChannelId } : {}),
                    // False means "arrive standing nowhere": signed in, reading anything,
                    // heard by no one until a room is chosen. Applied on the first join
                    // from the arrival preference, and on reconnects from wherever the
                    // session actually stood when the line dropped.
                    ...(nowhere ? { autoJoin: false } : {}),
                });
                return;

            case 'kicked':
                // Held rather than acted on: the close is already on its way, and acting
                // here would tear down a socket the server is closing anyway.
                kicked = { by: msg.by ?? null, until: msg.until ?? null, retryAfterMs: msg.retryAfterMs };
                handleEvent(msg);
                return;

            case 'joined':
                joined = true;
                attempt = 0;                      // a real success, so the ladder resets
                failure = null;
                lastChannelId = msg.channel?.id ?? lastChannelId;
                startHeartbeat();
                setState(LINK.LIVE, { force: true });
                flush();
                break;

            case 'pong':
                outstandingPings = 0;
                if (typeof msg.t === 'number') rttMs = now() - msg.t;
                if (state === LINK.DEGRADED) setState(LINK.LIVE, { force: true });
                // The room-producer truth rides the pong; surface it as its own event so
                // the room can reconcile against the SERVER's memory rather than its own.
                if (Array.isArray(msg.producers)) {
                    handleEvent({ type: 'producers_truth', producers: msg.producers });
                }
                return;

            case 'error':
                if (FATAL.has(msg.code)) {
                    giveUp(msg.code, msg.message, msg.detail);
                    handleEvent(msg);
                    return;
                }
                if (msg.code === 'kicked') {
                    kicked = { by: null, until: null, retryAfterMs: msg.detail?.retryAfterMs };
                }
                if (msg.code === 'rate_limited') {
                    // The close follows immediately; recording it here means the retry that
                    // onclose schedules starts from the punitive base rather than 1s.
                    failure = { code: msg.code, message: msg.message };
                }
                break;

            default:
                break;
        }

        // Everything else — roster changes, messages, media signalling — belongs upstairs.
        handleEvent(msg);
    }

    /** Anything queued during an outage, in order, once. */
    function flush() {
        while (queue.length && ws?.readyState === 1) raw(...queue.shift());
    }

    return {
        /** Replaceable, because the consumer is built after the link is. */
        set onEvent(fn) { handleEvent = typeof fn === 'function' ? fn : () => {}; },
        set onState(fn) { handleState = typeof fn === 'function' ? fn : () => {}; },

        get state() { return state; },
        get rttMs() { return rttMs; },
        get cid() { return cid; },
        get failure() { return failure; },
        get channelId() { return lastChannelId; },
        get queued() { return queue.length; },

        connect() {
            wantOpen = true;
            failure = null;
            attempt = 0;
            open();
        },

        /**
         * Send, or hold briefly if the link is down.
         *
         * Returns false when the message was dropped rather than sent or queued, so a
         * caller that cares can tell the difference instead of assuming it arrived.
         */
        send(type, payload = {}) {
            if (joined && raw(type, payload)) return true;
            if (state === LINK.FAILED || state === LINK.CLOSED) return false;
            if (queue.length >= MAX_QUEUE) {
                // Drop the oldest. During an outage the newest intent is the true one —
                // nobody wants a five-minute-old "I am typing" delivered on reconnect.
                queue.shift();
            }
            queue.push([type, payload]);
            return false;
        },

        /** Remember where we are, so a reconnect returns here rather than to the default. */
        noteChannel(id) {
            // null is a statement, not an omission: the session now stands nowhere.
            if (id === null) { nowhere = true; return; }
            nowhere = false;
            lastChannelId = id;
        },

        /** Deliberate. The server announces the departure at once instead of waiting. */
        close() {
            wantOpen = false;
            if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
            stopHeartbeat();
            queue.length = 0;
            try { ws?.close(LEAVE_CODE, 'leaving'); } catch { /* already gone */ }
            ws = null;
            joined = false;
            setState(LINK.CLOSED, { force: true });
        },
    };
}
