// The stream reporter's attribution logic, tested against synthetic getStats() rows.
//
// The point of these tests is the distinctions the reporter exists to draw — freezing WITH
// loss (the link) versus freezing WITHOUT loss (the decoder), an encoder short of CPU versus
// an uplink short of bandwidth. Each of those is a separate branch of classify(), and a test
// that only proved "it returns a verdict" would let the two most important branches collapse
// into each other unnoticed. So every verdict is pinned, and the near-miss that must NOT
// trigger it is pinned alongside.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    pickSend, pickRecv, rate, classify, buildStreamSample, pickRender,
    RTT_HIGH_S,
} from '../src/media/stream-report.js';

/* ── extraction ──────────────────────────────────────────────────────────── */

test('pickSend pulls the encoder, the source and the far-end report together', () => {
    const s = pickSend([
        { type: 'outbound-rtp', kind: 'video', framesPerSecond: 22, frameWidth: 1920, frameHeight: 1080,
          bytesSent: 500000, framesEncoded: 660, totalEncodeTime: 9.9, qualityLimitationReason: 'cpu',
          targetBitrate: 4_000_000, pliCount: 3, timestamp: 10_000 },
        { type: 'media-source', kind: 'video', framesPerSecond: 30, width: 1920, height: 1080 },
        { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.042, fractionLost: 0.01, packetsLost: 12, jitter: 0.03 },
    ]);
    assert.equal(s.encodeFps, 22);
    assert.equal(s.captureFps, 30, 'source cadence is separate from what the encoder emits');
    assert.equal(s.qualityLimitationReason, 'cpu');
    assert.equal(s.targetBitrateKbps, 4000, 'bps reported as kb/s');
    assert.equal(s.remoteRttMs, 42, 'the far end\'s RTT, in ms');
    assert.equal(s.pliCount, 3);
});

test('pickRecv keeps the loss and the decode fields distinct', () => {
    const r = pickRecv([
        { type: 'inbound-rtp', kind: 'video', framesPerSecond: 18, framesDecoded: 540, framesDropped: 30,
          freezeCount: 4, totalFreezesDuration: 6.2, packetsLost: 200, packetsReceived: 9000,
          totalDecodeTime: 8.1, jitter: 0.05, timestamp: 10_000 },
    ]);
    assert.equal(r.freezeCount, 4);
    assert.equal(r.totalFreezesDuration, 6.2);
    assert.equal(r.framesDropped, 30);
    assert.equal(r.packetsLost, 200);
    assert.equal(pickRecv([]), null, 'no inbound video row means nothing to report');
});

/* ── rates ───────────────────────────────────────────────────────────────── */

test('rate() turns cumulative totals into per-second deltas', () => {
    const prev = { at: 9000, bytesSent: 400000, framesEncoded: 630, totalEncodeTime: 9.0, pliCount: 2 };
    const cur = { at: 10000, bytesSent: 500000, framesEncoded: 660, totalEncodeTime: 9.9, pliCount: 3 };
    const r = rate(prev, cur);
    assert.equal(r.seconds, 1);
    assert.equal(r.bitrateKbps, 800, '100 KB in one second is 800 kb/s');
    assert.equal(r.encodeMsPerFrame, 30, '0.9s over 30 frames is 30 ms each — over budget');
    assert.equal(r.plisGained, 1);
});

test('rate() refuses to divide by a clock that did not move', () => {
    const a = { at: 10000, bytesReceived: 1 };
    assert.equal(rate(null, a), null, 'the first sample has nothing to diff');
    assert.equal(rate(a, a), null, 'zero elapsed time is not a rate');
});

test('rate() separates freezes, drops and loss on the receive side', () => {
    const prev = { at: 9000, bytesReceived: 200000, framesDecoded: 500, framesDropped: 10,
        freezeCount: 1, totalFreezesDuration: 1.0, packetsLost: 100, totalDecodeTime: 5.0 };
    const cur = { at: 10000, bytesReceived: 250000, framesDecoded: 520, framesDropped: 40,
        freezeCount: 3, totalFreezesDuration: 3.5, packetsLost: 100, totalDecodeTime: 5.5 };
    const r = rate(prev, cur);
    assert.equal(r.freezesGained, 2);
    assert.equal(r.freezeSecondsGained, 2.5);
    assert.equal(r.framesDroppedGained, 30);
    assert.equal(r.packetsLostGained, 0, 'no new loss even as frames were dropped — the decode-not-link case');
    assert.equal(r.decodeMsPerFrame, 25);
});

/* ── streamer verdicts ─────────────────────────────────────────────────────── */

test('an encoder short of CPU is the streamer\'s machine', () => {
    const { verdict, reasons } = classify({
        role: 'streamer',
        send: { qualityLimitationReason: 'cpu', targetBitrateKbps: 4000 },
        transport: { rttMs: 20, availableOutgoingKbps: 20000 },
        rates: { encodeMsPerFrame: 35 },
    });
    assert.equal(verdict, 'streamer-encoder-cpu');
    assert.match(reasons[0], /CPU/);
});

