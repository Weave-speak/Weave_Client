// Stream quality presets: the same ladder Discord trained everyone on, minus the
// paywall. Each preset decides three things together — capture caps, encoder budget,
// and the tie-breaker for when the encoder cannot have both sharpness and smoothness.

/**
 * The user-facing ladder. 'source' captures at native size, budget permitting.
 *
 * `fps` is a TARGET, not a ceiling. What actually reaches the encoder is whatever
 * `bestFitFramerate` snaps it to once the source's real cadence is known; a null declines to
 * cap the rate at all, which is what 'source' means by "as it is".
 */
export const STREAM_PRESETS = Object.freeze({
    '720p30': { label: '720p · 30fps', width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 },
    '1080p30': { label: '1080p · 30fps', width: 1920, height: 1080, fps: 30, maxBitrate: 4_000_000 },
    '1080p60': { label: '1080p · 60fps', width: 1920, height: 1080, fps: 60, maxBitrate: 6_000_000 },
    source: { label: 'Source — your screen as it is', width: null, height: null, fps: null, maxBitrate: 8_000_000 },
});

export const DEFAULT_STREAM_PRESET = '1080p30';

/**
 * What the CAPTURE is allowed to run at, for every preset alike.
 *
 * This is a machine ceiling, not a quality setting, and the distinction is the whole fix for
 * stuttering games. A per-preset `max` here made Chromium run the desktop capturer on a
 * fixed-interval timer, and a source whose cadence does not divide into that interval lands
 * its frames either side of the tick: 70 fps into a 30 Hz grid is a 2-1-2-1 stagger with
 * nothing lost to the network at all. The judder was manufactured at capture.
 *
 * A ceiling ABOVE the source rate costs nothing — every frame still arrives within one
 * interval of being drawn, under 8 ms of jitter at this value, and WebRTC drops the
 * duplicates. Only a ceiling below the source rate creates the beat.
 *
 * It is stated rather than left out because Chromium's own default for display capture has
 * been as low as 30 depending on version, and silently inheriting that would undo all of the
 * above without any error to notice.
 */
export const CAPTURE_FPS_CEILING = 120;

/**
 * The chosen rate, snapped to a cadence the source can actually divide into.
 *
 * Dividing the source by a whole number is the point: every streamed frame then corresponds
 * to exactly n source frames, so the spacing is even. Rounding to the NEAREST divisor rather
 * than down is deliberate — a 70 fps game against a 30 fps choice streams at 35, slightly
 * over budget and perfectly smooth, where 23.3 would be under budget and visibly worse.
 *
 * Returns null for "do not cap", which is the honest answer twice over: when the preset
 * declines to name a rate, and when the source is already at or below the target. A 24 fps
 * film has no business being resampled to hit a 30 fps budget it never threatened.
 *
 * A source rate of 0, NaN or undefined means the stats have not settled yet, so fall back to
 * the target the user chose rather than to Infinity or a divide by zero.
 */
export function bestFitFramerate(sourceFps, targetFps) {
    if (!targetFps) return null;
    const source = Number(sourceFps);
    if (!Number.isFinite(source) || source <= 0) return targetFps;
    if (source <= targetFps) return null;
    return source / Math.max(1, Math.round(source / targetFps));
}

/**
 * Everything one share needs, from two settings.
 *
 * `prefer` is the honest trade-off: 'detail' tells the encoder to keep text readable and
 * drop frames under pressure; 'motion' keeps the frame rate and lets pixels soften.
 */
