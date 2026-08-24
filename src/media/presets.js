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
            audio: true,
        },
        encodings: [{ maxBitrate: p.maxBitrate }],
        contentHint: prefer === 'motion' ? 'motion' : 'detail',
    };
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
