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
            // Stated rather than left to the engine. `audio: true` accepted the
            // getUserMedia defaults, and those defaults are written for a MICROPHONE:
            // echo cancellation subtracts the very thing a loopback capture is
            // capturing, noise suppression treats sustained music as noise and gates
            // it, and auto gain flattens a film's dynamic range into a pump. Stereo is
            // asked for because a system mix IS stereo, and until now the opusStereo we
            // set at produce time had only mono to work with.
            //
            // These are advisory — Electron's loopback path and each browser honour them
            // to different degrees — but stating them costs nothing and takes the
            // guesswork out of the next report of "the stream sounds underwater".
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
            },
        },
        // One VP9 stream carrying several layers, rather than one flat layer. This is the
        // change that stops one person on hotel wifi ruining the share for everybody: with
        // a single encoding the SFU has nothing smaller to give them, so their congestion
        // controller drags the whole encoder down. '_KEY' is K-SVC — inter-layer
        // prediction on key frames only — which is what lets the SFU move a viewer between
        // layers without forcing a full refresh on everyone else.
        //
        // The mode follows the same setting as the content hint because it answers the
        // same question one level up: what should survive when the link tightens.
        encodings: [{
            maxBitrate: p.maxBitrate,
            scalabilityMode: prefer === 'motion' ? 'L3T3_KEY' : 'L2T3_KEY',
        }],
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
