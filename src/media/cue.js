// The short sounds played outside the call itself: join and leave cues, and the preview
// button that lets someone choose one.
//
// The room's voices go to the output device chosen in Voice & Audio (setSink in voice.js).
// A bare `new Audio()` does not follow them: it plays on the SYSTEM default. Anyone whose
// chosen device was not the default — a headset picked in settings while Windows still
// points at the monitor's speakers, or a default that moved when a dock or a Bluetooth
// headset connected — heard every voice and none of the cues, which looks exactly like the
// cues never being sent.

/**
 * Play `audio` on the chosen output device.
 *
 * The routing is best effort, for the same reasons as setSink: setSinkId can reject (a
 * device unplugged since it was chosen) or be missing (an older engine), and a cue on the
 * default device beats no cue at all. It is awaited before play() so the first moment of
 * the sound does not come out of the wrong speaker. play() itself is NOT swallowed — the
 * caller decides what a refusal means.
 *
 * @param {HTMLAudioElement} audio
 * @param {string} [deviceId]  empty or absent is the system default
 * @returns {Promise<void>}
 */
export function playCue(audio, deviceId) {
    const routed = deviceId
        ? Promise.resolve().then(() => audio.setSinkId?.(deviceId)).catch(() => {})
        : Promise.resolve();
    return routed.then(() => audio.play());
}
