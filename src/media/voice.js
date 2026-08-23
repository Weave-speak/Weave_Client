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
} = {}) {
    let device = null;
    let sendTransport = null;
    let recvTransport = null;

    let micStream = null;
    let micProducer = null;
    let muted = false;
    let recoverAttempts = 0;
    let running = false;

    const consumers = new Map();   // consumerId -> { consumer, cid, slot, audio, meter }
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
        transport.on('connectionstatechange', (statev) => {
            if (statev === 'failed') recover(`${direction} transport ICE failed`);
        });

        return transport;
    }

    const ensureSend = async () => (sendTransport ??= await createTransport('send'));
    const ensureRecv = async () => (recvTransport ??= await createTransport('recv'));

    /* ── the microphone ──────────────────────────────────────────────────── */

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
        return track;
    }

    /* ── recovery ────────────────────────────────────────────────────────── */

    async function recover(reason) {
        if (!running) return;

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
            onChange({ state: 'live', recovered: true });
        } catch (err) {
            onChange({ state: 'recovering', reason: err.message, attempt: recoverAttempts, of: MAX_RECOVER });
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
            codecOptions: { opusDtx: true, opusFec: true },
        });

        // A successful produce proves the path works end to end, so this is the only place
        // the recovery counter is allowed to reset. Resetting it on a socket reconnect
        // instead is what produced 51 rebuilds in 18 minutes.
        recoverAttempts = 0;
        onChange({ state: 'live', talking: true });
        return micProducer;
    }

    /* ── consuming ───────────────────────────────────────────────────────── */

    async function consume(cid, slot) {
        if (!device?.loaded) return null;
        if ([...consumers.values()].some((c) => c.cid === cid && c.slot === slot)) return null;

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
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = stream;
        audioSink().append(audio);

        // Only now, with somewhere for the packets to go. The server starts every consumer
        // paused precisely so this ordering is possible.
        link.send('resumeConsumer', { consumerId: consumer.id });

        const meter = meterFor(stream, cid);
        consumers.set(consumer.id, { consumer, cid, slot, audio, meter });

        // Playback can be refused when nothing on the page has been interacted with yet.
        // It is worth knowing about rather than silently having no sound.
        audio.play().catch((err) => onChange({ state: 'blocked', message: err.message }));
        return consumer;
    }

    function dropConsumer(consumerId) {
        const entry = consumers.get(consumerId);
        if (!entry) return;
        try { entry.consumer.close(); } catch { /* already gone */ }
        entry.audio.srcObject = null;
        entry.audio.remove();
        entry.meter?.stop();
        levels.delete(entry.cid);
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
            audioContext ??= new (window.AudioContext ?? window.webkitAudioContext)();
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
            if (micMeter) levels.set('self', muted ? 0 : micMeter.read());
            onLevels(new Map(levels));
        }, LEVEL_INTERVAL_MS);
    }

    /* ── teardown ────────────────────────────────────────────────────────── */

    function teardownMedia() {
        for (const id of [...consumers.keys()]) dropConsumer(id);

        try { micProducer?.close(); } catch { /* already closed */ }
        micProducer = null;

        for (const track of micStream?.getTracks() ?? []) track.stop();
        micStream = null;
        micMeter?.stop();
        micMeter = null;

        try { sendTransport?.close(); } catch { /* already closed */ }
        try { recvTransport?.close(); } catch { /* already closed */ }
        sendTransport = null;
        recvTransport = null;
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

        /** Stop sending entirely, as distinct from muting. */
        async disableMic() {
            micProducerWanted = false;
            if (!micProducer) return;
            link.send('closeProducer', { slot: SLOTS.AUDIO });
            try { micProducer.close(); } catch { /* already closed */ }
            micProducer = null;
            for (const track of micStream?.getTracks() ?? []) track.stop();
            micStream = null;
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

        /** Consume everything a peer is currently sending that we can play. */
        async consumePeer(peer) {
            for (const producer of peer?.producers ?? []) {
                if (producer.slot === SLOTS.AUDIO) {
                    await consume(peer.cid, producer.slot).catch(() => {});
                }
            }
        },

        /** Handle a signalling frame. Returns true if it was ours. */
        handle(msg) {
            if (deliver(msg)) return true;

            switch (msg.type) {
                case 'producer_new':
                    if (msg.slot === SLOTS.AUDIO) consume(msg.cid, msg.slot).catch(() => {});
                    return true;

                case 'producer_closed':
                    dropConsumersOf(msg.cid, msg.slot);
                    return true;

                case 'consumerClosed':
                    dropConsumer(msg.consumerId);
                    return true;

                case 'peer_left':
                    dropConsumersOf(msg.cid);
                    return true;

                case 'transportFailed':
                    // The server saw ICE die. It reports 'disconnected' too, which often
                    // recovers on its own, so only a close is treated as fatal here — the
                    // client's own connectionstatechange handles the rest.
                    if (msg.state === 'closed') recover(`server reported ${msg.direction} ${msg.state}`);
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

            if (mediaReset) {
                try { micProducer?.close(); } catch { /* already closed */ }
                micProducer = null;
                try { sendTransport?.close(); } catch { /* already closed */ }
                try { recvTransport?.close(); } catch { /* already closed */ }
                sendTransport = null;
                recvTransport = null;

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
            clearInterval(levelTimer);
            levelTimer = null;
            teardownMedia();
            levels.clear();
            waiters.clear();
            try { audioContext?.close(); } catch { /* already closed */ }
            audioContext = null;
            sink?.remove();
            sink = null;
        },
    };
}
