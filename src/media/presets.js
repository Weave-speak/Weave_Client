// Stream quality presets: the same ladder Discord trained everyone on, minus the
// paywall. Each preset decides three things together — capture caps, encoder budget,
// and the tie-breaker for when the encoder cannot have both sharpness and smoothness.

/** The user-facing ladder. 'source' captures at native size, budget permitting. */
export const STREAM_PRESETS = Object.freeze({
    '720p30': { label: '720p · 30fps', width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 },
    '1080p30': { label: '1080p · 30fps', width: 1920, height: 1080, fps: 30, maxBitrate: 4_000_000 },
    '1080p60': { label: '1080p · 60fps', width: 1920, height: 1080, fps: 60, maxBitrate: 6_000_000 },
    source: { label: 'Source — your screen as it is', width: null, height: null, fps: 60, maxBitrate: 8_000_000 },
});

export const DEFAULT_STREAM_PRESET = '1080p30';

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
                frameRate: { ideal: p.fps, max: p.fps },
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
            audio: {
                echoCancellation: true,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
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
        encodings: [{ maxBitrate: p.maxBitrate }],
        contentHint: prefer === 'motion' ? 'motion' : 'detail',
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
