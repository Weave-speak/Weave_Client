// Whether the room's animations run, and how fast.
//
// The strands, the loom and the drifting bubbles are decoration, and decoration has to
// justify its cost against whatever else the machine is doing — which, for a voice client,
// is usually a game in the window on top of this one. Three things can say "not now", and
// before this module two of them were scattered through the room and the third did not
// exist:
//
//   - the preference ("Still background"),
//   - a tile in fullscreen, where they are behind an opaque video regardless,
//   - the window not being on screen at all.
//
// The last one needs saying out loud. The renderers pause themselves on `visibilitychange`,
// and in a browser tab that is enough. In the desktop shell it is not: the window runs with
// `backgroundThrottling: false` so the audio meters keep time behind a game, and Electron
// documents that switch as affecting the Page Visibility API too — a minimised window can
// go on reporting itself visible. So the shell tells the room what the window is doing, and
// the answer arrives here.
//
// Pure, so the whole policy can be asserted on without a window.

/**
 * The room background's rate while the window is in front.
 *
 * Thirty, not sixty: the strands drift at a few pixels a frame at their liveliest, each one
 * is a shadow-blurred stroke across the whole room, and the canvas is the size of the window.
 * Halving it is invisible; the cost is not.
 */
export const BACKGROUND_FPS = 30;

/**
 * And while another window has the focus — Weave on a second monitor beside a game.
 *
 * Twenty is the floor rather than a taste: the background clamps a frame's step to 50 ms, so
 * anything slower would run the weave slow as well as choppy.
 */
export const BACKGROUND_UNFOCUSED_FPS = 20;

/**
 * The loom, always. The traces that feed it decay per frame and were tuned at sixty
 * (voice-trace.js), so this is the rate at which it is CORRECT, not merely affordable — and
 * it is why the loom does not slow down with the background when focus goes elsewhere.
 */
export const LOOM_FPS = 60;

/**
 * @param {object} now
 * @param {boolean} [now.staticBackground] the "Still background" preference
 * @param {boolean} [now.fullscreen]       a tile is in fullscreen
 * @param {boolean} [now.windowVisible]    the window is on screen (not minimised, not hidden)
 * @param {boolean} [now.windowFocused]    and it is the one being used
 * @returns {{run: boolean, backgroundFps: number, loomFps: number}}
 *          `run` covers all three animations. Bubbles that are not running stay where they
 *          are, still clickable — still is not gone.
 */
export function motionPlan({
    staticBackground = false,
    fullscreen = false,
    windowVisible = true,
    windowFocused = true,
} = {}) {
    return {
        run: !staticBackground && !fullscreen && windowVisible,
        backgroundFps: windowFocused ? BACKGROUND_FPS : BACKGROUND_UNFOCUSED_FPS,
        loomFps: LOOM_FPS,
    };
}
