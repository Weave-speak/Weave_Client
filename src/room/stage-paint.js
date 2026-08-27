// When the stage may redraw itself.
//
// Painting the stage means writing innerHTML, which throws away every tile and builds new
// ones. That is fine as a way to render, and ruinous as a thing to do on a timer: each
// rebuild re-creates every <video> and re-attaches its srcObject, and — the reason this
// module exists — detaching an element that is in fullscreen is precisely how a browser is
// told to LEAVE fullscreen. A viewer watching a shared screen full-window was therefore
// ejected by the next repaint, which the heartbeat guarantees within 25 seconds.
//
// So a repaint asks two questions first: has anything actually changed, and would drawing
// it now throw the viewer out of fullscreen. Both answers are pure functions of state,
// which is what lets them be tested without a browser.

/**
 * Everything the rendered stage depends on, flattened to a comparable string.
 *
 * `frame` is a data URL — potentially tens of kilobytes — so it contributes its LENGTH
 * rather than its value. That is safe rather than merely cheap: a frame is only ever
 * captured when a tile stops being live, and `live` is in the signature already, so a
 * changed frame cannot slip through without some other field moving too.
 */
export function stageSignature({ tiles = [], focus = null, heightPx = null } = {}) {
    return JSON.stringify([
        focus,
        heightPx,
        tiles.map((t) => [
            t.key, t.label, t.chipName, t.slot, Boolean(t.self), Boolean(t.live),
            t.frame ? t.frame.length : 0,
            t.audio ? [t.audio.slot, Boolean(t.audio.muted), t.audio.volume ?? null] : null,
        ]),
    ]);
}

/**
 * 'skip'  — the stage already shows this exact state; rebuilding it would only restart
 *           every video element.
 * 'defer' — something changed, but the viewer is in fullscreen on a tile that is still
 *           live. Drawing now would eject them. Hold it until they leave.
 * 'paint' — draw.
 *
 * A fullscreen tile that is no longer live returns 'paint' deliberately: the stream it was
 * showing has ended, and dropping out of fullscreen is then the honest outcome rather than
 * leaving someone staring at a frozen frame.
 */
export function stagePaintDecision({
    signature,
    lastSignature = null,
    hasChildren = false,
    fullscreenKey = null,
    tiles = [],
} = {}) {
    if (signature === lastSignature && hasChildren) return 'skip';
    if (fullscreenKey && tiles.some((t) => t.key === fullscreenKey && t.live)) return 'defer';
    return 'paint';
}
