// Who decides whether the microphone transmits.
//
// Two different intents share the word "mute", and conflating them produced a real bug:
// with push-to-talk on, pressing the key MUTED a manually-unmuted user — the exact
// opposite of what the key is for.
//
//   - `muted` is a person's standing choice: "do not transmit until I say otherwise".
//   - Push-to-talk is a GATE on the stream: closed by default, open only while held.
//   - `forceMuted` is somebody ELSE's decision, and outranks both. It is the one state
//     here that no key press and no button can lift.
//
// While push-to-talk is on, the key is the only mute control — the mute button is
// disabled, because offering two controls over one stream is how they end up fighting.
// The server is always told the EFFECTIVE state, so what peers see (muted marks, strand
// activity) reflects whether audio is actually flowing, not which mechanism decided it.

/**
 * The effective transmit state, as one honest boolean.
 *
 * @returns {boolean} true when the microphone must NOT transmit.
 */
export function effectiveMute({
    pushToTalk = false, held = false, muted = false, deafened = false, forceMuted = false,
} = {}) {
    // First, and above even deafen, because it is the only one of these that is not this
    // person's decision to make. The server pauses their producer regardless; agreeing
    // with it here is what keeps the button, the mark and the RTP saying the same thing.
    if (forceMuted) return true;
    if (deafened) return true;             // deafened always implies not transmitting
    if (pushToTalk) return !held;          // the gate: closed unless the key is down
    return muted;                          // otherwise the standing choice stands
}

/**
 * What flipping the push-to-talk setting should do to the microphone.
 *
 * Turning it ON closes the gate immediately — leaving the mic open until the first press
 * means the setting appears to do nothing, and everything said in between is broadcast by
 * someone who believes it is not.
 *
 * Turning it OFF returns to an OPEN mic rather than to "muted": the person just declared
 * they want an open microphone again, and making them find the unmute button after every
 * settings visit teaches them the setting is broken.
 */
export function onPushToTalkChange({ turnedOn, deafened = false }) {
    if (turnedOn) return { held: false, muted: true };
    return { held: false, muted: deafened };
}

/**
 * Whether the mute button is usable at all.
 *
 * Under push-to-talk the key owns the stream. Under a server mute nothing this person can
 * press owns it — leaving the button live would offer them a control that does nothing,
 * which reads as the app being broken rather than as them being muted.
 */
export const muteButtonDisabled = (prefs = {}) =>
    Boolean(prefs.pushToTalk) || Boolean(prefs.forceMuted);
