// How long this person has actually been away from their machine.
//
// The server has only ever had one signal for this: microphone silence. That is a poor
// proxy and always was — it cannot tell somebody who has left the house from somebody
// listening intently, and the module's own header has said since it was written that the
// native client should report OS idle time instead. It can now.
//
// `powerMonitor.getSystemIdleTime()` is seconds since the last keyboard or mouse input at
// the OPERATING SYSTEM level, so it counts input to any application, not just to Weave.
// That is the whole point: a person writing code in another window is at their desk.
//
// What it cannot see is somebody watching a video without touching anything. At the OS
// level that is indistinguishable from an empty chair, and no client-side trick changes
// that — which is why the one case Weave CAN see is handled here: if you are watching a
// stream inside Weave, you are engaged, whatever the mouse is doing.

/** A report older than this is ignored, so a client that stops reporting falls back. */
export const IDLE_REPORT_TTL_MS = 90_000;

/**
 * What to tell the server, in milliseconds since this person last did anything.
 *
 * `null` means "I cannot tell you" rather than "zero", and the two must not be confused:
 * a browser has no way to see OS input at all, and reporting 0 would pin every web client
 * permanently active and quietly disable the away feature for them.
 *
 * @param {number|null} osIdleMs      from the shell, or null where there is no shell
 * @param {boolean}     watchingVideo a live video consumer is attached and not hidden
 * @returns {number|null}
 */
export function effectiveIdleMs({ osIdleMs = null, watchingVideo = false } = {}) {
    if (osIdleMs === null || osIdleMs === undefined || !Number.isFinite(osIdleMs)) return null;
    // Watching somebody's screen for an hour is the case that makes a pure input-idle
    // measure feel broken, and it is the one case this side of the wire can actually
    // answer: the stream is being consumed HERE, so the person is here.
    if (watchingVideo) return 0;
    return Math.max(0, osIdleMs);
}

/**
 * Read OS idle time through the platform bridge, if there is one.
 *
 * Everything about this is optional: the browser build has no bridge, and the desktop UI
 * is routinely run in a plain browser during development, so a missing function is normal
 * rather than an error.
 */
export function createIdleReporter({ platform, isWatchingVideo = () => false }) {
    const read = platform?.power?.idleSeconds;
    const available = typeof read === 'function';

    return {
        available,
        /** Milliseconds of inactivity, or null when this build cannot know. */
        current() {
            if (!available) return null;
            let seconds = null;
            try {
                seconds = read();
            } catch {
                // A bridge that throws is a bridge that is not there.
                return null;
            }
            if (!Number.isFinite(seconds)) return null;
            return effectiveIdleMs({
                osIdleMs: seconds * 1000,
                watchingVideo: Boolean(isWatchingVideo()),
            });
        },
    };
}
