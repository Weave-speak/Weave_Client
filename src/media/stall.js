// Deciding that a transport has stopped carrying media.
//
// This is separate from voice.js, and pure, because the judgement is the hard part and
// the plumbing is not. Given a stream of samples it answers one question — keep waiting,
// restart ICE, or rebuild — and that answer can be tested exhaustively under `node --test`
// without a browser, a socket or a peer connection.
//
// THREE FAILURES ARRIVE AS THE SAME SYMPTOM, and only the first is a state change:
//
//   A. The transport reaches 'disconnected' and stays there. mediasoup-client derives its
//      connection state from the peer connection's ICE state, and it can sit in
//      'disconnected' for ever without ever being promoted to 'failed'. We used to act
//      only on 'failed', and the server only told us about 'closed', so 'disconnected'
//      fell through a gap on both sides and nobody acted at all.
//
//   B. ICE reports 'connected' while media is already dead. A NAT rebinding moves the
//      client's UDP mapping; consent requests still flow outbound, so nothing fires an
//      event, but the return path is gone. NO state machine can catch this — only the
//      absence of packets can, which is why this module counts them.
//
//   C. The server's ICE consent timeout (30 s) expires and it gives up on us.
//
// The ladder is deliberate. 'restart-ice' is cheap: it repairs the path WITHOUT
// recreating producers or consumers, so no permission prompt, no lost media state, and no
// audible gap beyond the reconnection itself. A full rebuild is the fallback, not the
// first resort, which is what it used to be.

/** How long to let the browser fix 'disconnected' by itself. */
export const GRACE_MS = 7_000;

/**
 * How long a connected transport may carry no packets before we disbelieve it.
 *
 * Generous on purpose. A brief stall is normal under congestion, and a false positive
 * here costs a real reconnection — which would make this worse than doing nothing.
 */
export const STALL_MS = 8_000;

/** ICE restarts before giving up and rebuilding. Two is enough to cover a NAT rebind. */
export const MAX_ICE_RESTARTS = 2;

/** Health this long after a repair clears the restart budget. */
export const RECOVERY_MS = 30_000;

/**
 * A detector for ONE transport.
 *
 * Feed it `sample()` on a timer and whenever the connection state changes; it returns
 * 'ok', 'restart-ice' or 'rebuild'. `now` is passed in rather than read, so the tests can
 * drive time instead of waiting for it.
 *
 * `expecting` is the guard that makes packet-counting safe: a muted microphone or a peer
 * with nothing to consume legitimately sends and receives nothing, and treating that as a
 * fault would reconnect people for being quiet.
 */
export function createStallDetector({
    graceMs = GRACE_MS,
    stallMs = STALL_MS,
    maxIceRestarts = MAX_ICE_RESTARTS,
    recoveryMs = RECOVERY_MS,
} = {}) {
    let disconnectedSince = null;
    let flatSince = null;
    let lastPackets = null;
    let iceRestarts = 0;
    let healthySince = null;

    /** Escalate one rung: ICE restart while the budget lasts, then a full rebuild. */
    function escalate() {
        disconnectedSince = null;
        flatSince = null;
        healthySince = null;
        if (iceRestarts < maxIceRestarts) {
            iceRestarts += 1;
            return 'restart-ice';
        }
        return 'rebuild';
    }

    return {
        /**
         * @param {object} s
         * @param {string} s.state      transport connection state
         * @param {number} [s.packets]  a monotonic RTP counter for this direction
         * @param {boolean} [s.expecting] whether packets SHOULD be moving right now
         * @param {number} s.now
         */
        sample({ state, packets = null, expecting = false, now }) {
            // 'failed' is unambiguous and needs no grace period.
            if (state === 'failed') return escalate();

            if (state === 'disconnected') {
                // Browsers recover from a short disruption on their own, typically well
                // inside 15 s, so acting instantly would cause more churn than it cures.
                disconnectedSince ??= now;
                return now - disconnectedSince >= graceMs ? escalate() : 'ok';
            }

            // Anything that is not connected yet ('new', 'connecting') is not a fault:
            // a transport still being set up has no packets to show for itself.
            if (state !== 'connected' && state !== 'completed') {
                disconnectedSince = null;
                flatSince = null;
                lastPackets = packets;
                return 'ok';
            }

            disconnectedSince = null;

            // Fault B. The state says connected; only the counter can disagree.
            if (!expecting || packets === null) {
                flatSince = null;
                lastPackets = packets;
            } else if (lastPackets !== null && packets === lastPackets) {
                flatSince ??= now;
                if (now - flatSince >= stallMs) return escalate();
            } else {
                flatSince = null;
                lastPackets = packets;
                // Sustained health, not a single good sample, is what earns the budget
                // back. Otherwise a path that flaps would restart ICE for ever.
                healthySince ??= now;
                if (now - healthySince >= recoveryMs) iceRestarts = 0;
            }

            return 'ok';
        },

        /** After a rebuild, everything about the old path is meaningless. */
        reset() {
            disconnectedSince = null;
            flatSince = null;
            lastPackets = null;
            iceRestarts = 0;
            healthySince = null;
        },

        /** For logging: how many ICE restarts this transport has spent. */
        get restarts() { return iceRestarts; },
    };
}

/**
 * Reduce an RTCStatsReport to one number: has anything ARRIVED on this path?
 *
 * The nominated candidate pair is the right place to read, not `inbound-rtp`. A room
 * where everyone happens to be muted legitimately carries no RTP, and counting only
 * media would call that a dead path and reconnect people for being quiet. The candidate
 * pair also carries RTCP and ICE consent traffic, which a healthy path emits every few
 * seconds no matter who is talking — so a flat counter here means the path itself is
 * gone, which is exactly the question being asked.
 *
 * Counts only what was RECEIVED, never what was sent, and that asymmetry is the whole
 * point. When a NAT rebinding kills the return path we go on transmitting into the void
 * quite happily, so bytes-sent keeps climbing and a counter including it would never go
 * flat — the one fault this exists to catch would be the one it could never see. Arrival
 * is the only evidence that the far end is still reachable.
 *
 * This works in BOTH directions: the send transport's pair still receives RTCP receiver
 * reports and STUN responses from the server while the path is healthy.
 *
 * Falls back to inbound RTP when no pair reports itself nominated, because that field is
 * not filled in identically across engines and a missing field must not silently disable
 * the watchdog.
 *
 * @param {Iterable<object>|Map<string, object>} report an RTCStatsReport, or plain entries
 * @returns {number|null} a monotonic byte count, or null if the report says nothing
 */
export function readFlow(report) {
    let pair = 0;
    let rtp = 0;
    let sawPair = false;

    // An RTCStatsReport is Map-like, and iterating a Map yields [key, value] PAIRS, not
    // the stat objects. Taking .values() where it exists is the difference between this
    // reading the connection and silently returning null for ever — which would have
    // disabled the one check that catches a path dying while ICE still says 'connected'.
    const entries = report && typeof report.values === 'function' && !Array.isArray(report)
        ? report.values()
        : report ?? [];

    for (const stat of entries) {
        if (!stat) continue;
        if (stat.type === 'candidate-pair' && (stat.nominated || stat.state === 'succeeded')) {
            sawPair = true;
            pair += stat.bytesReceived ?? 0;
        } else if (stat.type === 'inbound-rtp') {
            rtp += stat.bytesReceived ?? 0;
        }
    }

    if (sawPair) return pair;
    return rtp || null;
}
