// Choosing which part of a picture is your face.
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

/** The stored square. Big enough for a retina 42px avatar many times over, small enough to post. */
export const OUTPUT_PX = 256;

/**
 * The scale at which the picture exactly fills the frame.
 *
 * "Cover", not "contain": a portrait must never be letterboxed inside a circle, because
 * the gap is not empty space, it is a visible ring of background where a face should be.
 */
export function minimumScale({ width, height, frame }) {
    if (!width || !height || !frame) return 1;
    return Math.max(frame / width, frame / height);
}

/**
 * Keep the picture covering the frame.
 *
 * Without this a drag can be flung past the edge and leave a wedge of nothing inside the
 * circle. Clamping during the drag rather than on release is deliberate: a picture that
 * springs back when you let go feels broken, one that simply stops at the edge does not.
 */
export function clampOffset({ x, y, width, height, scale, frame }) {
    const w = width * scale;
    const h = height * scale;
    // When the picture is smaller than the frame on an axis there is exactly one position
    // that covers it, so min and max collapse to the same number and it is centred.
    const minX = Math.min(0, frame - w);
    const minY = Math.min(0, frame - h);
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
export const centredOffset = ({ width, height, scale, frame }) => ({
    x: (frame - width * scale) / 2,
    y: (frame - height * scale) / 2,
});

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
export function scaleForPercent({ percent, width, height, frame }) {
    const lowest = minimumScale({ width, height, frame });
    const wanted = (Number(percent) || 100) / 100;
    return lowest * Math.max(1, Math.min(MAX_ZOOM, wanted));
}

/** The slider position that matches a scale. The inverse, for putting the thumb back. */
export function percentForScale({ scale, width, height, frame }) {
    const lowest = minimumScale({ width, height, frame });
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
 * What a wheel notch or a slider does to the scale, keeping the frame's CENTRE fixed.
 *
 * Zooming about the top-left — which is what happens if the offset is left alone — walks
 * the subject out of the frame after two or three notches, and the person compensates by
 * dragging, which feels like fighting the control rather than using it.
 */
export function zoomAbout({ scale, next, x, y, frame, width, height }) {
    const lowest = minimumScale({ width, height, frame });
    const clamped = Math.max(lowest, Math.min(lowest * MAX_ZOOM, next));
    const ratio = clamped / scale;
    const centre = frame / 2;
    return {
        scale: clamped,
        ...clampOffset({
            x: centre - (centre - x) * ratio,
            y: centre - (centre - y) * ratio,
            width, height, scale: clamped, frame,
        }),
    };
}

/** How far past "fills the frame" a picture may be enlarged. */
export const MAX_ZOOM = 4;