export function screenShareSettings({ preset = DEFAULT_STREAM_PRESET, prefer = 'detail' } = {}) {
    const p = STREAM_PRESETS[preset] ?? STREAM_PRESETS[DEFAULT_STREAM_PRESET];
    return {
        constraints: {
            video: {
                // The preset's own rate is NOT here on purpose; see CAPTURE_FPS_CEILING.
                frameRate: { max: CAPTURE_FPS_CEILING },
                ...(p.width ? { width: { max: p.width }, height: { max: p.height } } : {}),
            },
            // ECHO CANCELLATION MUST STAY ON. This looks wrong for a loopback capture
            // and is not. The capture is the machine's whole output mix, and that mix
            // contains the CALL — everyone else's voices, playing out of this machine.
            // AEC is the only thing removing them, so turning it off sends the room
            // back to itself and every viewer hears their own voice returned through
            // the stream. That shipped in 0.1.41 and is what this comment exists to
            // stop happening again. Headphones do not help: the loopback is taken from
            // the render mix, not from a microphone.
            //
            // Noise suppression and auto gain are a different matter and stay OFF: NS
            // treats sustained music as noise and gates it, AGC flattens a film's
            // dynamic range into a pump, and neither has anything to do with the
            // feedback loop above.
            //
            // The cost is mono — Chromium's echo canceller downmixes — so a system mix
            // is carried as one channel. Getting stereo back means capturing the shared
            // APPLICATION's audio rather than the whole system mix, which is what
            // Discord does and what Electron's desktopCapturer cannot currently express.
            // That is the real fix, and it is a feature, not a constraint tweak.
            //
            // channelCount is asked for anyway, and IDEAL rather than exact. It is the
            // half that was missing: opusStereo has been set on the codec for releases
            // while the capture never requested two channels, so the stereo was only
            // ever nominal. Today the AEC downmix wins and this is inert; the moment a
            // path exists that does not downmix it becomes correct with no further
            // change. Exact would be a share-killer — an unsatisfiable exact constraint
            // fails the whole getDisplayMedia() call rather than degrading.
            audio: {
                echoCancellation: true,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: { ideal: 2 },
            },
        },
        // ONE LAYER. VP9 K-SVC was tried here in 0.1.41 — 'L2T3_KEY' for detail,
        // 'L3T3_KEY' for motion — and every viewer got a black picture while the audio
        // from the same share played fine. Signalling was healthy end to end: producers
        // made, consumers made, packets moving. So the frames arrived and could not be
        // decoded, which points at the SVC layer selection rather than at anything in
        // the transport.
        //
        // It is worth having: with a single encoding the SFU has no smaller rung to move
        // a struggling viewer to, so one bad connection drags the encoder down for
        // everybody. But it goes back in behind a real two-machine test, not on
        // reasoning — that is exactly how it shipped broken the first time.
        //
        // maxFramerate starts at the chosen target rather than uncapped, so the seconds
        // before the source's real cadence is known are conservative instead of a 1080p
        // spike. voice.js snaps it once the stats settle.
        encodings: [{ maxBitrate: p.maxBitrate, ...(p.fps ? { maxFramerate: p.fps } : {}) }],
        contentHint: prefer === 'motion' ? 'motion' : 'detail',
        /** The soft target voice.js snaps against, null when the preset declines to cap. */
        targetFramerate: p.fps,
    };
}

/**
 * The camera's simulcast ladder — three rungs the SFU picks between per viewer.
 *
 * It follows the chosen resolution, which it did not used to: a fixed 720p-shaped budget
 * against a 1080p capture spends the encoder's bits on pixels no viewer can resolve at
 * that bitrate, so choosing "sharper" made the picture softer.
 */
export function cameraEncodings({ res = '720' } = {}) {
    return res === '1080'
        ? [{ scaleResolutionDownBy: 4, maxBitrate: 250_000 },
            { scaleResolutionDownBy: 2, maxBitrate: 800_000 },
            { scaleResolutionDownBy: 1, maxBitrate: 2_500_000 }]
        : [{ scaleResolutionDownBy: 4, maxBitrate: 150_000 },
            { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
            { scaleResolutionDownBy: 1, maxBitrate: 1_800_000 }];
}

/** The camera's own ladder is simpler: two sizes, two rates. */
export function cameraConstraints({ device = null, res = '720', fps = 30 } = {}) {
    const height = res === '1080' ? 1080 : 720;
    return {
        ...(device ? { deviceId: { exact: device } } : {}),
        width: { ideal: Math.round(height * (16 / 9)) },
        height: { ideal: height },
        frameRate: { ideal: Number(fps) || 30 },
    };
}
