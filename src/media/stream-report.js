// Turning a pile of getStats() rows into an answer to one question: when a screen share
// looks bad, WHOSE fault is it — the streamer's encoder, the streamer's uplink, the
// network in the middle (the Pi), or the viewer's downlink or decoder?
//
// This is the pure half of the stream reporter. It takes the raw stat rows a browser hands
// back from RTCPeerConnection.getStats() and reduces them to a small, named summary, then
// classifies that summary into a verdict. No timers, no network, no producers — so every
// branch of the attribution logic can be tested against synthetic stats without a call.
//
// Why a verdict at all, rather than just shipping the numbers: the numbers already ship
// (see `pickSend`/`pickRecv`), but a person staring at grainy video does not want a stats
// dump, they want "your machine cannot encode this fast enough" or "his connection is
// dropping packets". The classifier is a first opinion the raw samples can always overrule.
//
// mediasoup shape note: each client has ONE send peer-connection and ONE receive
// peer-connection. So a streamer reads its send stats (outbound-rtp for the screen), and a
// viewer reads its receive stats (inbound-rtp for that screen). Nobody sees both halves of
// one leg locally — which is the whole reason each side reports separately and the two are
// compared server-side.

/** A round-trip time above this (seconds) is latency worth naming — distance, not codec. */
export const RTT_HIGH_S = 0.15;

/** Send-side: available outgoing estimate this far under target is an uplink that cannot keep up. */
export const UPLINK_STARVED_RATIO = 0.8;

/** Encode/decode time per frame (ms) above which the machine, not the link, is the limit. */
export const FRAME_TIME_HIGH_MS = 20;

/** A number, or null — never NaN, undefined, or a string, so the JSON is clean and the maths safe. */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * The first row of a type that matches, as a plain iterator over whatever getStats returned.
 *
 * Accepts an RTCStatsReport (a Map), an array of rows, or anything iterable of `{type,...}`,
 * because the tests pass arrays and the browser passes a Map and neither should have to know
 * about the other.
 */
function rowsOf(stats) {
    if (!stats) return [];
    if (typeof stats.values === 'function') return [...stats.values()];
    if (Array.isArray(stats)) return stats;
    return [...stats];
}

const find = (stats, pred) => rowsOf(stats).find(pred) ?? null;

/**
 * The selected ICE candidate pair, and the path it describes.
 *
 * `currentRoundTripTime` is the latency of the leg to the Pi; the candidate types and
 * protocol are how we tell a direct UDP path from a TCP fallback or a relay — a share that
 * freezes only over TCP is a firewall story, not an encoder one, and this is where that
 * shows.
 */
function pickTransport(stats) {
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
        availableOutgoingKbps: pair.availableOutgoingBitrate != null ? Math.round(num(pair.availableOutgoingBitrate) / 1000) : null,
        availableIncomingKbps: pair.availableIncomingBitrate != null ? Math.round(num(pair.availableIncomingBitrate) / 1000) : null,
        // The path, not the address: candidate type and protocol answer "how" without
        // putting anyone's IP in a report that gets written to disk.
        localType: local?.candidateType ?? null,
        remoteType: remote?.candidateType ?? null,
        protocol: (local?.protocol ?? remote?.protocol ?? null),
        relayProtocol: local?.relayProtocol ?? null,
    };
}

/**
 * The streamer's side of one video producer: what the encoder is doing, and what the far
 * end reported back about receiving it.
 *
 * `qualityLimitationReason` is the single most useful field here — it is the encoder saying,
 * in its own words, whether it is short of CPU or short of bandwidth. `media-source` is the
 * capture rate BEFORE any encoder decision, so comparing it to the outbound framerate shows
 * frames being dropped at the encoder rather than at the source.
 */
