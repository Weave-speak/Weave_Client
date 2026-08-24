// The stage: everyone's video, above the chat that never leaves.
//
// Tiles for every live camera and screen in the room, yours included. Clicking a tile
// focuses it — one big picture, the rest in a strip — because a shared screen is usually
// THE thing and faces are company. The chat stays mounted below whatever happens here:
// that is the requirement, and it is why the stage is a region of the room rather than a
// mode that replaces it.
//
// Pure markup. Streams are attached by the controller AFTER paint, because a view that
// touched srcObject would not be a view.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { userHue } from '../../ui/hue.js';

export const tileKey = (cid, slot) => `${cid}:${slot}`;

/**
 * Order: focused first is not needed (CSS handles focus), but screens before cameras —
 * a screen is content, a camera is presence — and self last within each kind, because
 * your own face is the least informative thing on your screen.
 */
export function orderTiles(tiles) {
    const rank = (t) => (t.slot === 'screen' ? 0 : 1) * 2 + (t.self ? 1 : 0);
    return [...tiles].sort((a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key)));
}

/** The identity chip every thumbnail wears: mini avatar, kind glyph, name. */
const identityChip = (t) => `
  <span class="tile-chip">
    <span class="tile-chip-face" style="--av: hsl(${esc(userHue(t.chipName ?? t.label))}, 55%, 40%)">${esc(initialsOf(t.chipName ?? t.label))}</span>
    ${t.slot === 'screen' ? icons.screen : icons.camera}
    <span>${esc(t.label)}</span>
  </span>`;

const initialsOf = (name) => String(name ?? '?').trim().slice(0, 2).toUpperCase();

/** The focused stream's floating pill: listen controls, fullscreen, the way out. */
const streamPill = (t) => `
  <span class="stream-pill">
    ${t.self || !t.audio ? '' : `
    <button type="button" class="pill-btn" data-listen-mute
            title="${t.audio.muted ? 'Unmute for you' : 'Mute for you'}"
            aria-pressed="${t.audio.muted ? 'true' : 'false'}"
            aria-label="${t.audio.muted ? 'Unmute this stream for you' : 'Mute this stream for you'}">
      ${t.audio.muted ? icons.speakerOff : icons.speaker}
    </button>
    <input type="range" class="pill-volume" data-listen-volume min="0" max="100"
           value="${Math.round((t.audio.volume ?? 1) * 100)}"
           aria-label="Volume of this stream, for you only">
    <span class="pill-sep" aria-hidden="true"></span>`}
    <button type="button" class="pill-btn" data-tile-full
            title="Fullscreen — press again to leave" aria-label="Toggle fullscreen">${icons.expand}</button>
    <span class="pill-sep" aria-hidden="true"></span>
    <button type="button" class="pill-btn pill-stop" data-stop-watching
            aria-label="Stop watching — show all streams as thumbnails">
      <span aria-hidden="true">✕</span>&nbsp;Stop watching
    </button>
  </span>`;

const tile = (t, focusKey) => {
    const focused = t.key === focusKey;
    return `
  <div class="tile${focused ? ' focused' : ''}${t.self ? ' self' : ''}"
       data-tile="${esc(t.key)}" role="button" tabindex="0"
       aria-label="${esc(t.label)}${t.slot === 'screen' ? "'s screen" : ''}${focused ? ', focused' : ''}">
    <video autoplay playsinline ${t.self ? 'muted' : ''}></video>
    ${focused ? `
    <span class="live-badge"><i aria-hidden="true"></i>LIVE · ${esc(t.label)}</span>
    ${streamPill(t)}` : `
    ${t.slot === 'screen' ? '<span class="live-badge small"><i aria-hidden="true"></i>LIVE</span>' : ''}
    ${identityChip(t)}
    ${focusKey ? '' : `
    <span class="tile-bar">
      <span class="tile-bar-spacer"></span>
      <span class="watch-cue">Watch ${icons.expand}</span>
    </span>`}`}
  </div>`;
};

/**
 * The stage. Empty tiles array renders nothing at all — the room looks exactly as it
 * always did until the first camera or screen arrives.
 */
export function stageView({ tiles = [], focus = null, heightPx = null } = {}) {
    if (!tiles.length) return '';
    const ordered = orderTiles(tiles);
    const focusKey = ordered.some((t) => t.key === focus) ? focus : null;

    return `
    <section class="stage${focusKey ? ' has-focus' : ''}" aria-label="Live video"${heightPx ? ` style="height: ${Math.round(heightPx)}px"` : ''}>
      ${focusKey ? `
      <div class="stage-main">${tile(ordered.find((t) => t.key === focusKey), focusKey)}</div>
      ${ordered.length > 1 ? `
      <div class="stage-strip">${ordered.filter((t) => t.key !== focusKey).map((t) => tile(t, focusKey)).join('')}</div>` : ''}
      ` : `
      <div class="stage-grid" data-count="${Math.min(ordered.length, 9)}">
        ${ordered.map((t) => tile(t, focusKey)).join('')}
      </div>`}
    </section>
    <div class="stage-divider" data-stage-divider role="separator" aria-orientation="horizontal"
         title="Drag to resize"><span></span></div>`;
}

/* ── choosing what to share ───────────────────────────────────────────────── */

/**
 * The desktop share picker. Thumbnails come from the main process's own capture of the
 * screens — trusted pixels — but every NAME is a window title, which is arbitrary text
 * from arbitrary apps, so it is escaped like anything else.
 */
export function sharePickerView({ sources = [] } = {}) {
    const screens = sources.filter((s) => s.kind === 'screen');
    const windows = sources.filter((s) => s.kind !== 'screen');
    const card = (s) => `
      <button type="button" class="share-source" data-share-source="${esc(s.id)}">
        <img src="${esc(s.thumb)}" alt="">
        <span class="share-name">${esc(s.name)}</span>
      </button>`;

    return `
    <div class="share-picker">
      <header class="browser-head">
        <div>
          <h2 class="panel-title">Share your screen</h2>
          <p class="panel-lead">Everyone in the room will see it. Chat stays alongside.</p>
        </div>
        <span class="browser-spacer"></span>
        <button type="button" class="icon-btn" data-share-cancel aria-label="Cancel">✕</button>
      </header>

      ${screens.length ? `<h3 class="panel-section">Screens</h3>
      <div class="share-grid">${screens.map(card).join('')}</div>` : ''}
      ${windows.length ? `<h3 class="panel-section">Windows</h3>
      <div class="share-grid">${windows.map(card).join('')}</div>` : ''}

      <label class="check-row share-audio">
        <input type="checkbox" id="shareAudio" checked>
        <span>Share computer audio <em>— game sound, music, video</em></span>
      </label>
    </div>`;
}
