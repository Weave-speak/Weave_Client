// What we ask Opus for, per slot.
//
// These live apart from voice.js because they are decisions, not plumbing — and because
// the history behind them is worth keeping where the next person will read it.
//
// EVERYTHING HERE IS BACK TO WHAT 0.1.40 DID, deliberately. Four releases in a row tried
// to improve this and each one made something worse: a 48 kHz graph against a 44.1 kHz
// microphone (crackling), Opus retransmission on a long link (fast-forwarded audio), and
// then a general "it sounds worse" that no single hypothesis explained. That last one is
// the signal that matters — when reasoning has been wrong three times, the next move is
// to go back to the version people were happy with, not to reason a fourth time.
//
// The bitrate is the one change genuinely worth having, and it is now a SERVER setting
// (WEAVE_OPUS_BITRATE) that ships off. Turning it on is one environment variable and a
// restart, which makes it an A/B test somebody can actually run and listen to, rather
// than a guess baked into a release.

/**
 * The microphone.
 *
 * FEC on: a packet reconstructed from the next one matters more to a conversation than
 * bitrate does, and it costs no round trip, so it helps a distant caller as much as a
 * near one. DTX on: this is what shipped for every version people described as sounding
 * fine.
 *
 * NOT set here, each for a reason learned the hard way:
 *   opusNack             -- retransmission costs a full round trip, so the receiver holds
 *                           its jitter buffer open and then plays fast to catch up. That
 *                           is what made callers from another continent sound
 *                           fast-forwarded. mediasoup-client strips it unless asked; let
 *                           it strip.
 *   opusMaxAverageBitrate -- the server decides, so it can be changed without a release.
 *   opusMaxPlaybackRate   -- pinning fullband stops Opus narrowing its own bandwidth when
 *                           the link tightens, which is a thing it is good at.
 */
export function micCodecOptions() {
    return { opusDtx: true, opusFec: true };
}

/**
 * A screen's system audio: music, games and film, not speech.
 *
 * Stereo, and no DTX — silence suppression makes music gap and pump. Note that echo
 * cancellation on the capture (see presets.js) downmixes to mono anyway, so opusStereo is
 * currently asking for something the source cannot give. It stays because it costs
 * nothing and is correct the moment per-application capture makes real stereo possible.
 */
export function screenAudioCodecOptions() {
    return { opusStereo: true, opusDtx: false };
}
