// Which network path a transport's media is actually taking.
//
// The server offers TCP on the media port as a fallback for networks that block UDP, and
// an ICE restart after a blip can land there, so when a call starts sounding wrong the first
// question is which path it is on. Voice writes the answer to the app log whenever it
// changes. Pure, so it is tested against synthetic getStats() rows without a call.
//
// This used to live in the stream-quality reporter, which is gone; the path is the one part
// of it that was never about rating a stream.

/** A number, or null — never NaN, undefined, or a string. */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Rows from whatever getStats returned: an RTCStatsReport (a Map) from the browser, an array
 * from the tests, or anything else iterable of `{ type, … }`.
 */
function rowsOf(stats) {
    if (!stats) return [];
    if (typeof stats.values === 'function') return [...stats.values()];
    if (Array.isArray(stats)) return stats;
    return [...stats];
}

/**
 * The selected ICE candidate pair, and the path it describes — or null when no pair has
 * succeeded yet.
 *
 * Candidate types and protocol only, never an address: the result goes into a log file that
 * gets attached to bug reports, and "udp host→host" answers the question without putting
 * anybody's IP on disk.
 */
export function pickTransport(stats) {
    const rows = rowsOf(stats);
    // 'succeeded' + nominated is the pair actually carrying media; some engines only mark
    // one as selected, so fall back to the first succeeded pair rather than reporting none.
    const pair = rows.find((r) => r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded')
        ?? rows.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded')
        ?? null;
    if (!pair) return null;

    const local = rows.find((r) => r.id === pair.localCandidateId) ?? null;
    const remote = rows.find((r) => r.id === pair.remoteCandidateId) ?? null;
    return {
        rttMs: pair.currentRoundTripTime != null ? Math.round(num(pair.currentRoundTripTime) * 1000) : null,
        localType: local?.candidateType ?? null,
        remoteType: remote?.candidateType ?? null,
        protocol: local?.protocol ?? remote?.protocol ?? null,
    };
}
