// Keeping the window on the monitor it lands on.
//
// Windows keeps a window's LOGICAL size when it crosses to a monitor with a different scale,
// and Electron does nothing about it. A 1280×820 window dragged from a 1440p screen at 100%
// onto a 1366×768 laptop at 125% (1093×566 usable) is still 1280×820 there. Its bottom
// edge — the self bar, with mic, deafen, camera, screen share and leave — went under the
// taskbar or off the screen, and no amount of dragging brought it back, because the window
// was taller than the screen. That was the report: the share button "barely visible".
//
// Only a window that does not FIT its display is corrected. One that fits but hangs off an
// edge is left where it is: people park a window half off-screen on purpose, and a window
// stretched across two monitors is a choice rather than an accident. Those can be dragged
// back by hand; a window bigger than the screen cannot.
//
// Pure, so the geometry is testable without Electron; app.js decides when to ask.

/** Weave's own minimum, below which the layout stops being a layout. */
export const MIN_SIZE = Object.freeze({ width: 620, height: 480 });

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * The window resized and moved to fit a display's work area, or null when it already fits.
 *
 * @param {{x:number, y:number, width:number, height:number}} bounds    the window, in DIP
 * @param {{x:number, y:number, width:number, height:number}} workArea  the display it is
 *   mostly on, less the taskbar — Electron's `display.workArea`
 * @returns {{x:number, y:number, width:number, height:number} | null}
 */
export function fitBounds(bounds, workArea) {
    if (bounds.width <= workArea.width && bounds.height <= workArea.height) return null;
    // Down, never up: a size rounded up would not fit by a fraction of a pixel.
    const width = Math.floor(Math.min(bounds.width, workArea.width));
    const height = Math.floor(Math.min(bounds.height, workArea.height));
    // Once it has to be resized anyway it is brought wholly onto the display: half a
    // corrected window is the same complaint.
    return {
        x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)),
        y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)),
        width,
        height,
    };
}

/**
 * The minimum window size, capped by what the display can hold. A 1366×768 laptop at 150%
 * has 464px of work area; a 480px minimum there meant even the smallest Weave did not fit.
 */
export function minimumSizeFor(workArea, floor = MIN_SIZE) {
    return {
        width: Math.floor(Math.min(floor.width, workArea.width)),
        height: Math.floor(Math.min(floor.height, workArea.height)),
    };
}
