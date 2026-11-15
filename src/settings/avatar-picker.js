// The DOM half of choosing a profile picture — and a banner, which is the same gesture on a
// wider frame.
//
// Everything here is positioning and events; every number it relies on comes from
// avatar-crop.js, which is pure and tested. That split is deliberate — the arithmetic is
// the part that can be wrong in a way nobody sees, and it should not need a browser to
// check.
//
// The cropping happens on THIS machine and only the result is sent. That keeps a native
// image library off the Pi for something a canvas does in a millisecond, and it means the
// bytes stored are exactly the bytes the person framed rather than a server's later
// interpretation of them.

import {
    OUTPUT_PX, minimumScale, clampOffset, centredOffset, sourceBox, zoomAbout,
    scaleForPercent, MAX_ZOOM,
} from './avatar-crop.js';

/** Matches the avatar frame in shell.css. Read once rather than measured, so the maths is stable. */
const FRAME_PX = 220;

/**
 * A picture is re-encoded as WebP where the browser has it and PNG otherwise.
 *
 * A cropped square or strip is tens of kilobytes either way, so this is about the server's
 * sniffer recognising it rather than about size — both are on its accepted list.
 */
const OUTPUT_TYPE = 'image/webp';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root   where the cropper's elements are
 * @param {{w: number, h: number}} [opts.frame]   the crop frame on screen, as drawn in shell.css
 * @param {{w: number, h: number}} [opts.output]  the size stored
 * @param {(blob: Blob) => Promise<object>} [opts.upload]  where the bytes go
 * @param {string} [opts.attr]  the data- prefix of this cropper's elements, so two can share
 *                              one panel: `crop` for the picture, `banner-crop` for the banner
 */
export function createAvatarPicker({
    root, api, onSaved = () => {}, onError = () => {},
    frame = { w: FRAME_PX, h: FRAME_PX },
    output = { w: OUTPUT_PX, h: OUTPUT_PX },
    upload = (blob) => api.uploadAvatar(blob),
    attr = 'crop',
}) {
    let image = null;          // the loaded HTMLImageElement
    let objectUrl = null;      // its blob URL, released when the cropper closes
    let view = { scale: 1, x: 0, y: 0 };
    let saving = false;

    const $ = (selector) => root.querySelector(selector);

    const els = () => ({
        crop: $(`[data-${attr}]`),
        frame: $(`[data-${attr}-frame]`),
        img: $(`[data-${attr}-image]`),
        zoom: $(`[data-${attr}-zoom]`),
    });

    /** Push the current view onto the element. The only place transform is written. */
    function paint() {
        const { img } = els();
        if (!img || !image) return;
        img.style.width = `${image.naturalWidth}px`;
        img.style.height = `${image.naturalHeight}px`;
        img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }

    const dims = () => ({
        width: image?.naturalWidth ?? 0,
        height: image?.naturalHeight ?? 0,
        frameW: frame.w,
        frameH: frame.h,
    });

    function open(file) {
        close();
        objectUrl = URL.createObjectURL(file);
        image = new Image();
        image.onload = () => {
            const { crop, img, zoom } = els();
            const scale = minimumScale(dims());
            view = { scale, ...centredOffset({ ...dims(), scale }) };
            if (img) img.src = objectUrl;
            if (zoom) {
                zoom.min = '100';
                zoom.max = String(Math.round(MAX_ZOOM * 100));
                zoom.value = '100';
            }
            if (crop) crop.hidden = false;
            paint();
        };
        // A file that is not really an image never fires onload. Saying so here beats
        // showing an empty frame and waiting for the server to refuse it later.
        image.onerror = () => {
            close();
            onError('That file could not be opened as an image.');
        };
        image.src = objectUrl;
    }

    function close() {
        const { crop, img } = els();
        if (crop) crop.hidden = true;
        if (img) img.removeAttribute('src');
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        image = null;
    }

    /* ── dragging ────────────────────────────────────────────────────────── */

    function beginDrag(event) {
        if (!image) return;
        const frameEl = els().frame;
        // Where the pointer started, and where the picture was when it did. Both are
        // needed: the drag is a delta applied to the position at the moment of grabbing,
        // not an absolute position, or the picture would jump to the cursor.
        const from = { pointerX: event.clientX, pointerY: event.clientY, x: view.x, y: view.y };

        frameEl.classList.add('dragging');
        frameEl.setPointerCapture?.(event.pointerId);

        const move = (ev) => {
            view = {
                scale: view.scale,
                ...clampOffset({
                    x: from.x + (ev.clientX - from.pointerX),
                    y: from.y + (ev.clientY - from.pointerY),
                    ...dims(),
                    scale: view.scale,
                }),
            };
            paint();
        };

        const up = () => {
            frameEl.classList.remove('dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    function setZoom(percent) {
        if (!image) return;
        // Through scaleForPercent, because the slider is a multiple of "fills the frame"
        // rather than an absolute scale. Passing percent/100 straight in works only for
        // images small enough that covering the frame needs a scale above 1 — which is
        // almost no real photograph, and is exactly the shape of image a test reaches for.
        view = zoomAbout({ ...dims(), ...view, next: scaleForPercent({ percent, ...dims() }) });
        paint();
    }

    /* ── committing ──────────────────────────────────────────────────────── */

    /**
     * Draw the framed area at the stored size and hand back the bytes.
     *
     * Deliberately not the original resolution: an avatar is rendered at 42 pixels and at
     * most 512 when opened, a banner across a dialog, and storing a 12-megapixel photograph
     * to show it at either size costs everybody who ever loads the roster.
     */
    async function toBlob() {
        const rect = sourceBox({ ...dims(), ...view });
        const canvas = document.createElement('canvas');
        canvas.width = output.w;
        canvas.height = output.h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, output.w, output.h);

        const encode = (type, quality) => new Promise((resolve) => {
            canvas.toBlob(resolve, type, quality);
        });

        // A browser that cannot write the requested type hands back null rather than
        // throwing, and the upload would then post "null" as a string. PNG is universal.
        return (await encode(OUTPUT_TYPE, 0.92)) ?? encode('image/png');
    }

    async function save() {
        if (!image || saving) return;
        saving = true;
        try {
            const blob = await toBlob();
            if (!blob) throw new Error('This browser could not encode the picture.');
            const result = await upload(blob);
            close();
            onSaved(result);
        } catch (err) {
            onError(err?.message ?? 'The picture could not be saved.');
        } finally {
            saving = false;
        }
    }

    return { open, close, save, setZoom, beginDrag, get isOpen() { return Boolean(image); } };
}
