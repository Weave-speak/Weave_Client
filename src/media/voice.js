// Voice.
//
// mediasoup on the client side: one send transport carrying your microphone, one receive
// transport carrying everybody else's. The server forwards; nothing is peer to peer.
//
// Five behaviours here are carried over deliberately from the production client, each
// because of a specific failure that took real users to find:
//
//  1. MUTE DOES NOT STOP THE TRACK. It sets `track.enabled = false`, which keeps the
//     producer alive and sends silence. Stopping and restarting a track on every mute
//     churns the transport, and on some machines the second getUserMedia returns a
//     different device.
//
//  2. HEAL ON 'ended', NEVER ON 'mute'. A MediaStreamTrack fires `mute` when the OS mutes
//     the hardware — a user pressing the mute key on their headset — and `ended` when the
//     device genuinely disappears. Rebuilding on `mute` means a hardware mute key tears
//     down and rebuilds the whole media path, which is both pointless and audible.
//
//  3. RECOVERY IS CAPPED, AND ITS COUNTER IS ITS OWN. The production client once rebuilt
//     its media path 51 times in 18 minutes because this counter was shared with the
//     WebSocket reconnect counter and got reset by every successful socket open. Four
//     attempts is roughly 90 seconds; after that it stops and says so, because a client
//     that rebuilds for ever is indistinguishable from an attack on the server.
//
//  4. A STOP IS NOT A DISCONNECT. mediasoup fires producerclose on transport teardown as
//     well as on a real stop, so the server marks deliberate stops with `stopped: true`.
//     Without that distinction a "stream ended" sound plays on every network blip.
//
//  5. CONSUMERS START PAUSED AND ARE RESUMED AFTER THE TRACK IS ATTACHED. Otherwise the
//     first packets arrive before there is anywhere to put them, and the stream connects
//     but never plays.

import { Device } from 'mediasoup-client';
import { createMicChain, sensitivityToDb, gainToLinear } from './chain.js';
import { micCodecOptions, screenAudioCodecOptions } from './audio-options.js';
import { createStallDetector, readFlow } from './stall.js';

// Bundled beside the app; under weave:// and vite alike this resolves to a real URL.
const GATE_WORKLET_URL = new URL('./gate-worklet.js', import.meta.url);

/** Producer slots, matching the server's own names. */
export const SLOTS = Object.freeze({
    AUDIO: 'audio',
    SCREEN: 'screen',
    WEBCAM: 'webcam',
    SCREEN_AUDIO: 'screen-audio',
});

/**
 * Roughly 90 seconds of rebuilding, since each cycle is about a 21s ICE timeout plus the
 * reconnect. Its own counter, never shared with the socket's — see the note above.
 */
const MAX_RECOVER = 4;

/**
 * How long to wait before trying again after a recovery cycle itself fails.
 *
 * Long enough that four attempts span a real outage rather than a burst, short enough
 * that a person does not sit in silence wondering. The alternative — what used to happen
 * — was no retry at all.
 */
const RETRY_MS = 4_000;

/** How long a reply may take before we stop waiting for it. */
const REPLY_TIMEOUT_MS = 12_000;

/** How often the level meter samples. Fast enough to look live, slow enough to be free. */
const LEVEL_INTERVAL_MS = 100;