export function pickSend(stats) {
    const out = find(stats, (r) => r.type === 'outbound-rtp' && r.kind === 'video');
    const source = find(stats, (r) => r.type === 'media-source' && r.kind === 'video');
    // The receiver's report of our stream, carried back over RTCP: loss and RTT as the
    // OTHER end experienced them, which is the closest a streamer gets to seeing the viewer.
    const remote = find(stats, (r) => r.type === 'remote-inbound-rtp' && r.kind === 'video');
    if (!out && !source) return null;

    return {
        at: num(out?.timestamp) ?? num(source?.timestamp),
        encodeFps: num(out?.framesPerSecond),
        captureFps: num(source?.framesPerSecond),
        width: num(out?.frameWidth),
        height: num(out?.frameHeight),
        sourceWidth: num(source?.width),
        sourceHeight: num(source?.height),
        // Cumulative counters; rates come from diffing two samples in `rate()`.
        bytesSent: num(out?.bytesSent),
        framesEncoded: num(out?.framesEncoded),
        framesSent: num(out?.framesSent),
        keyFramesEncoded: num(out?.keyFramesEncoded),
        totalEncodeTime: num(out?.totalEncodeTime),
        qualityLimitationReason: out?.qualityLimitationReason ?? null,
        qualityLimitationDurations: out?.qualityLimitationDurations ?? null,
        targetBitrateKbps: out?.targetBitrate != null ? Math.round(num(out.targetBitrate) / 1000) : null,
        // Feedback the far end sent asking for help: nacks are retransmit requests, plis/firs
        // are "I lost the picture, send a keyframe" — a rising pli count IS the freeze.
        nackCount: num(out?.nackCount),
        pliCount: num(out?.pliCount),
        firCount: num(out?.firCount),
        retransmittedPackets: num(out?.retransmittedPacketsSent),
        remoteRttMs: remote?.roundTripTime != null ? Math.round(num(remote.roundTripTime) * 1000) : null,
        remoteFractionLost: num(remote?.fractionLost),
        remotePacketsLost: num(remote?.packetsLost),
        remoteJitter: num(remote?.jitter),
    };
}

/**
 * The viewer's side of one video consumer: what actually reached the screen, and whether it
 * was the network or the machine that spoiled it.
 *
 * `freezeCount`/`totalFreezesDuration` are the freezes the user literally sees. The
 * distinction the report exists to draw lives in two fields read together: `packetsLost`
 * rising WITH freezes is the link; `framesDropped`/`totalDecodeTime` rising while packets
 * arrive cleanly is the decoder — his machine, not his connection.
 */
export function pickRecv(stats) {
    const inb = find(stats, (r) => r.type === 'inbound-rtp' && r.kind === 'video');
    if (!inb) return null;

    return {
        at: num(inb.timestamp),
        decodeFps: num(inb.framesPerSecond),
        width: num(inb.frameWidth),
        height: num(inb.frameHeight),
        bytesReceived: num(inb.bytesReceived),
        framesReceived: num(inb.framesReceived),
        framesDecoded: num(inb.framesDecoded),
        framesDropped: num(inb.framesDropped),
        keyFramesDecoded: num(inb.keyFramesDecoded),
        freezeCount: num(inb.freezeCount),
        totalFreezesDuration: num(inb.totalFreezesDuration),
        pauseCount: num(inb.pauseCount),
        totalDecodeTime: num(inb.totalDecodeTime),
        totalInterFrameDelay: num(inb.totalInterFrameDelay),
        jitter: num(inb.jitter),
        jitterBufferDelay: num(inb.jitterBufferDelay),
        jitterBufferEmittedCount: num(inb.jitterBufferEmittedCount),
        packetsLost: num(inb.packetsLost),
        packetsReceived: num(inb.packetsReceived),
        nackCount: num(inb.nackCount),
        pliCount: num(inb.pliCount),
        firCount: num(inb.firCount),
    };
}

