// What we ask Opus for, per slot.
//
// These live apart from voice.js because they are decisions, not plumbing: the numbers
// below are the difference between a call that sounds like Discord and one that sounds
// like a phone, and they are worth being able to assert without a browser.
//
// The single biggest one is `opusMaxAverageBitrate`. Without it Chromium falls back to
// roughly 32 kb/s mono, which is where speech starts losing its top octave — most of what
// people mean by "muffled". Discord's default voice channel is 64 kb/s and that is the
// floor we match.

/**
 * The microphone: one voice, mono, resilience over bandwidth.
 *
 * DTX is OFF, changed from on. Silence suppression stacks badly with our own noise gate —
 * the gate already emits digital silence, DTX then stops sending altogether, and the first
 * syllable after a pause lands before the decoder has re-primed, which is audible as a
 * clipped word and gets reported as "he cuts out". It also blinds the server's
 * AudioLevelObserver through the gap, so the speaking ring lags behind the speaker.
 *
 * It has a second job now: the stall watchdog treats a silent send transport as a fault,
 * and with DTX on, a connected-but-quiet microphone is indistinguishable from a dead path.
 *
 * FEC on — a packet reconstructed from the next one matters more to a conversation than
 * any bitrate does, and it costs no round trip: the redundancy rides inside the next
 * packet, so a long link benefits exactly as much as a short one.
 *
 * NACK deliberately NOT set. mediasoup-client strips Opus NACK unless asked, and asking
 * for it (0.1.41) made distant callers sound fast-forwarded and crackly. Retransmission
 * costs a full round trip, so the receiver holds its jitter buffer open waiting — and
 * then time-compresses the audio to catch up, which is what "fast-forwarded" is. Worse,
 * nothing was ever going to arrive: the server leaves enableRtx at its default, which is
 * false for audio, so it never retransmits. The wait was pure cost.
 *
 * Over a short hop the delay is small enough to hide. Over an international one it is
 * not, which is why this only ever showed up for callers on another continent.
 */
export function micCodecOptions() {
    return {
        opusStereo: false,
        opusFec: true,
        opusDtx: false,
        opusMaxAverageBitrate: 64_000,
        opusMaxPlaybackRate: 48_000,
    };
}

/**
 * A screen's system audio: music, games and film, not speech.
 *
 * Stereo, and this is the half that used to be missing — `opusStereo` was already set
 * here, but the capture never asked for two channels, so it was stereo in name only.
 * 128 kb/s is Discord's high tier and about where stereo Opus stops being distinguishable
 * on the material people actually share; 256 exists and buys almost nothing against a
 * screenshare's video budget.
 *
 * This value MUST be set client-side rather than declared on the router: the router's
 * parameters are the floor for every producer, and raising it to 128k there would drag the
 * microphone up with it for no gain. The two slots have to disagree.
 */
export function screenAudioCodecOptions() {
    return {
        opusStereo: true,
        opusFec: true,
        opusDtx: false,
        opusMaxAverageBitrate: 128_000,
        opusMaxPlaybackRate: 48_000,
    };
}
