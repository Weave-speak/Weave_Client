// When a message deserves a sound.
//
// The web app played one for every message somebody else sent in your channel. That ports,
// with two refinements the new client needs because it can show more than one place:
//
//   - "your channel" is the conversation ON SCREEN — a text channel you are reading, or a
//     DM thread — not the voice room you happen to be standing in;
//   - a message elsewhere that is addressed to you — it names you, or it is a DM — is worth
//     a sound too, because otherwise the only sign of it is a badge you are not looking at.
//
// Nothing while deafened. Deafen promises silence, and a chime per message is a sound.
//
// Pure: the room says what happened and what is on screen, this answers.

/**
 * @param {object}  options
 * @param {boolean} options.fromSelf   your own message, echoed back
 * @param {boolean} options.onScreen   it landed in the conversation being shown
 * @param {boolean} options.addressed  it names you, or it is a direct message
 * @param {boolean} options.deafened
 * @param {object}  options.prefs      { soundMessages, soundMentions }
 * @returns {'message'|null}
 */
export function messageCue({ fromSelf = false, onScreen = false, addressed = false, deafened = false, prefs = {} } = {}) {
    if (fromSelf || deafened) return null;
    if (onScreen) return prefs.soundMessages !== false ? 'message' : null;
    if (addressed) return prefs.soundMentions !== false ? 'message' : null;
    return null;
}
