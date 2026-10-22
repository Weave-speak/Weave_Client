// Bubbles, as markup: the small conversation a bubble opens into, and the list of every
// bubble, floating or not.
//
// Pure, like every view here. The photos arrive as URLs already resolved by the room's
// photo cache, because they are behind the session and a view must never fetch.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { messageList } from './timeline.js';

/** A bubble's face: the photo once it has arrived, a coloured circle until then. */
const face = (photoUrl, size = '') => (photoUrl
    ? `<span class="bubble-thumb ${size}" style="background-image: url(&quot;${esc(photoUrl)}&quot;)"></span>`
    : `<span class="bubble-thumb ${size} empty" aria-hidden="true">${icons.bubbles}</span>`);

/**
 * One bubble's conversation, as a small floating card. The message rows are the timeline's
 * own, so a bubble reads exactly like a channel does.
 */
export function bubblePopupView({ bubble = {}, photoUrl = null, items = [], loading = false, error = '' } = {}) {
    return `
    <div class="bubble-popup" role="dialog" aria-label="${esc(bubble.name ?? 'Bubble')}" data-bubble-popup="${esc(bubble.id ?? '')}">
      <header class="bubble-popup-head">
        ${face(photoUrl, 'lg')}
        <span class="bubble-popup-name">${esc(bubble.name ?? '')}</span>
        <button type="button" class="icon-btn" data-bubble-close aria-label="Close">✕</button>
      </header>
      <div class="bubble-popup-body">
        ${loading ? '<p class="bubble-popup-note">Loading…</p>'
        : items.length ? `<ol class="msg-list">${messageList(items)}</ol>`
            : '<p class="bubble-popup-note">Nothing said here yet. Start it off.</p>'}
      </div>
      ${error ? `<p class="bubble-popup-note error">${esc(error)}</p>` : ''}
      <form class="bubble-popup-composer" data-bubble-composer>
        <button type="button" class="composer-btn" data-bubble-attach aria-label="Send a picture">${icons.image}</button>
        <input class="bubble-popup-input" data-bubble-input maxlength="2000" autocomplete="off"
               placeholder="Say something in ${esc(bubble.name ?? 'this bubble')}…"
               aria-label="Message ${esc(bubble.name ?? 'this bubble')}">
        <button type="submit" class="composer-btn send" aria-label="Send">${icons.send}</button>
      </form>
    </div>`;
}

/** Every bubble on the server, so one that is not floating right now can still be opened. */
export function allBubblesView({ bubbles = [] } = {}) {
    return `
    <div class="all-bubbles">
      <h2 class="panel-title">Bubbles</h2>
      <p class="panel-lead">A few drift over the chat at a time. Every one is here, floating or not.</p>
      ${bubbles.length ? `
      <ul class="all-bubbles-list">
        ${bubbles.map((b) => `
        <li>
          <button type="button" class="all-bubbles-row" data-open-bubble="${esc(b.id)}">
            ${face(b.photoUrl)}
            <span class="all-bubbles-name">${esc(b.name)}</span>
            ${b.floating ? '<span class="all-bubbles-tag">floating</span>' : ''}
            ${b.unread ? '<span class="all-bubbles-unread" title="Something new">new</span>' : ''}
          </button>
        </li>`).join('')}
      </ul>` : '<p class="panel-lead">There are no bubbles yet. An administrator makes them in Settings → Admin → Bubbles.</p>'}
      <div class="whats-new-actions"><button type="button" class="btn" data-all-bubbles-close>Close</button></div>
    </div>`;
}