test('an uplink under the target bitrate is the streamer\'s connection', () => {
    const { verdict } = classify({
        role: 'streamer',
        send: { qualityLimitationReason: 'bandwidth', targetBitrateKbps: 4000 },
        transport: { rttMs: 20, availableOutgoingKbps: 1500 },
        rates: { encodeMsPerFrame: 8 },
    });
    assert.equal(verdict, 'streamer-uplink');
});

test('a starved uplink is caught even when the engine names no reason', () => {
    // availableOutgoing far under target is bandwidth trouble whether or not the encoder
    // labelled it — some engines leave qualityLimitationReason 'none' under mild starvation.
    const { verdict } = classify({
        role: 'streamer',
        send: { qualityLimitationReason: 'none', targetBitrateKbps: 4000 },
        transport: { rttMs: 20, availableOutgoingKbps: 2000 },
        rates: { encodeMsPerFrame: 8 },
    });
    assert.equal(verdict, 'streamer-uplink');
});

test('a clean streamer with a long round-trip is named as latency, not fault', () => {
    const { verdict } = classify({
        role: 'streamer',
        send: { qualityLimitationReason: 'none', targetBitrateKbps: 4000 },
        transport: { rttMs: Math.round(RTT_HIGH_S * 1000) + 50, availableOutgoingKbps: 20000 },
        rates: { encodeMsPerFrame: 8 },
    });
    assert.equal(verdict, 'streamer-latency');
});

test('a healthy streamer side says so plainly', () => {
    const { verdict } = classify({
        role: 'streamer',
        send: { qualityLimitationReason: 'none', targetBitrateKbps: 4000 },
        transport: { rttMs: 25, availableOutgoingKbps: 20000, protocol: 'udp', localType: 'srflx' },
        rates: { encodeMsPerFrame: 7 },
    });
    assert.equal(verdict, 'streamer-clean');
});

/* ── viewer verdicts: the distinction that matters most ─────────────────────── */

test('freezing WITH packet loss is the viewer\'s downlink', () => {
    const { verdict, reasons } = classify({
        role: 'viewer',
        recv: {},
        transport: { rttMs: 30 },
        rates: { freezesGained: 2, packetsLostGained: 40, decodeMsPerFrame: 6 },
    });
    assert.equal(verdict, 'viewer-downlink');
    assert.match(reasons[0], /packet loss/);
});

test('freezing WITHOUT loss is the viewer\'s decoder, not the link', () => {
    // Same visible symptom — freezes and dropped frames — but packets arrived intact and the
    // decode is slow. Collapsing this into the downlink verdict would send someone chasing a
    // network problem that is really a tired GPU. This is the test that keeps them apart.
    const { verdict, reasons } = classify({
        role: 'viewer',
        recv: {},
        transport: { rttMs: 30 },
        rates: { freezesGained: 2, framesDroppedGained: 20, packetsLostGained: 0, decodeMsPerFrame: 40 },
    });
    assert.equal(verdict, 'viewer-decode');
    assert.match(reasons[0], /decode/);
});

test('a clean viewer says so, and a distant one is latency', () => {
    assert.equal(classify({
        role: 'viewer', recv: {}, transport: { rttMs: 25 },
        rates: { freezesGained: 0, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 5 },
    }).verdict, 'viewer-clean');

    assert.equal(classify({
        role: 'viewer', recv: {}, transport: { rttMs: Math.round(RTT_HIGH_S * 1000) + 80 },
        rates: { freezesGained: 0, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 5 },
    }).verdict, 'viewer-latency');
});

/* ── the Pi ────────────────────────────────────────────────────────────────── */

test('freezing with a clean link and a fast decoder points upstream, not at the viewer', () => {
    // The third viewer case, and the subtle one: no loss, decoder keeping up, yet the picture
    // freezes. The frames were not delivered — so blaming the viewer's machine would be wrong.
    const { verdict, reasons } = classify({
        role: 'viewer', recv: {}, transport: { rttMs: 25 },
        rates: { freezesGained: 2, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 5 },
    });
    assert.equal(verdict, 'upstream-or-pi');
    assert.match(reasons[0], /not the viewer/);
});

test('a hot Pi is only blamed when the endpoint is clean or starved AND its load was stamped', () => {
    const cleanViewer = {
        role: 'viewer', recv: {}, transport: { rttMs: 20 },
        rates: { freezesGained: 0, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 5 },
    };
    // Clean endpoint but no server stamp: cannot reach a Pi verdict from the client alone.
    assert.equal(classify(cleanViewer).verdict, 'viewer-clean');

    // Clean endpoint, hot media core: now the single-worker server is the story.
    assert.equal(classify({ ...cleanViewer, pi: { mediaCorePct: 98 } }).verdict, 'pi-overloaded');

    // Clean endpoint, cool Pi: leave the healthy verdict alone.
    assert.equal(classify({ ...cleanViewer, pi: { mediaCorePct: 20, loadPerCore: 0.3 } }).verdict, 'viewer-clean');

    // The upstream-or-pi case with a hot Pi resolves to the Pi — the frames a clean viewer
    // never received were stuck behind the busy worker.
    const starved = {
        role: 'viewer', recv: {}, transport: { rttMs: 20 },
        rates: { freezesGained: 3, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 5 },
    };
    assert.equal(classify({ ...starved, pi: { eventLoopLagMs: 250 } }).verdict, 'pi-overloaded');
    assert.equal(classify(starved).verdict, 'upstream-or-pi', 'without the stamp it stays honestly upstream');
});

