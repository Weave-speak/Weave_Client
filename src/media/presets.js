// Screen share presets: what a share asks for, chosen fresh every time.
//
// A share is two decisions, asked together just before the screen picker — the same two the
// web app asks. How much picture (a quality tier: size and bitrate), and what kind of picture
// (video or text: frame rate and the encoder's tie-breaker). They used to be a pair of
// settings buried in Settings → Voice, which nobody revisited between sharing a game and
// sharing a spreadsheet, and which are two very different streams.
//
// The titles and descriptions live here rather than in the view, so the chooser and anything
// else that names a tier cannot disagree about what "High" means.

/**
 * How much picture. Size is a CEILING on the capture, never a target — see
 * screenShareSettings — and 'source' names none at all.
 *
 * Bitrates are the web app's. They are a budget for the video alone; the server's
 * per-participant cap (WEAVE_MAX_INCOMING_BITRATE) has to leave room for the microphone, the
 * share's audio and a webcam beside it, which is why that default is 16 Mb/s.
 */
export const SHARE_QUALITIES = Object.freeze({
    '720p': { title: 'Smooth', sub: '720p · ~2.5 Mbps', width: 1280, height: 720, maxBitrate: 2_500_000 },
    '1080p': { title: 'Balanced', sub: '1080p · ~5 Mbps', width: 1920, height: 1080, maxBitrate: 5_000_000 },
    '1440p': { title: 'High', sub: '1440p · ~8 Mbps', width: 2560, height: 1440, maxBitrate: 8_000_000 },
    source: { title: 'Source', sub: 'Your screen as it is · ~8 Mbps', width: null, height: null, maxBitrate: 8_000_000 },
});

/**
 * What kind of picture.
 *
 * `fps` is a TARGET, not a ceiling. What actually reaches the encoder is whatever
 * `bestFitFramerate` snaps it to once the source's real cadence is known.
 *
 * `contentHint` is the honest trade-off when the encoder cannot have both: 'motion' keeps the
 * frame rate and lets pixels soften, 'text' keeps every glyph sharp and drops frames instead.
 * 'text' rather than the older 'detail' because it is the more specific hint — it also tells
 * the encoder not to smooth away the hard edges that make small type readable.
 */
export const SHARE_CONTENT = Object.freeze({
    video: { title: 'Video', sub: 'Games, movies, motion · up to 60fps', fps: 60, contentHint: 'motion' },
    text: { title: 'Text', sub: 'Docs, code, websites · up to 30fps', fps: 30, contentHint: 'text' },
});

export const DEFAULT_SHARE_QUALITY = '1080p';
export const DEFAULT_SHARE_CONTENT = 'video';

/** A choice with anything unrecognised replaced by the default, so a stale value cannot break a share. */
export function normaliseShareChoice({ quality, content } = {}) {
    return {
        quality: Object.hasOwn(SHARE_QUALITIES, quality) ? quality : DEFAULT_SHARE_QUALITY,
        content: Object.hasOwn(SHARE_CONTENT, content) ? content : DEFAULT_SHARE_CONTENT,
    };
}

/**
 * The share choice implied by the settings this chooser replaced.
 *
 * Somebody who spent a release on 1080p60 should find the chooser open on Balanced + Video,
 * not on whatever the new default happens to be. Returns null when there is nothing to carry
 * over, so the caller can tell "never chose" from "chose the default".
 */
export function legacyShareChoice({ streamPreset = null, streamPrefer = null } = {}) {
    if (streamPreset == null && streamPrefer == null) return null;
    const quality = { '720p30': '720p', '1080p30': '1080p', '1080p60': '1080p', source: 'source' }[streamPreset]
        ?? DEFAULT_SHARE_QUALITY;
    // 1080p60 was the games preset, and 'motion' was an explicit ask for smoothness. Anything
    // else was the old default of keeping text readable.
    const content = streamPreset === '1080p60' || streamPrefer === 'motion' ? 'video' : 'text';
    return { quality, content };
}

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
 * Everything one share needs, from the two choices made just before it.
 *
 * Size is `max`, not `ideal` as the web app has it: an ideal asks the capturer to reach that
 * size, which scales a smaller screen UP and spends bitrate on pixels that were never there.
 */
export function screenShareSettings(choice = {}) {
    const { quality, content } = normaliseShareChoice(choice);
    const q = SHARE_QUALITIES[quality];
    const c = SHARE_CONTENT[content];
    return {
        constraints: {
            video: {
                // The chosen rate is NOT here on purpose; see CAPTURE_FPS_CEILING.
                frameRate: { max: CAPTURE_FPS_CEILING },
                ...(q.width ? { width: { max: q.width }, height: { max: q.height } } : {}),
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
        encodings: [{ maxBitrate: q.maxBitrate, maxFramerate: c.fps }],
        contentHint: c.contentHint,
        /** The soft target voice.js snaps against. */
        targetFramerate: c.fps,
        /** The choice this was built from, normalised — what a quality report should name. */
        choice: { quality, content },
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
