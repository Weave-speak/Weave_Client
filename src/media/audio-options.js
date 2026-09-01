// What we ask Opus for, per slot.
//
// These live apart from voice.js because they are decisions, not plumbing -- and because
// the history behind them is worth keeping where the next person will read it.
//
// THE HISTORY: 0.1.41 through 0.1.44 each tried to improve this path by reasoning about
// it, and each fixed the previous mistake while introducing another -- a 48 kHz graph
// against a 44.1 kHz microphone (crackling), a 10 ms capture buffer (popping), Opus
// retransmission over an intercontinental link (fast-forwarded speech). 0.1.45 reverted
// the lot on the grounds that three wrong explanations in a row is evidence that reasoning
// about this path without listening to it does not work.
//
// That grounds this change rather than contradicting it. What is below is not a fifth
// theory: it is what the Weave web app sends, which is the client people compare us to
// when they say voice sounds better over there, and which has been in production for
// months with the same SFU and the same codec. Copying a thing that demonstrably works is
// a different act from deducing what ought to work.

/**
 * The microphone.
 *
 * DTX OFF is the change that matters. Discontinuous transmission stops sending during what
 * the encoder judges to be silence, and its re-entry clips the front of the next word --
 * heard as stuttering, and worse the more a link is already struggling. It was on for every
 * version that has been described as stuttering. The noise gate already decides when not to
 * transmit, and it does so with a threshold the person can see and set, so DTX is doing a
 * job nothing needs done.
 *
 * FEC on: a packet reconstructed from the next one matters more to a conversation than
 * bitrate does, and it costs no round trip, so it helps a distant caller as much as a near
 * one. Mono, explicitly: a microphone is one sound source, and stereo would double the
 * bitrate to encode a phase difference nobody wants in a voice mix.
 *
 * opusMaxPlaybackRate keeps Opus full-band. This is the one line here with a standing
 * argument against it -- pinning fullband stops Opus narrowing its own bandwidth when a
 * link tightens, which is a thing it is good at -- and it is therefore the FIRST thing to
 * remove if a listening test says this release sounds worse. It is here because the web
 * app pins it too.
 *
 * NOT set here, each for a reason learned the hard way:
 *   opusNack             -- retransmission costs a full round trip, so the receiver holds
 *                           its jitter buffer open and then plays fast to catch up. That
 *                           is what made callers from another continent sound
 *                           fast-forwarded in 0.1.43. mediasoup-client strips it unless
 *                           asked; let it strip.
 *   opusMaxAverageBitrate -- the SERVER decides, and now actually does: WEAVE_OPUS_BITRATE
 *                           defaults to 96000 rather than shipping unset. Router parameters
 *                           are what configure a browser's encoder, so setting it there
 *                           raises the quality of every client including ones too old to
 *                           ask, and leaves an operator one restart away from a different
 *                           number. Naming it here as well would only take that back.
 *                           Against an older server this simply falls back to whatever the
 *                           browser picks, which is where we were.
 */
export function micCodecOptions() {
    return {
        opusStereo: false,
        opusFec: true,
        opusDtx: false,
        opusMaxPlaybackRate: 48000,
    };
}

/**
 * A screen's system audio: music, games and film, not speech.
 *
 * Stereo, and no DTX -- silence suppression makes music gap and pump.
 *
 * The bitrate is PINNED HERE, which is a deliberate exception to the rule above. The rule is
 * right for the microphone and wrong for this slot: the server has one value to give both,
 * so raising it on the router to suit shared music would drag every microphone up with it
 * for nothing. The two slots have to be able to disagree.
 *
 * 256 kb/s is Opus's own recommended ceiling for stereo music and costs a fraction of the
 * multi-megabit video it travels beside. It is not a guess in the way the reverted ones were:
 * those changed how a working signal was processed, this restores a starved one to a normal
 * bitrate.
 *
 * Note that echo cancellation on the capture (see presets.js) still downmixes to mono, so
 * opusStereo is asking for something the source cannot yet give. It stays because it costs
 * nothing and is correct the moment per-application capture makes real stereo possible -- and
 * because at 256 kb/s the flag no longer has a starved budget to halve.
 */
export function screenAudioCodecOptions() {
    return { opusStereo: true, opusDtx: false, opusMaxAverageBitrate: 256_000 };
}