test('a hot Pi does NOT override a real endpoint fault', () => {
    // If the viewer's downlink is plainly dropping packets, that is the answer even if the Pi
    // is also busy — otherwise a busy server would mask every real network problem.
    const { verdict } = classify({
        role: 'viewer', recv: {}, transport: { rttMs: 20 },
        rates: { freezesGained: 3, packetsLostGained: 50 },
        pi: { mediaCorePct: 99 },
    });
    assert.equal(verdict, 'viewer-downlink');
});

/* ── assembly ────────────────────────────────────────────────────────────────── */

test('buildStreamSample wires the right picker to the role and diffs against prev', () => {
    const sendStats = [
        { type: 'outbound-rtp', kind: 'video', bytesSent: 500000, framesEncoded: 660,
          totalEncodeTime: 9.9, timestamp: 10_000, qualityLimitationReason: 'cpu', targetBitrate: 4_000_000 },
        { type: 'media-source', kind: 'video', framesPerSecond: 30 },
    ];
    const prev = pickSend([
        { type: 'outbound-rtp', kind: 'video', bytesSent: 400000, framesEncoded: 630,
          totalEncodeTime: 9.0, timestamp: 9_000 },
    ]);
    const sample = buildStreamSample({ role: 'streamer', sendStats, prev });
    assert.equal(sample.role, 'streamer');
    assert.equal(sample.recv, null, 'a streamer sample carries no receive side');
    assert.equal(sample.rates.bitrateKbps, 800);
    assert.equal(sample.rates.encodeMsPerFrame, 30);
});

/* ── render / fullscreen ─────────────────────────────────────────────────── */

test('dropped RENDERED frames with a clean link are the viewer\'s GPU, not the stream', () => {
    // The fullscreen case, and the whole reason render is captured separately: packets and
    // decode are fine, but the display cannot paint a small decode blown up to a big screen.
    // getStats alone would call this clean and miss it entirely.
    const { verdict, reasons } = classify({
        role: 'viewer', recv: {}, transport: { rttMs: 25 },
        rates: { freezesGained: 0, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 3 },
        render: { fullscreen: true, upscale: 4 },
        renderRates: { droppedPerSec: 12, droppedPct: 30 },
    });
    assert.equal(verdict, 'viewer-render');
    assert.match(reasons[0], /fullscreen/);
});

test('render drops do NOT mask real packet loss', () => {
    // A struggling GPU must never hide a dropping link — the link is the answer when both fail.
    const { verdict } = classify({
        role: 'viewer', recv: {}, transport: { rttMs: 25 },
        rates: { freezesGained: 2, packetsLostGained: 30 },
        render: { fullscreen: true }, renderRates: { droppedPerSec: 20, droppedPct: 40 },
    });
    assert.equal(verdict, 'viewer-downlink');
});

test('a few render drops are tolerated — a healthy viewer stays clean', () => {
    const { verdict } = classify({
        role: 'viewer', recv: {}, transport: { rttMs: 25 },
        rates: { freezesGained: 0, packetsLostGained: 0, framesDroppedGained: 0, decodeMsPerFrame: 3 },
        render: { fullscreen: false }, renderRates: { droppedPerSec: 0.2, droppedPct: 1 },
    });
    assert.equal(verdict, 'viewer-clean');
});

test('buildStreamSample carries render, and renderRate diffs painted vs dropped', () => {
    const prevRender = pickRender({ at: 9000, fullscreen: true, displayWidth: 3840, displayHeight: 2160, videoWidth: 1280, videoHeight: 720, totalVideoFrames: 300, droppedVideoFrames: 10 });
    const s = buildStreamSample({
        role: 'viewer',
        recvStats: [{ type: 'inbound-rtp', kind: 'video', timestamp: 10_000, framesDecoded: 60, bytesReceived: 1 }],
        renderStats: { at: 10_000, fullscreen: true, displayWidth: 3840, displayHeight: 2160, videoWidth: 1280, videoHeight: 720, totalVideoFrames: 360, droppedVideoFrames: 40 },
        prevRender,
    });
    assert.equal(s.render.fullscreen, true);
    assert.equal(s.render.upscale, 9, '3840x2160 over 1280x720 is 9x the pixels');
    assert.equal(s.renderRates.droppedPerSec, 30, '30 dropped in one second');
    assert.equal(s.renderRates.droppedPct, 50, '30 of 60 new frames dropped');
});
