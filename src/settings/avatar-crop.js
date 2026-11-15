// Choosing which part of a picture is your face — or, for a banner, which strip of it.
//
// The arithmetic is here, on its own, because it is the part that is easy to get subtly
// wrong and impossible to eyeball: an off-by-one in the source rectangle shows up as a
// picture that drifts a few pixels when saved, which looks like nothing until somebody
// compares the crop frame with the result. Everything in this half is a pure function of
// numbers, so it is tested without a canvas, a DOM or an image.
//
// The model is the one every crop tool uses and the one a hand expects: the FRAME is
// fixed and the picture moves under it. Offsets are in displayed pixels, measured from
// the frame's top-left to the picture's top-left, so dragging right increases x.
//
// The frame is a square for a profile picture and a 4:1 strip for a banner. Every function
// takes either `frame` (a square, as it always has) or `frameW` and `frameH`, so the avatar
// code and its tests did not change shape when the banner arrived.

/**
 * The stored square. Big enough for a retina 42px avatar many times over, and for a profile
 * picture opened full size, which is shown at up to 512px — at the old 256 it looked soft
 * there. Still a few tens of kilobytes as WebP.
 */
export const OUTPUT_PX = 512;

/** The two sides of the frame, from whichever way the caller described it. */
const box = ({ frame, frameW, frameH }) => ({ fw: frameW ?? frame, fh: frameH ?? frame });

/**
 * The scale at which the picture exactly fills the frame.
 *
 * "Cover", not "contain": a portrait must never be letterboxed inside a circle, because
 * the gap is not empty space, it is a visible ring of background where a face should be.
 * The same holds for a banner — an empty band down one side reads as a broken picture.
 */
export function minimumScale({ width, height, ...f }) {
    const { fw, fh } = box(f);
    if (!width || !height || !fw || !fh) return 1;
    return Math.max(fw / width, fh / height);
}

/**
 * Keep the picture covering the frame.
 *
 * Without this a drag can be flung past the edge and leave a wedge of nothing inside the
 * circle. Clamping during the drag rather than on release is deliberate: a picture that
 * springs back when you let go feels broken, one that simply stops at the edge does not.
 */
export function clampOffset({ x, y, width, height, scale, ...f }) {
    const { fw, fh } = box(f);
    const w = width * scale;
    const h = height * scale;
    // When the picture is smaller than the frame on an axis there is exactly one position
    // that covers it, so min and max collapse to the same number and it is centred.
    const minX = Math.min(0, fw - w);
    const minY = Math.min(0, fh - h);
    return {
        x: Math.min(0, Math.max(minX, x)),
        y: Math.min(0, Math.max(minY, y)),
    };
}

/**
 * Where the picture should sit to be centred in the frame at this scale.
 *
 * The starting position, so opening the cropper shows the middle of the photograph rather
 * than its top-left corner.
 */
export function centredOffset({ width, height, scale, ...f }) {
    const { fw, fh } = box(f);
    return { x: (fw - width * scale) / 2, y: (fh - height * scale) / 2 };
}

/**
 * The absolute scale a zoom slider position means.
 *
 * The slider is RELATIVE to "fills the frame", not to the image's own pixels: 100% is
 * whatever scale covers the circle, 400% is four times that. Reading it as an absolute
 * scale is a bug that hides completely behind a small test image and then does nothing at
 * all on a real photograph.
 *
 * A 3000x2000 photo covers a 220px frame at 0.11, so its zoom ceiling is 0.44 — while an
 * absolute slider asks for 1.0 through 4.0, every one of which clamps to that same 0.44.
 * The control moves, the picture does not, and nothing anywhere reports a problem.
 */
export function scaleForPercent({ percent, width, height, ...f }) {
    const lowest = minimumScale({ width, height, ...f });
    const wanted = (Number(percent) || 100) / 100;
    return lowest * Math.max(1, Math.min(MAX_ZOOM, wanted));
}

/** The slider position that matches a scale. The inverse, for putting the thumb back. */
export function percentForScale({ scale, width, height, ...f }) {
    const lowest = minimumScale({ width, height, ...f });
    if (!lowest) return 100;
    return Math.round((scale / lowest) * 100);
}

/**
 * The rectangle of the ORIGINAL image that the frame is currently showing.
 *
 * This is the whole point of the file. The frame shows displayed pixels; the canvas needs
 * source pixels, and the conversion is the one place a rounding mistake becomes a visible
 * shift between what was framed and what was saved.
 */
export function sourceRect({ width, height, scale, x, y, frame }) {
    const size = frame / scale;
    return {
        sx: Math.max(0, Math.min(width - size, -x / scale)),
        sy: Math.max(0, Math.min(height - size, -y / scale)),
        size: Math.min(size, Math.min(width, height)),
    };
}

/**
 * The same, for a frame that is not square: the banner's strip.
 *
 * Its own function rather than a wider sourceRect, because a square crop has one side and
 * the canvas call that draws it says so; giving the avatar path two numbers that must always
 * be equal is an invitation for them one day not to be.
 */
export function sourceBox({ width, height, scale, x, y, ...f }) {
    const { fw, fh } = box(f);
    const sw = Math.min(fw / scale, width);
    const sh = Math.min(fh / scale, height);
    return {
        sx: Math.max(0, Math.min(width - sw, -x / scale)),
        sy: Math.max(0, Math.min(height - sh, -y / scale)),
        sw,
        sh,
    };
}

/**
 * What a wheel notch or a slider does to the scale, keeping the frame's CENTRE fixed.
 *
 * Zooming about the top-left — which is what happens if the offset is left alone — walks
 * the subject out of the frame after two or three notches, and the person compensates by
 * dragging, which feels like fighting the control rather than using it.
 */
export function zoomAbout({ scale, next, x, y, width, height, ...f }) {
    const { fw, fh } = box(f);
    const lowest = minimumScale({ width, height, ...f });
    const clamped = Math.max(lowest, Math.min(lowest * MAX_ZOOM, next));
    const ratio = clamped / scale;
    const cx = fw / 2;
    const cy = fh / 2;
    return {
        scale: clamped,
        ...clampOffset({
            x: cx - (cx - x) * ratio,
            y: cy - (cy - y) * ratio,
            width, height, scale: clamped, ...f,
        }),
    };
}

/** How far past "fills the frame" a picture may be enlarged. */
export const MAX_ZOOM = 4;
