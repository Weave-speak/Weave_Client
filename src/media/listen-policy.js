// How loudly you hear one incoming stream, and through which of two outputs.
//
// There are two ways to play a remote track, and each is wrong on its own:
//
//   - The <audio> element is simple and always works, but HTMLMediaElement.volume is
//     capped at 1.0 by the spec. A slider on top of it can only ever turn somebody DOWN,
//     which is half of why "I can barely hear them" had no fix.
//   - A Web Audio GainNode has no such ceiling, but emits nothing at all while the
//     AudioContext is suspended — and browsers suspend one for reasons that have nothing
//     to do with us: the autoplay policy before the first click, the window going to the
//     background, the OS moving audio focus.
//
// So the element stays attached (Chromium does not reliably pull a MediaStreamTrack
// through Web Audio without one) and the two take turns. EXACTLY ONE IS EVER AUDIBLE,
// which is the whole point of deciding it in one place: a version that muted the element
// whenever a gain node merely EXISTED went silent the moment a context suspended, and a
// version that unmuted it whenever the context was suspect played everybody twice.
//
// Deafen outranks a per-stream choice while it is on, and lifting it RESTORES that choice
// rather than blanket-unmuting: somebody you had individually muted stays muted.

/** The loudest anyone may be turned up to. 1.0 is the stream exactly as it was sent. */
export const MAX_LISTEN_GAIN = 2;

/**
 * What one stream should sound like right now.
 *
 * @param {object}  options
 * @param {boolean} options.deafened        hearing nobody, whatever any stream says
 * @param {object}  options.pref            { muted, volume } — this listener's choice
 * @param {boolean} options.hasGain         whether a Web Audio path was built for it
 * @param {boolean} options.contextRunning  whether that path can currently make a sound
 * @returns {{ gain: number|null, elementMuted: boolean, elementVolume: number }}
 *   `gain` is null when there is no node to write to.
 */
export function listenOutput({
    deafened = false,
    pref = {},
    hasGain = false,
    contextRunning = false,
} = {}) {
    const silent = Boolean(deafened) || Boolean(pref.muted);
    const wanted = Number(pref.volume ?? 1);
    const volume = Number.isFinite(wanted)
        ? Math.max(0, Math.min(MAX_LISTEN_GAIN, wanted))
        : 1;

    // The Web Audio path, when it can actually be heard.
    if (hasGain && contextRunning) {
        return { gain: silent ? 0 : volume, elementMuted: true, elementVolume: 1 };
    }
    // The element, with the gain node silenced so a context that resumes mid-sentence
    // cannot add a second copy of the same voice before the next decision is made.
    return {
        gain: hasGain ? 0 : null,
        elementMuted: silent,
        elementVolume: Math.min(1, volume),
    };
}