/**
 * Per-second rates between two samples of the SAME side.
 *
 * getStats gives cumulative totals; a freeze is a jump in the total, and only the difference
 * between two moments says how fast it happened. Timestamps are milliseconds, so the divisor
 * is seconds. Returns null when there is no earlier sample or the clock did not advance —
 * the first sample of a share has nothing to diff against and must not divide by zero.
 */
export function rate(prev, cur) {
    if (!prev || !cur) return null;
    const dt = (num(cur.at) - num(prev.at)) / 1000;
    if (!(dt > 0)) return null;
    const per = (a, b) => (a != null && b != null ? (a - b) / dt : null);
    const r = { seconds: Math.round(dt * 1000) / 1000 };

    if (cur.bytesSent != null) {
        r.bitrateKbps = per(cur.bytesSent, prev.bytesSent) != null ? Math.round(per(cur.bytesSent, prev.bytesSent) * 8 / 1000) : null;
        // Encode time is seconds of CPU; over dt seconds of wall clock, ms spent per frame
        // encoded is the honest "is the encoder keeping up" number.
        const frames = per(cur.framesEncoded, prev.framesEncoded);
        const encodeS = per(cur.totalEncodeTime, prev.totalEncodeTime);
        r.encodeMsPerFrame = frames && frames > 0 && encodeS != null ? Math.round((encodeS / frames) * 1000) : null;
        r.plisGained = per(cur.pliCount, prev.pliCount);
    }
    if (cur.bytesReceived != null) {
        r.bitrateKbps = per(cur.bytesReceived, prev.bytesReceived) != null ? Math.round(per(cur.bytesReceived, prev.bytesReceived) * 8 / 1000) : null;
        r.freezesGained = per(cur.freezeCount, prev.freezeCount);
        r.freezeSecondsGained = per(cur.totalFreezesDuration, prev.totalFreezesDuration);
        r.framesDroppedGained = per(cur.framesDropped, prev.framesDropped);
        r.packetsLostGained = per(cur.packetsLost, prev.packetsLost);
        const frames = per(cur.framesDecoded, prev.framesDecoded);
        const decodeS = per(cur.totalDecodeTime, prev.totalDecodeTime);
        r.decodeMsPerFrame = frames && frames > 0 && decodeS != null ? Math.round((decodeS / frames) * 1000) : null;
    }
    return r;
}

/**
 * The viewer's RENDER pipeline, which lives on the <video> element — NOT in getStats().
 *
 * getStats knows what was decoded; it does not know what the GPU managed to PAINT, and those
 * are different numbers the moment a stream is upscaled. A 720p decode filling a 4K fullscreen
 * display is all render cost and no decode cost — which is exactly the "fine until I went
 * fullscreen" report. getVideoPlaybackQuality() is where dropped RENDERED frames surface, and
 * the fullscreen flag and the upscale ratio are the context that explains them.
 */
export function pickRender(raw) {
    if (!raw) return null;
    const dispW = num(raw.displayWidth); const dispH = num(raw.displayHeight);
    const vidW = num(raw.videoWidth); const vidH = num(raw.videoHeight);
    return {
        at: num(raw.at),
        fullscreen: Boolean(raw.fullscreen),
        displayWidth: dispW,
        displayHeight: dispH,
        videoWidth: vidW,
        videoHeight: vidH,
        // How much bigger the picture is drawn than it was encoded. Above 1 is upscaling,
        // which is where fullscreen render cost comes from.
        upscale: (vidW && vidH && dispW && dispH) ? Math.round(((dispW * dispH) / (vidW * vidH)) * 100) / 100 : null,
        totalRenderedFrames: num(raw.totalVideoFrames),
        droppedRenderedFrames: num(raw.droppedVideoFrames),
    };
}