export function createVoice({
    link,
    onChange = () => {},
    onLevels = () => {},
    /**
     * Audio constraints, read fresh time the microphone is opened.
     *
     * A function rather than a value because the microphone is reopened on recovery, and a
     * preference captured once at construction would silently revert to whatever was true
     * when the room was first entered.
     */
    getAudioConstraints = () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    /** The chain settings — gain 0–200, gate on/off, sensitivity 0–100 — read fresh. */
    getChainSettings = () => ({ micGain: 100, noiseGate: false, gateSensitivity: 64 }),
    /** Gate telemetry for the settings meter: { level, db, open } ~15×/s while live. */
    onMicTelemetry = () => {},
    /** Camera constraints, read fresh per open, same reasoning as the microphone's. */
    getVideoConstraints = () => ({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }),
    /** Screen constraints: resolution/fps caps and whether to bring system audio. */
    getScreenConstraints = () => ({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true }),
    /** 'detail' keeps text readable under motion; 'motion' keeps games smooth. */
    getScreenContentHint = () => 'detail',
    /** Encoder budget for a screen share, read fresh per share so presets apply next time. */
    getScreenEncodings = () => [{ maxBitrate: 4_000_000 }],
    getVideoEncodings = () => [{ maxBitrate: 1_800_000 }],
    canRestartIce = () => false,
    /** The stage's feed: called with { cid, slot, stream } and stream null on teardown. */
    onVideo = () => {},
} = {}) {
    let device = null;
    let sendTransport = null;
    let recvTransport = null;

    let micStream = null;
    let micChain = null;
    let micProducer = null;
    let camStream = null;
    let camProducer = null;
    let camWanted = false;
    let screenStream = null;
    let screenProducer = null;
    let screenAudioProducer = null;
    let screenWanted = false;
    let muted = false;
    let recoverAttempts = 0;
    let running = false;

    // Streams the user chose to watch, as 'cid:slot'. Video is OPT-IN: availability is
    // indicated with a placeholder tile and nothing is consumed — no packets, no CPU —
    // until the person clicks Watch. A screen's system audio follows its screen's key.
    // Entries survive resyncs (so the heal consumes what is watched and only that) and
    // are erased when that producer closes or the room changes.
    const watching = new Set();

    /** The key whose watch-state governs this slot: screen-audio rides its screen. */
    const watchKey = (cid, slot) =>
        (slot === SLOTS.SCREEN_AUDIO ? `${cid}:${SLOTS.SCREEN}` : `${cid}:${slot}`);

    /** Slots governed by the watch switch; plain voice audio never is. */
    const isWatchable = (slot) =>
        slot === SLOTS.SCREEN || slot === SLOTS.WEBCAM || slot === SLOTS.SCREEN_AUDIO;

    // Consecutive sync-consume failures per cid:slot; three in a row becomes a banner.
    const consumeFails = new Map();
    // Whether the 'consume-failed' banner is the thing currently on screen, so a later
    // success knows it is safe to clear it (and knows NOT to stomp on some other status
    // — 'recovering', 'no-mic' — that came along in the meantime).
    let failureSignaled = false;

    // Previous outbound-rtp byte counter, for the bitrate the connection pill shows.
    let statSample = null;

    const consumers = new Map();   // consumerId -> { consumer, cid, slot, audio, meter }
    // Local listening preferences per `${cid}:${slot}` — YOUR ears, nobody else's
    // stream. Survives a re-consume, so a recovery does not un-mute someone you muted.
    const audioPrefs = new Map();

    // Deafened means hearing nobody. It was, until now, purely a badge: the flag went to
    // the server, muted the microphone (the server pauses the producer, so that half was
    // real) and changed an icon — while every incoming stream kept playing. Somebody
    // deafened themselves and could still hear the room, which is the one thing the
    // button promises not to happen.
    let deafened = false;

    /**
     * What one stream should sound like right now.
     *
     * Deafen beats every per-stream choice while it is on, and turning it off RESTORES
     * those choices rather than blanket-unmuting — somebody you had individually muted
     * stays muted, which is what you would expect and what a simpler implementation
     * would quietly get wrong.
     */
    function applyListen(audio, key) {
        if (!audio) return;
        const pref = audioPrefs.get(key) ?? { muted: false, volume: 1 };
        audio.muted = deafened || Boolean(pref.muted);
        audio.volume = Math.max(0, Math.min(1, pref.volume ?? 1));
    }
    const waiters = new Set();
    const levels = new Map();      // cid -> 0..1

    let audioContext = null;
    let levelTimer = null;
    let micMeter = null;

    /** Hidden host for the audio elements. They must be in the document to play. */
    let sink = null;
    function audioSink() {
        if (sink) return sink;
        sink = document.createElement('div');
        sink.id = 'weaveAudioSink';
        sink.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        document.body.append(sink);
        return sink;
    }

    /* ── correlating replies ─────────────────────────────────────────────── */

    /**
     * Wait for the next frame of a type that matches.
     *
     * The signalling protocol has no request ids, so replies are matched on the fields that
     * identify them — a transport by its direction, a consumer by whose stream it is. The
     * timeout matters: without it a dropped reply leaves a promise pending for ever and the
     * call simply never finishes connecting, with nothing in any log to say why.
     */
    function waitFor(type, match = () => true) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiters.delete(waiter);
                reject(new Error(`The server did not answer "${type}" in time.`));
            }, REPLY_TIMEOUT_MS);

            const waiter = (msg) => {
                if (msg.type === 'error') {
                    clearTimeout(timer);
                    waiters.delete(waiter);
                    reject(new Error(msg.message ?? 'The server refused that.'));
                    return true;
                }
                if (msg.type !== type || !match(msg)) return false;
                clearTimeout(timer);
                waiters.delete(waiter);
                resolve(msg);
                return true;
            };
            waiters.add(waiter);
        });
    }

    /** Offer a frame to anything waiting. Returns true if somebody took it. */
    function deliver(msg) {
        for (const waiter of [...waiters]) {
            if (waiter(msg)) return true;
        }
        return false;
    }

    /* ── transports ──────────────────────────────────────────────────────── */

    async function createTransport(direction) {
        link.send('createTransport', { direction });
        const info = await waitFor('transportCreated', (m) => m.direction === direction);

        const options = {
            id: info.id,
            iceParameters: info.iceParameters,
            iceCandidates: info.iceCandidates,
            dtlsParameters: info.dtlsParameters,
        };
        const transport = direction === 'send'
            ? device.createSendTransport(options)
            : device.createRecvTransport(options);

        transport.on('connect', ({ dtlsParameters }, done, fail) => {
            link.send('connectTransport', { direction, dtlsParameters });
            waitFor('transportConnected', (m) => m.direction === direction).then(() => done(), fail);
        });

        if (direction === 'send') {
            transport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
                link.send('produce', { slot: appData.slot, kind, rtpParameters });
                waitFor('produced', (m) => m.slot === appData.slot)
                    .then((m) => done({ id: m.id }))
                    .catch(fail);
            });
        }

        // ICE dying is how a call ends without anyone being told. The server also reports
        // it, but the client sees it first and more reliably.
        //
        // 'disconnected' is fed to the watchdog rather than acted on here. It used to be
        // ignored entirely — this handler only knew 'failed', and the server's
        // transportFailed frame was only honoured for 'closed' — so a transport that
        // landed on 'disconnected' and stayed there was handled by nobody. That is the
        // silent, one-directional dropout people were reconnecting to escape. Browsers do
        // usually fix it themselves within a few seconds, which is why the grace period
        // lives in the detector instead of becoming an instant rebuild.
        transport.on('connectionstatechange', (statev) => {
            transportState[direction] = statev;
            if (statev === 'connected') watchdog.start();
            assess(direction).catch(() => { /* the next tick tries again */ });
        });

        return transport;
    }

    // Bumped on every teardown; a transport that finishes creating under a stale epoch
    // is closed rather than adopted, so a recover() that ran WHILE an old creation was
    // still in flight can never have that old one clobber the fresh one.
    let mediaEpoch = 0;
    let sendTransportPromise = null;
    let recvTransportPromise = null;

    /**
     * The single place a send/recv transport gets created. `??=` alone is NOT safe here:
     * it checks the target variable SYNCHRONOUSLY, before the `await` — so two calls
     * arriving before the first resolves (recover()'s own ensureRecv() racing the room's
     * 15s/25s periodic voice.sync(), which happens most often right after the network
     * blip that triggered recovery in the first place) each start their OWN
     * createTransport() round trip. waitFor('transportCreated', ...) matches only on
     * `direction`, with no per-request id, so the two replies can be handed to either
     * caller — one local Transport object can end up paired with ICE/DTLS parameters
     * the server no longer associates with this peer's current transport, since the
     * server keeps exactly one transport per direction and the later create silently
     * replaces the earlier one there. Signalling all still succeeds, so nothing throws;
     * the consumer just never receives a single packet. That is exactly the shape of
     * "some audio in this room is not arriving — still retrying": the retries were
     * never going to work, because the transport itself was never really connected.
     * A single in-flight promise, shared by every concurrent caller, makes two
     * createTransport() round trips for the same direction structurally impossible.
     */
    function ensureTransport(direction) {
        const current = direction === 'send' ? sendTransport : recvTransport;
        // `current && !current.closed`, not just `current`. A closed mediasoup Transport
        // is still a perfectly truthy object, and these two variables are only nulled by
        // teardownMedia() and the mediaReset branch of onMoved(). Any other path that
        // closed a transport — a DTLS failure, the server closing its end — left the
        // corpse here, and every later ensureSend()/ensureRecv() handed it straight back.
        // Producing and consuming against it then failed for the rest of the session.
        if (current && !current.closed) return Promise.resolve(current);
        if (current) {
            if (direction === 'send') sendTransport = null; else recvTransport = null;
        }
        const already = direction === 'send' ? sendTransportPromise : recvTransportPromise;
        if (already) return already;

        const epoch = mediaEpoch;
        const promise = createTransport(direction).then((t) => {
            if (epoch !== mediaEpoch) {
                // teardownMedia() ran while this was in flight — a recover() cycle is
                // already building its own transport. Adopting this one instead would
                // reopen the exact race this function exists to close.
                try { t.close(); } catch { /* already gone */ }
                throw new Error('Voice was reset while connecting; the next attempt will pick it up.');
            }
            if (direction === 'send') sendTransport = t; else recvTransport = t;
            return t;
        }).finally(() => {
            if (direction === 'send') sendTransportPromise = null; else recvTransportPromise = null;
        });

        if (direction === 'send') sendTransportPromise = promise; else recvTransportPromise = promise;
        return promise;
    }
    const ensureSend = () => ensureTransport('send');
    const ensureRecv = () => ensureTransport('recv');

    /**
     * Bumps the epoch AND clears any creation currently in flight — not just one, both.
     * Bumping the epoch alone stops a stale creation from being ADOPTED once it settles,
     * but does nothing about a NEW caller in the meantime: without this, ensureTransport()
     * would still hand that new caller the same doomed in-flight promise (the epoch check
     * lives inside its .then(), which only runs once the round trip finishes — up to the
     * full 12s reply timeout). Called from every place that closes a transport outside
     * a fresh createTransport() call, so the next ensureSend()/ensureRecv() always starts
     * a genuinely new attempt instead of queuing behind one already guaranteed to fail.
     */
    function invalidateTransports() {
        mediaEpoch += 1;
        sendTransportPromise = null;
        recvTransportPromise = null;
    }

    /* ── the microphone ──────────────────────────────────────────────────── */

    /**
     * The one AudioContext, pinned to the rate Opus actually wants.
     *
     * A context built with no options runs at the hardware rate, so on the many machines
     * that capture at 44.1 kHz the gate's output was resampled on its way into a 48 kHz
     * encoder — for nothing. 'interactive' asks for the smallest buffer the engine will
     * give us, which is what a conversation wants and what makes the meter look live.
     *
     * Wrapped, because Safari has historically refused a sampleRate it does not natively
     * support, and a refused context must cost the meter, never the call.
     */
    function ensureAudioContext() {
        if (audioContext) return audioContext;
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        try {
            audioContext = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
        } catch {
            audioContext = new Ctor();
        }
        return audioContext;
    }

    async function openMicrophone() {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: getAudioConstraints(),
            video: false,
        });

        const [track] = micStream.getAudioTracks();

        // `ended` means the device is gone — unplugged, or taken by something else — and
        // is worth rebuilding for. `mute` means the OS silenced it, which is what a mute
        // key on a headset does, and rebuilding for that would be both pointless and
        // audible. Listening to the wrong one is a classic and very annoying bug.
        track.addEventListener('ended', () => {
            if (running) recover('microphone disappeared');
        });

        track.enabled = !muted;
        // Tells the engine this is speech, so its own processing and any codec heuristics
        // optimise for intelligibility rather than fidelity. Advisory, hence the guard.
        try { track.contentHint = 'speech'; } catch { /* advisory only */ }

        // The chain sits between the device and the producer. If it cannot build — no
        // worklet, refused context — the raw track is used and nothing else changes.
        const settings = getChainSettings();
        micChain = await createMicChain(ensureAudioContext(), micStream, {
            workletUrl: GATE_WORKLET_URL,
            gain: gainToLinear(settings.micGain),
            gateEnabled: Boolean(settings.noiseGate),
            gateThresholdDb: sensitivityToDb(settings.gateSensitivity),
            onTelemetry: onMicTelemetry,
        });
        return micChain.track;
    }

    /* ── the stall watchdog ──────────────────────────────────────────────── */
    //
    // Three faults present as the same symptom — one direction of audio silently stops
    // and the person has to reconnect. Only the first is a state change:
    //
    //   A. the transport reaches 'disconnected' and stays there (nobody used to act);
    //   B. ICE still says 'connected' while the path is dead, because a NAT rebinding
    //      moved the UDP mapping and consent requests still flow outbound;
    //   C. the server's own ICE consent timeout expires.
    //
    // So the watchdog watches BOTH the state and the bytes. Restarting ICE is the cheap
    // rung: it repairs the path with every producer and consumer left in place, where a
    // rebuild costs a DTLS handshake, new consumers and a second or two of silence.

    const WATCHDOG_MS = 2_000;
    const transportState = { send: 'new', recv: 'new' };
    const detectors = { send: createStallDetector(), recv: createStallDetector() };
    let repairInFlight = null;

    /** Is anything supposed to be moving on this transport right now? */
    function expectingFlow(direction) {
        if (direction === 'send') {
            return [micProducer, camProducer, screenProducer, screenAudioProducer]
                .some((p) => p && !p.closed);
        }
        return [...consumers.values()].some((c) => !c.consumer?.closed);
    }

    async function flowOn(direction) {
        const transport = direction === 'send' ? sendTransport : recvTransport;
        if (!transport || transport.closed) return null;
        try {
            return readFlow(await transport.getStats());
        } catch {
            // Stats are a diagnostic, never a dependency: an engine that refuses them
            // leaves the state machine running on states alone rather than breaking it.
            return null;
        }
    }

    /** Sample one transport and act on the verdict. */
    async function assess(direction) {
        if (!running || repairInFlight) return;
        const transport = direction === 'send' ? sendTransport : recvTransport;
        if (!transport || transport.closed) return;

        const verdict = detectors[direction].sample({
            state: transportState[direction],
            packets: await flowOn(direction),
            expecting: expectingFlow(direction),
            now: Date.now(),
        });
        if (verdict === 'ok') return;

        // Without server support the cheap rung does not exist, so skip straight to the
        // expensive one — which is what every client did before ICE restart was added.
        if (verdict === 'restart-ice' && canRestartIce()) {
            await repairIce(direction);
            return;
        }
        await recover(`${direction} transport stopped carrying media`);
    }

    /**
     * Ask the server for fresh ICE credentials and hand them to the transport.
     *
     * Deliberately does NOT spend a recover() attempt: this repairs the path without
     * disturbing anything riding on it, so a user reconnecting through a flaky NAT should
     * not be four ICE restarts closer to "rejoin the room to try again".
     */
    async function repairIce(direction) {
        if (repairInFlight) return repairInFlight;
        const transport = direction === 'send' ? sendTransport : recvTransport;
        if (!transport || transport.closed) return undefined;

        onChange({ state: 'recovering', reason: `restoring the ${direction} connection` });

        repairInFlight = (async () => {
            link.send('restartIce', { direction });
            const reply = await waitFor('iceRestarted', (m) => m.direction === direction);
            if (transport.closed) return;
            await transport.restartIce({ iceParameters: reply.iceParameters });
            onChange({ state: 'live', repaired: true });
        })().catch(async (err) => {
            // A server too old to know the message, or one that could not restart: the
            // rebuild is still there, and it is what used to happen every time.
            await recover(`ICE restart failed on ${direction}: ${err.message}`);
        }).finally(() => { repairInFlight = null; });

        return repairInFlight;
    }

    const watchdog = {
        timer: null,
        start() {
            if (this.timer || !running) return;
            this.timer = setInterval(() => {
                assess('send').catch(() => {});
                assess('recv').catch(() => {});
            }, WATCHDOG_MS);
            this.timer.unref?.();
        },
        stop() {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            detectors.send.reset();
            detectors.recv.reset();
            transportState.send = 'new';
            transportState.recv = 'new';
        },
    };

    /* ── recovery ────────────────────────────────────────────────────────── */

    // Whichever recovery cycle is currently rebuilding the media path, if any. A real
    // network blip typically fails the send AND recv transport's ICE within milliseconds
    // of each other — each has its OWN 'connectionstatechange' listener, so both call
    // recover() independently for what is really one physical incident. Without this
    // guard, one blip burned two attempts out of MAX_RECOVER's budget of four, and a
    // user could see the counter jump straight to "2 of 4" (or hit the terminal "could
    // not be re-established" after only two real hiccups). teardownMedia() +
    // ensureRecv() + enableMic() already rebuild BOTH transports and the mic together
    // regardless of which one's failure triggered the call, so a second trigger arriving
    // while the first is still running has nothing left to do but wait for it.
    let recoveryInFlight = null;
    let retryTimer = null;

    async function recover(reason) {
        if (!running) return;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (recoveryInFlight) return recoveryInFlight;
        recoveryInFlight = runRecovery(reason).finally(() => { recoveryInFlight = null; });
        return recoveryInFlight;
    }

    async function runRecovery(reason) {
        if (recoverAttempts >= MAX_RECOVER) {
            onChange({
                state: 'failed',
                reason,
                message: 'Voice could not be re-established. Rejoin the room to try again.',
            });
            return;
        }
        recoverAttempts += 1;
        onChange({ state: 'recovering', reason, attempt: recoverAttempts, of: MAX_RECOVER });

        teardownMedia();
        try {
            await ensureRecv();
            if (micProducerWanted) await enableMic();
            // A rebuilt recv path with no microphone wanted is a complete success for a
            // listener. Without this the counter could only ever be reset by a successful
            // produce (see enableMic), so anyone listening — mic refused, mic switched
            // off — burned all four attempts across a session's ordinary blips and then
            // met "rejoin the room to try again" for a hiccup everyone else survived.
            if (!micProducerWanted) recoverAttempts = 0;
            watchdog.start();
            onChange({ state: 'live', recovered: true });
        } catch (err) {
            onChange({ state: 'recovering', reason: err.message, attempt: recoverAttempts, of: MAX_RECOVER });
            // Re-arm. teardownMedia() has already closed both transports and with them the
            // connectionstatechange listeners that would have triggered another attempt,
            // so a cycle that failed here used to be the end of it: if ensureRecv() threw,
            // enableMic() above never ran and the microphone stayed dead for the rest of
            // the session, silently, with nothing left to notice.
            if (running && recoverAttempts < MAX_RECOVER) {
                retryTimer = setTimeout(() => { recover(`retrying after: ${err.message}`); }, RETRY_MS);
                retryTimer.unref?.();
            }
        }
    }

    let micProducerWanted = false;

    /**
     * Turn the microphone on and start sending.
     *
     * A plain function rather than only a method, because recovery calls it too. Reaching
     * it through the returned object would be a reference to something not yet in scope
     * when recovery runs, which is a failure that only appears in the one path nobody
     * exercises by hand.
     */
    async function enableMic() {
        micProducerWanted = true;
        if (!device?.loaded) throw new Error('Voice is not ready yet.');
        if (micProducer) return micProducer;

        await ensureSend();

        // Reuse the open track where there is one. After a cross-worker move the producer
        // and transports are gone but the microphone is not, and calling getUserMedia again
        // is both a needless permission round trip and a chance to be handed a different
        // device than the one already in use.
        const existing = micStream?.getAudioTracks?.().find((t) => t.readyState === 'live');
        const track = existing ?? await openMicrophone();
        micMeter ??= meterFor(micStream, 'self');

        micProducer = await sendTransport.produce({
            track,
            appData: { slot: SLOTS.AUDIO },
            codecOptions: micCodecOptions(),
        });

        // TRUST NOTHING ABOUT THE CHAIN. On at least one Chromium build, a worklet graph
        // fed by a MediaStreamSource silently never processes — the produced track is
        // pure silence while every API reports success. So: if the chain claims to be
        // processing, listen to its OUTPUT for a moment; if the raw microphone is live
        // and the chain is a flatline, swap the producer back to the raw track in place.
        if (micChain?.processed) verifyChainCarries();

        // A successful produce proves the path works end to end, so this is the only place
        // the recovery counter is allowed to reset. Resetting it on a socket reconnect
        // instead is what produced 51 rebuilds in 18 minutes.
        recoverAttempts = 0;
        watchdog.start();
        onChange({ state: 'live', talking: true });

        // The proven path is the moment to restore anything video the user still wants:
        // after a cross-worker move or a recovery the producers are gone but the TRACKS
        // survive, so this re-produces without a single new permission prompt.
        await restoreVideo().catch(() => { /* voice is up; video can be retried by hand */ });
        return micProducer;
    }

    /**
     * Prove the processed track carries audio, or stop using it.
     *
     * Compares the chain's output level against the raw device over ~700ms. Quiet raw
     * proves nothing (the person may simply not be talking), so the check re-arms on a
     * timer until the raw track is audibly live at least once.
     */
    function verifyChainCarries() {
        const chain = micChain;
        if (!chain?.processed || !micProducer) return;
        const outMeter = meterFor(new MediaStream([chain.track]), 'chain-verify');
        if (!outMeter) return;

        let rawPeak = 0;
        let outPeak = 0;
        let samples = 0;
        const timer = setInterval(() => {
            if (micChain !== chain || !micProducer) { cleanup(); return; }
            rawPeak = Math.max(rawPeak, micMeter?.read() ?? 0);
            outPeak = Math.max(outPeak, outMeter.read());
            samples += 1;
            if (samples < 7) return;

            if (rawPeak < 0.02) { rawPeak = 0; outPeak = 0; samples = 0; return; }   // nothing said yet
            cleanup();
            if (outPeak < 0.002) {
                // The graph is dead. The device track is alive and already granted —
                // swap it into the live producer; the room never hears the difference,
                // because until now it heard nothing at all.
                const [raw] = micStream?.getAudioTracks() ?? [];
                if (raw) micProducer.replaceTrack({ track: raw }).catch(() => {});
                chain.stop();
                if (micChain === chain) micChain = null;
                console.warn('[weave] mic chain produced silence on this engine; raw track restored');
            }
        }, 100);
        const cleanup = () => { clearInterval(timer); outMeter.stop(); };
    }

    /* ── producing video ─────────────────────────────────────────────────── */


    async function enableWebcam() {
        camWanted = true;
        if (!device?.loaded) throw new Error('Voice is not ready yet.');
        await ensureSend();
        if (camProducer) return camProducer;

        const existing = camStream?.getVideoTracks?.().find((t) => t.readyState === 'live');
        const track = existing ?? await (async () => {
            camStream = await navigator.mediaDevices.getUserMedia({ video: getVideoConstraints() });
            const [t] = camStream.getVideoTracks();
            // The device disappearing (unplugged, taken by another app) ends the share
            // honestly instead of freezing the last frame for everyone.
            t.addEventListener('ended', () => disableWebcamInner());
            return t;
        })();

        camProducer = await sendTransport.produce({
            track,
            appData: { slot: SLOTS.WEBCAM },
            // Simulcast for faces: three rungs the SFU picks between per viewer, sized
            // to the resolution actually being captured. A fixed ladder meant a 1080p
            // capture was squeezed into a 720p budget, so "sharper" made it softer.
            encodings: getVideoEncodings(),
            codecOptions: { videoGoogleStartBitrate: 800 },
        });
        onVideo({ cid: 'self', slot: SLOTS.WEBCAM, stream: camStream });
        onChange({ state: 'live', webcam: true });
        return camProducer;
    }

    function disableWebcamInner() {
        camWanted = false;
        if (camProducer) {
            link.send('closeProducer', { slot: SLOTS.WEBCAM });
            try { camProducer.close(); } catch { /* already closed */ }
            camProducer = null;
        }
        for (const track of camStream?.getTracks() ?? []) track.stop();
        camStream = null;
        onVideo({ cid: 'self', slot: SLOTS.WEBCAM, stream: null });
        onChange({ state: 'live', webcam: false });
    }

    /**
     * State the degradation preference instead of inheriting one.
     *
     * Chromium derives a preference from the content hint, but the derivation differs by
     * version and by whether the source is flagged as a screencast, and none of it is
     * observable from here. The user answered this question in Settings — "keep text
     * readable" or "keep motion smooth" — and that answer should reach the encoder as
     * itself rather than as a hint about a hint.
     *
     * Best effort on purpose: Firefox ignores the field, and Chromium throws
     * InvalidModificationError if the encodings array identity is disturbed. So read,
     * change one field, write back, and never let a refusal cost the share.
     */
    function applyDegradationPreference(producer, hint) {
        const sender = producer?.rtpSender;
        if (!sender?.getParameters) return;
        try {
            const params = sender.getParameters();
            params.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
            sender.setParameters(params).catch(() => { /* advisory */ });
        } catch { /* the content hint still applies */ }
    }

    async function enableScreen() {
        screenWanted = true;
        if (!device?.loaded) throw new Error('Voice is not ready yet.');
        await ensureSend();
        if (screenProducer) return screenProducer;

        const live = screenStream?.getVideoTracks?.().find((t) => t.readyState === 'live');
        if (!live) {
            // On desktop the app's own picker answers this; in a browser, the browser's.
            screenStream = await navigator.mediaDevices.getDisplayMedia(getScreenConstraints());
        }
        const [video] = screenStream.getVideoTracks();
        // 'detail' keeps text legible when the encoder has to choose; 'motion' keeps
        // frame rate. The preference is the user's, read fresh each share.
        try { video.contentHint = getScreenContentHint(); } catch { /* advisory only */ }
        video.addEventListener('ended', () => disableScreenInner());

        // The router's first video codec, which is H264 — NOT VP9. Asking for VP9 by
        // name here (0.1.41) gave every viewer a black picture: the share negotiated,
        // produced and was consumed by both peers with a clean journal, and no frame
        // ever decoded. The server still advertises VP9 and it is still the right codec
        // for screen text; what is missing is evidence that the SVC path works between
        // two real machines, and that has to come before it is asked for again.
        screenProducer = await sendTransport.produce({
            track: video,
            appData: { slot: SLOTS.SCREEN },
            encodings: getScreenEncodings(),
            codecOptions: { videoGoogleStartBitrate: 1200 },
        });

        applyDegradationPreference(screenProducer, getScreenContentHint());

        const [sysAudio] = screenStream.getAudioTracks();
        if (sysAudio) {
            // 'music' is the counterpart to the capture constraints: it tells the engine
            // not to apply the speech-shaped processing that makes shared audio pump.
            try { sysAudio.contentHint = 'music'; } catch { /* advisory only */ }
            screenAudioProducer = await sendTransport.produce({
                track: sysAudio,
                appData: { slot: SLOTS.SCREEN_AUDIO },
                codecOptions: screenAudioCodecOptions(),
            });
        }

        onVideo({ cid: 'self', slot: SLOTS.SCREEN, stream: screenStream });
        onChange({ state: 'live', screen: true, screenAudio: Boolean(sysAudio) });
        return screenProducer;
    }

    function disableScreenInner() {
        screenWanted = false;
        for (const [slot, ref] of [[SLOTS.SCREEN, screenProducer], [SLOTS.SCREEN_AUDIO, screenAudioProducer]]) {
            if (!ref) continue;
            link.send('closeProducer', { slot });
            try { ref.close(); } catch { /* already closed */ }
        }
        screenProducer = null;
        screenAudioProducer = null;
        for (const track of screenStream?.getTracks() ?? []) track.stop();
        screenStream = null;
        onVideo({ cid: 'self', slot: SLOTS.SCREEN, stream: null });
        onChange({ state: 'live', screen: false });
    }

    /** Re-produce whatever video the user still wants, on a freshly proven path. */
    async function restoreVideo() {
        if (camWanted && !camProducer && camStream?.getVideoTracks?.().some((t) => t.readyState === 'live')) {
            await enableWebcam();
        }
        if (screenWanted && !screenProducer && screenStream?.getVideoTracks?.().some((t) => t.readyState === 'live')) {
            await enableScreen();
        }
    }

    /* ── consuming ───────────────────────────────────────────────────────── */

    async function consume(cid, slot) {
        if (!device?.loaded) return null;
        // A LIVE duplicate. The guard used to test only for the presence of a map entry,
        // so a consumer that had died — its transport closed, or the server closing it
        // without a frame we understood — blocked its own replacement for ever. That is
        // what defeated the server's reconciler: it re-announced the producer every five
        // seconds, this line returned null every time, and the listener stayed silently
        // deaf to one particular person until they rejoined.
        for (const [id, entry] of consumers) {
            if (entry.cid !== cid || entry.slot !== slot) continue;
            if (!entry.consumer?.closed) return null;
            dropConsumer(id);
        }
        if (isWatchable(slot) && !watching.has(watchKey(cid, slot))) return null;

        await ensureRecv();
        link.send('consume', { cid, slot, rtpCapabilities: device.rtpCapabilities });
        const info = await waitFor('consumed', (m) => m.cid === cid && m.slot === slot);

        const consumer = await recvTransport.consume({
            id: info.consumerId,
            producerId: info.producerId,
            kind: info.kind,
            rtpParameters: info.rtpParameters,
        });

        const stream = new MediaStream([consumer.track]);

        if (info.kind === 'video') {
            // Video has no hidden sink: the stage owns the elements, this layer owns the
            // packets. Announce the stream, then let them flow — the first keyframe is
            // requested on resume, so a tile mounted a paint later still starts clean.
            consumers.set(consumer.id, { consumer, cid, slot, kind: 'video' });
            onVideo({ cid, slot, stream });
            link.send('resumeConsumer', { consumerId: consumer.id });
            return consumer;
        }

        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = stream;
        audioSink().append(audio);

        // Only now, with somewhere for the packets to go. The server starts every consumer
        // paused precisely so this ordering is possible.
        link.send('resumeConsumer', { consumerId: consumer.id });

        // A speaking meter belongs to a VOICE. Shared system audio is sound, not speech,
        // and metering it would put a talking ring on someone whose game made a noise.
        const meter = slot === SLOTS.AUDIO ? meterFor(stream, cid) : null;
        consumers.set(consumer.id, { consumer, cid, slot, kind: 'audio', audio, meter });

        // Always applied, never only-when-a-preference-exists: a stream that arrives
        // WHILE deafened has no preference of its own and must still be silent. Somebody
        // joining and talking is exactly when the old code would have let sound through.
        applyListen(audio, `${cid}:${slot}`);

        // Playback can be refused when nothing on the page has been interacted with yet.
        // It is worth knowing about rather than silently having no sound.
        audio.play().catch((err) => onChange({ state: 'blocked', message: err.message }));
        return consumer;
    }

    function dropConsumer(consumerId) {
        const entry = consumers.get(consumerId);
        if (!entry) return;
        try { entry.consumer.close(); } catch { /* already gone */ }
        if (entry.kind === 'video') {
            onVideo({ cid: entry.cid, slot: entry.slot, stream: null });
        } else {
            entry.audio.srcObject = null;
            entry.audio.remove();
            entry.meter?.stop();
            if (entry.slot === SLOTS.AUDIO) levels.delete(entry.cid);
        }
        consumers.delete(consumerId);
    }

    function dropConsumersOf(cid, slot = null) {
        for (const [id, entry] of consumers) {
            if (entry.cid === cid && (slot === null || entry.slot === slot)) dropConsumer(id);
        }
    }

    /* ── level metering ──────────────────────────────────────────────────── */

    /**
     * A level meter for one stream.
     *
     * Used for the weaving background's pace and, later, for showing who is speaking. Web
     * Audio rather than getStats: it is cheap, it updates at whatever rate we ask, and it
     * measures what is actually audible rather than what is being received.
     */
    function meterFor(stream, key) {
        try {
            ensureAudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.6;
            source.connect(analyser);

            const buffer = new Float32Array(analyser.fftSize);
            return {
                key,
                read() {
                    analyser.getFloatTimeDomainData(buffer);
                    let sum = 0;
                    for (const sample of buffer) sum += sample * sample;
                    // RMS, then a curve that makes quiet speech visible without making
                    // background hiss look like talking.
                    return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
                },
                stop() {
                    try { source.disconnect(); } catch { /* context already closed */ }
                },
            };
        } catch {
            // No Web Audio, or the context was refused. Voice still works; the background
            // just does not react to it.
            return null;
        }
    }

    function startLevels() {
        if (levelTimer) return;
        levelTimer = setInterval(() => {
            for (const entry of consumers.values()) {
                if (entry.meter) levels.set(entry.cid, entry.meter.read());
            }
            if (micMeter) {
                const level = muted ? 0 : micMeter.read();
                levels.set('self', level);
                // The settings meter runs on THIS path — the analyser provably reads
                // every engine we have met, where worklet telemetry has not.
                onMicTelemetry({
                    level,
                    db: level > 0 ? Math.max(-100, 20 * Math.log10(level)) : -100,
                });
            }
            onLevels(new Map(levels));
        }, LEVEL_INTERVAL_MS);
    }

    /* ── teardown ────────────────────────────────────────────────────────── */

    function teardownMedia() {
        // Everything the detectors know describes a path that is about to stop existing.
        watchdog.stop();
        for (const id of [...consumers.keys()]) dropConsumer(id);

        try { micProducer?.close(); } catch { /* already closed */ }
        micProducer = null;
        try { camProducer?.close(); } catch { /* already closed */ }
        camProducer = null;
        try { screenProducer?.close(); } catch { /* already closed */ }
        screenProducer = null;
        try { screenAudioProducer?.close(); } catch { /* already closed */ }
        screenAudioProducer = null;
        for (const track of camStream?.getTracks() ?? []) track.stop();
        camStream = null;
        for (const track of screenStream?.getTracks() ?? []) track.stop();
        screenStream = null;
        onVideo({ cid: 'self', slot: SLOTS.WEBCAM, stream: null });
        onVideo({ cid: 'self', slot: SLOTS.SCREEN, stream: null });

        for (const track of micStream?.getTracks() ?? []) track.stop();
        micStream = null;
        micChain?.stop();
        micChain = null;
        micMeter?.stop();
        micMeter = null;

        try { sendTransport?.close(); } catch { /* already closed */ }
        try { recvTransport?.close(); } catch { /* already closed */ }
        sendTransport = null;
        recvTransport = null;
        invalidateTransports();
    }

    /* ── public surface ──────────────────────────────────────────────────── */

    return {
        get ready() { return Boolean(device?.loaded); },
        get muted() { return muted; },
        get talking() { return Boolean(micProducer); },
        get levels() { return new Map(levels); },

        /** Load the device for this room. Safe to call again after a move. */
        async start(rtpCapabilities) {
            running = true;
            if (!device) {
                device = new Device();
            }
            if (!device.loaded) {
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }
            startLevels();
            onChange({ state: 'ready', canSend: device.canProduce('audio') });
        },

        enableMic,
        enableWebcam,
        disableWebcam: () => disableWebcamInner(),
        enableScreen,
        disableScreen: () => disableScreenInner(),
        get webcamOn() { return Boolean(camProducer); },
        get screenOn() { return Boolean(screenProducer); },

        /** How loudly YOU hear one of a peer's audio slots. Local, never signalled. */
        setListen(cid, slot, { muted, volume } = {}) {
            const key = `${cid}:${slot}`;
            const pref = { ...(audioPrefs.get(key) ?? { muted: false, volume: 1 }) };
            if (muted !== undefined) pref.muted = Boolean(muted);
            if (volume !== undefined) pref.volume = Math.max(0, Math.min(1, Number(volume)));
            audioPrefs.set(key, pref);
            for (const entry of consumers.values()) {
                if (entry.cid === cid && entry.slot === slot) applyListen(entry.audio, key);
            }
            return pref;
        },

        /**
         * Hear everybody, or nobody. Idempotent, so it is safe to call from a repaint or
         * after a media rebuild to reassert the state rather than tracking who last set it.
         */
        setDeafened(on) {
            const next = Boolean(on);
            if (next === deafened) return deafened;
            deafened = next;
            for (const entry of consumers.values()) {
                if (entry.kind === 'audio') applyListen(entry.audio, `${entry.cid}:${entry.slot}`);
            }
            return deafened;
        },

        get deafened() { return deafened; },

        getListen(cid, slot) {
            return { muted: false, volume: 1, ...(audioPrefs.get(`${cid}:${slot}`) ?? {}) };
        },

        /** Stop sending entirely, as distinct from muting. */
        async disableMic() {
            micProducerWanted = false;
            if (!micProducer) return;
            link.send('closeProducer', { slot: SLOTS.AUDIO });
            try { micProducer.close(); } catch { /* already closed */ }
            micProducer = null;
            for (const track of micStream?.getTracks() ?? []) track.stop();
            micStream = null;
            micChain?.stop();
            micChain = null;
            micMeter?.stop();
            micMeter = null;
            onChange({ state: 'live', talking: false });
        },

        /**
         * Apply changed audio constraints to the live track.
         *
         * Without this a preference change would only take effect on the next microphone
         * open, which for someone already in a call means "never" — they toggle noise
         * suppression, hear no difference, and reasonably conclude it does nothing.
         */
        /**
         * Switch to a different microphone, live.
         *
         * applyConstraints silently ignores deviceId — a device change NEEDS a fresh
         * getUserMedia. The old track is swapped out of the live producer in place, so
         * the room hears a blink, not a rebuild. This was a real bug: picking a mic in
         * settings changed nothing, and the meter went on reading the Windows default
         * endpoint — which on gaming headsets can be a driver mix that hears the GAME.
         */
        async switchMicrophone() {
            if (!micProducer || !micStream) return false;
            const oldStream = micStream;
            const oldChain = micChain;
            micStream = null;
            micChain = null;
            try {
                const track = await openMicrophone();
                await micProducer.replaceTrack({ track });
                micMeter?.stop();
                micMeter = meterFor(micStream, 'self');
                for (const t of oldStream.getTracks()) t.stop();
                oldChain?.stop();
                if (micChain?.processed) verifyChainCarries();
                return true;
            } catch (err) {
                // The new device refused; the old one keeps working.
                micStream = oldStream;
                micChain = oldChain;
                throw err;
            }
        },

        /** The device the live track ACTUALLY captures — the ground truth for the panel. */
        activeMicrophone() {
            const [track] = micStream?.getAudioTracks() ?? [];
            if (!track) return null;
            const s = track.getSettings?.() ?? {};
            return { deviceId: s.deviceId ?? null, label: track.label || null };
        },

        /** Nudge the live chain: gain and gate follow the sliders without re-producing. */
        applyChainSettings() {
            if (!micChain?.processed) return false;
            const settings = getChainSettings();
            micChain.setGain(gainToLinear(settings.micGain));
            micChain.setGate(Boolean(settings.noiseGate));
            micChain.setThresholdDb(sensitivityToDb(settings.gateSensitivity));
            return true;
        },

        async applyAudioConstraints() {
            const [track] = micStream?.getAudioTracks() ?? [];
            if (!track) return false;
            try {
                await track.applyConstraints(getAudioConstraints());
                return true;
            } catch {
                // Some devices refuse a live change. The setting still applies next time.
                return false;
            }
        },

        /**
         * Mute, without tearing anything down.
         *
         * The track stays live and the producer keeps sending — silence rather than
         * nothing. Stopping the track instead churns the transport on every toggle, and on
         * some machines a second getUserMedia comes back with a different device.
         */
        setMuted(next) {
            muted = Boolean(next);
            for (const track of micStream?.getAudioTracks() ?? []) track.enabled = !muted;
            if (muted) levels.set('self', 0);
            onChange({ state: 'live', muted });
        },

        /** Consume everything a peer is currently sending that we can play or show. */
        async consumePeer(peer) {
            for (const producer of peer?.producers ?? []) {
                await consume(peer.cid, producer.slot).catch(() => {});
            }
        },

        /**
         * Reconcile against the room's truth: consume what is missing, drop what is
         * orphaned. Events are how the client keeps up; THIS is how it recovers from the
         * event it never saw — a producer_new that raced a reconnect, a frame lost to a
         * blip. The production client ran exactly this heal on its heartbeat, and the
         * lesson survived for a reason: one missed frame otherwise becomes one person
         * silently unable to hear one other person until someone rejoins.
         */
        async sync(peersInRoom = []) {
            if (!device?.loaded || !running) return;

            const want = new Set();
            for (const peer of peersInRoom) {
                for (const producer of peer.producers ?? []) {
                    want.add(`${peer.cid}:${producer.slot}`);
                }
            }

            const have = new Set();
            for (const entry of consumers.values()) have.add(`${entry.cid}:${entry.slot}`);

            for (const [id, entry] of [...consumers]) {
                if (!want.has(`${entry.cid}:${entry.slot}`)) dropConsumer(id);
            }
            for (const key of want) {
                if (have.has(key)) continue;
                const [cid, slot] = key.split(':');
                if (isWatchable(slot) && !watching.has(watchKey(cid, slot))) continue;
                try {
                    await consume(cid, slot);
                    consumeFails.delete(key);
                    // The banner said a specific stream was stuck; once nothing is stuck
                    // any more, say so too. onChange REPLACES the whole displayed voice
                    // state, so without this the room stays stuck on "still retrying"
                    // forever after the retry that actually worked — nothing else was
                    // going to overwrite it.
                    if (failureSignaled && consumeFails.size === 0) {
                        failureSignaled = false;
                        onChange({ state: 'live', recovered: true });
                    }
                } catch (err) {
                    // A consume that keeps failing was invisible once, and it cost a
                    // person fifteen silent minutes of "he can't hear me". Three strikes
                    // and it is SAID, on screen, while the retrying continues.
                    const n = (consumeFails.get(key) ?? 0) + 1;
                    consumeFails.set(key, n);
                    console.warn(`[voice] consume ${key} failed (attempt ${n}):`, err?.message ?? err);
                    if (n === 3) {
                        failureSignaled = true;
                        onChange({
                            state: 'consume-failed',
                            message: 'Some audio in this room is not arriving — still retrying.',
                        });
                    }
                }
            }
        },

        /**
         * Watch or stop watching one stream. Watching starts the consumers (the video,
         * and a screen's system audio with it); stopping actually stops — consumers
         * close and the server is told, not merely hidden.
         */
        setWatching(cid, slot, on) {
            const slots = slot === SLOTS.SCREEN ? [slot, SLOTS.SCREEN_AUDIO] : [slot];
            const key = `${cid}:${slot}`;
            if (on) {
                watching.add(key);
                for (const k of slots) consume(cid, k).catch(() => {});
            } else {
                watching.delete(key);
                for (const k of slots) {
                    for (const [id, entry] of [...consumers]) {
                        if (entry.cid === cid && entry.slot === k) {
                            link.send('closeConsumer', { consumerId: id });
                            dropConsumer(id);
                        }
                    }
                }
            }
        },

        /** Whether this stream is currently opted into. */
        isWatching(cid, slot) { return watching.has(`${cid}:${slot}`); },

        /**
         * What the mic is sending, for the connection pill: codec name and a bitrate
         * measured between calls. First call primes the counter and reports codec only.
         */
        async mediaStats() {
            if (!micProducer || micProducer.closed) { statSample = null; return null; }
            try {
                const codec = micProducer.rtpParameters?.codecs?.[0]?.mimeType
                    ?.split('/')[1]?.toLowerCase() ?? null;
                const report = await micProducer.getStats();
                let out = null;
                for (const row of report.values()) {
                    if (row.type === 'outbound-rtp') out = row;
                }
                if (!out) return { codec, bitrateKbps: null };
                const prev = statSample;
                statSample = { bytes: out.bytesSent ?? 0, at: out.timestamp ?? Date.now() };
                const kbps = prev && statSample.at > prev.at
                    ? Math.round(((statSample.bytes - prev.bytes) * 8) / (statSample.at - prev.at))
                    : null;
                return { codec, bitrateKbps: kbps && kbps > 0 ? kbps : null };
            } catch {
                return null;
            }
        },

        /** Handle a signalling frame. Returns true if it was ours. */
        handle(msg) {
            if (deliver(msg)) return true;

            switch (msg.type) {
                case 'producer_new':
                    consume(msg.cid, msg.slot).catch(() => {});
                    return true;

                case 'producer_closed':
                    dropConsumersOf(msg.cid, msg.slot);
                    // The choice belonged to THAT broadcast; a new one starts as a
                    // placeholder again.
                    watching.delete(`${msg.cid}:${msg.slot}`);
                    return true;

                case 'consumerClosed':
                    dropConsumer(msg.consumerId);
                    return true;

                case 'peer_left':
                    dropConsumersOf(msg.cid);
                    for (const key of [...watching]) if (key.startsWith(`${msg.cid}:`)) watching.delete(key);
                    return true;

                case 'transportFailed':
                    // 'closed' is terminal: the transport is already gone server-side, so
                    // there is nothing left to repair in place.
                    if (msg.state === 'closed') {
                        recover(`server reported ${msg.direction} ${msg.state}`);
                        return true;
                    }
                    // 'disconnected' used to be discarded here, on the grounds that the
                    // client's own connectionstatechange would handle it. It did not — that
                    // handler only knew 'failed' — so this frame and that handler each
                    // deferred to the other and the transport stayed silently dead. Now it
                    // goes to the watchdog, which gives the browser its grace period and
                    // then repairs.
                    if (msg.state === 'disconnected' && msg.direction) {
                        transportState[msg.direction] = 'disconnected';
                        watchdog.start();
                        assess(msg.direction).catch(() => {});
                    }
                    return true;

                default:
                    return false;
            }
        },

        /**
         * A move happened. Consumers always die; the rest depends on the server.
         *
         * Consumers belong to the old channel's router either way, so they go regardless.
         * Transports and producers only have to go when the server says `mediaReset`, which
         * it does when the new channel is served by a different worker — and therefore a
         * different router, on which our producer would sit unheard and our receive
         * transport would be deaf. On a single-worker server, which is the default, this is
         * never set and a move costs nothing.
         *
         * Rebuilding is left to the caller: it happens as part of bringing voice up for the
         * new room, so the microphone is opened once rather than closed and reopened.
         */
        async onMoved({ rtpCapabilities, mediaReset = false } = {}) {
            for (const id of [...consumers.keys()]) dropConsumer(id);
            // A different room is a different audience: everything starts as a
            // placeholder again.
            watching.clear();
            // A key naming an old room's peer would otherwise sit in this map forever
            // (nothing will ever consume it again to clear it), permanently blocking the
            // banner from ever being allowed to clear again — see sync()'s check.
            consumeFails.clear();
            failureSignaled = false;

            if (mediaReset) {
                try { micProducer?.close(); } catch { /* already closed */ }
                micProducer = null;
                try { camProducer?.close(); } catch { /* already closed */ }
                camProducer = null;
                try { screenProducer?.close(); } catch { /* already closed */ }
                screenProducer = null;
                try { screenAudioProducer?.close(); } catch { /* already closed */ }
                screenAudioProducer = null;
                try { sendTransport?.close(); } catch { /* already closed */ }
                try { recvTransport?.close(); } catch { /* already closed */ }
                sendTransport = null;
                recvTransport = null;
                // A move onto a different router (a different mediasoup worker) makes any
                // transport creation already in flight from BEFORE this move pointless —
                // it would connect, if it connected at all, to the router this peer just
                // left. Without this, that stale attempt could still be ADOPTED (the
                // epoch check alone doesn't help here, since nothing had bumped it), or a
                // caller right after the move could sit queued behind it for up to the
                // full reply timeout. This was the second half of the transport-race bug
                // fixed in 0.1.35 — teardownMedia() got the guard, this sibling teardown
                // path did not, which is exactly why a recover() cycle could still repeat.
                invalidateTransports();

                // The microphone track itself is kept. It is still a perfectly good track,
                // the permission is already granted, and reopening it risks coming back
                // with a different device.
            }

            if (rtpCapabilities && device && !device.loaded) {
                await device.load({ routerRtpCapabilities: rtpCapabilities });
            }
        },

        stop() {
            running = false;
            micProducerWanted = false;
            watchdog.stop();
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            clearInterval(levelTimer);
            levelTimer = null;
            teardownMedia();
            levels.clear();
            waiters.clear();
            consumeFails.clear();
            failureSignaled = false;
            try { audioContext?.close(); } catch { /* already closed */ }
            audioContext = null;
            sink?.remove();
            sink = null;
        },
    };
}
