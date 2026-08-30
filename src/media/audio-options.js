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
//
// All of that is about the MICROPHONE. A screen's system audio is a different slot with a
// different answer, and it does pin its bitrate here — see screenAudioCodecOptions for why
// the router is the wrong place to say it.

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
 * Stereo, and no DTX — silence suppression makes music gap and pump.
 *
 * The bitrate is PINNED HERE, and only here, which is a deliberate exception to the rule the
 * header sets out. The rule is right for the microphone and wrong for this slot, for two
 * reasons. The server's value is a floor for every producer, so raising it on the router to
 * suit shared music drags the microphone up with it for nothing — the two slots have to be
 * able to disagree. And the server knob ships OFF, so "the server decides" has in practice
 * meant Chromium's own fallback of roughly 32 kb/s: below the floor where stereo Opus is
 * listenable on music at all, and split across two channels at that. Game and film audio
 * arriving as a smeared mono blur is the whole of it.
 *
 * 256 kb/s is Opus's own recommended ceiling for stereo music and costs a fraction of the
 * multi-megabit video it travels beside. It is not a guess in the way the reverted ones were:
 * those changed how a working signal was processed, this restores a starved one to a normal
 * bitrate.
 *
 * Note that echo cancellation on the capture (see presets.js) still downmixes to mono, so
 * opusStereo is asking for something the source cannot yet give. It stays because it costs
 * nothing and is correct the moment per-application capture makes real stereo possible — and
 * because at 256 kb/s the flag no longer has a starved budget to halve.
 */
export function screenAudioCodecOptions() {
    return { opusStereo: true, opusDtx: false, opusMaxAverageBitrate: 256_000 };
}