/** Per-second render deltas between two samples: how many frames the display failed to paint. */
export function renderRate(prev, cur) {
    if (!prev || !cur) return null;
    const dt = (num(cur.at) - num(prev.at)) / 1000;
    if (!(dt > 0)) return null;
    const per = (a, b) => (a != null && b != null ? (a - b) / dt : null);
    const dropPS = per(cur.droppedRenderedFrames, prev.droppedRenderedFrames);
    const totPS = per(cur.totalRenderedFrames, prev.totalRenderedFrames);
    return {
        seconds: Math.round(dt * 1000) / 1000,
        droppedPerSec: dropPS != null ? Math.round(dropPS * 10) / 10 : null,
        renderedFps: (totPS != null && dropPS != null) ? Math.round(totPS - dropPS)
            : (totPS != null ? Math.round(totPS) : null),
        // Of the frames handled this window, the share the display could not paint.
        droppedPct: (totPS != null && dropPS != null && totPS > 0) ? Math.round((dropPS / totPS) * 100) : null,
    };
}

/**
 * The first opinion: given a picked side, its transport, its rate deltas, and (optionally)
 * the Pi's own load stamped in server-side, name the most likely culprit.
 *
 * Ordered by how specific the evidence is: the encoder's own limitation reason and the
 * viewer's loss-vs-decode split are stronger signals than a bare RTT, so they are checked
 * first. `pi` is only reachable when the server has stamped the report — a client cannot see
 * the media worker's CPU — so a Pi verdict is only ever offered when that stamp is present.
 */
export function classify({ role, send = null, recv = null, transport = null, rates = null, render = null, renderRates = null, pi = null } = {}) {
    const reasons = [];
    let verdict = 'inconclusive';

    if (role === 'streamer' && send) {
        const encodeMs = rates?.encodeMsPerFrame ?? null;
        const starved = send.targetBitrateKbps != null && transport?.availableOutgoingKbps != null
            && transport.availableOutgoingKbps < send.targetBitrateKbps * UPLINK_STARVED_RATIO;

        if (send.qualityLimitationReason === 'cpu' || (encodeMs != null && encodeMs > FRAME_TIME_HIGH_MS)) {
            verdict = 'streamer-encoder-cpu';
            reasons.push(`encoder is CPU-limited${encodeMs != null ? ` (${encodeMs} ms/frame)` : ''} — the streamer's machine cannot encode this fast enough`);
        } else if (send.qualityLimitationReason === 'bandwidth' || starved) {
            verdict = 'streamer-uplink';
            reasons.push(`uplink is the limit${transport?.availableOutgoingKbps != null ? ` (~${transport.availableOutgoingKbps} kb/s available vs ${send.targetBitrateKbps} target)` : ''} — the streamer's connection cannot carry the chosen bitrate`);
        } else if (transport?.rttMs != null && transport.rttMs > RTT_HIGH_S * 1000) {
            verdict = 'streamer-latency';
            reasons.push(`high round-trip to the server (${transport.rttMs} ms) — distance or a congested uplink`);
        } else if (transport?.protocol === 'tcp' || transport?.localType === 'relay' || transport?.remoteType === 'relay') {
            verdict = 'streamer-path';
            reasons.push(`media is taking a fallback path (${transport.protocol ?? transport.localType}) — head-of-line blocking there looks like freezing`);
        } else {
            verdict = 'streamer-clean';
            reasons.push('the streamer side looks healthy — encoder keeping up, uplink adequate');
        }
    }

    if (role === 'viewer' && recv) {
        const lossy = (rates?.packetsLostGained ?? 0) > 0.5;
        const freezing = (rates?.freezesGained ?? 0) > 0 || (rates?.freezeSecondsGained ?? 0) > 0.05;
        const dropping = (rates?.framesDroppedGained ?? 0) > 1;
        const badPicture = freezing || dropping;
        const decodeSlow = (rates?.decodeMsPerFrame ?? null) != null && rates.decodeMsPerFrame > FRAME_TIME_HIGH_MS;
        // Frames the DISPLAY failed to paint — distinct from decode/network drops. A few is
        // normal; a steady stream of them, especially upscaled to fullscreen, is the GPU, and
        // it is invisible to every getStats number above it. This is the fullscreen case.
        const renderDropped = (renderRates?.droppedPerSec ?? 0) > 1 || (renderRates?.droppedPct ?? 0) >= 5;

        if (badPicture && lossy) {
            verdict = 'viewer-downlink';
            reasons.push(`freezing with packet loss (${Math.round(rates.packetsLostGained)} pkt/s) — the viewer's connection is dropping data`);
        } else if (renderDropped && !lossy) {
            verdict = 'viewer-render';
            reasons.push(`the display is dropping ${renderRates?.droppedPerSec ?? '?'} rendered frame(s)/s${render?.fullscreen ? ` in fullscreen (upscaled ${render.upscale ?? '?'}×)` : ''} while packets arrive cleanly — the viewer's GPU/render, not the link, the decoder, or the stream`);
        } else if (badPicture && decodeSlow) {
            verdict = 'viewer-decode';
            reasons.push(`dropping frames while packets arrive cleanly (${rates.decodeMsPerFrame} ms/frame to decode) — the viewer's machine cannot decode this fast enough`);
        } else if (badPicture) {
            // Frozen or dropping, yet packets arrived intact and the decoder is fast. The
            // frames were not there to show — a sender or server story, not the viewer's. Say
            // exactly that, and leave the verdict open to the Pi stamp below, since a hot
            // single media worker is one thing that starves a clean viewer of frames.
            verdict = 'upstream-or-pi';
            reasons.push('freezing though the link is clean and the decoder is keeping up — frames are not arriving, so look at the sender or the server, not the viewer');
        } else if (transport?.rttMs != null && transport.rttMs > RTT_HIGH_S * 1000) {
            verdict = 'viewer-latency';
            reasons.push(`high round-trip to the server (${transport.rttMs} ms) — distance or a congested downlink`);
        } else {
            verdict = 'viewer-clean';
            reasons.push('the viewer side looks healthy — arriving and decoding without loss or freezes');
        }
    }

    // The Pi enters only when both endpoints look clean yet something is still wrong, and
    // only when its load was actually stamped in. A hot media core with clean legs is the
    // one signature that points at the single-worker server rather than at either peer.
    if (pi && (verdict === 'streamer-clean' || verdict === 'viewer-clean' || verdict === 'upstream-or-pi')) {
        const hot = (pi.mediaCorePct != null && pi.mediaCorePct > 85)
            || (pi.loadPerCore != null && pi.loadPerCore > 0.9)
            || (pi.eventLoopLagMs != null && pi.eventLoopLagMs > 100);
        if (hot) {
            verdict = 'pi-overloaded';
            reasons.push(`endpoints look clean but the server is hot (${[
                pi.mediaCorePct != null ? `media core ${pi.mediaCorePct}%` : null,
                pi.loadPerCore != null ? `load/core ${pi.loadPerCore}` : null,
                pi.eventLoopLagMs != null ? `event-loop lag ${pi.eventLoopLagMs} ms` : null,
            ].filter(Boolean).join(', ')}) — the single media worker is the bottleneck`);
        }
    }

    return { verdict, reasons };
}

/**
 * Assemble one full report from already-fetched stats. Pure: the caller does the awaiting of
 * getStats() and the reading of settings, this turns the results into the object that gets
 * posted. `prev` is the previous sample's picked side, for the rate deltas.
 */
export function buildStreamSample({
    role, sendStats = null, recvStats = null, transportStats = null, renderStats = null,
    prev = null, prevRender = null,
} = {}) {
    const send = role === 'streamer' ? pickSend(sendStats) : null;
    const recv = role === 'viewer' ? pickRecv(recvStats) : null;
    const transport = pickTransport(transportStats);
    const render = role === 'viewer' ? pickRender(renderStats) : null;
    const rates = rate(prev, role === 'streamer' ? send : recv);
    const renderRates = renderRate(prevRender, render);
    return { role, send, recv, render, transport, rates, renderRates };
}
