// The left rail: direct messages.
//
// One tile per conversation, plus a home tile that returns to the room you are in. The
// unread count sits on the tile corner and is capped, because a three-digit badge changes
// the tile's size and the rail's whole job is to be a fixed set of targets in fixed places.

import { esc } from '../../ui/dom.js';
import { userHue } from '../../ui/hue.js';
import { icons } from '../icons.js';
import { initials, avatar } from './parts.js';

/** Anything past this reads as "a lot", and the exact number stops being useful. */
const BADGE_CAP = 99;

const badge = (n) => (n > 0
    ? `<span class="rail-badge" aria-label="${esc(n)} unread">${n > BADGE_CAP ? `${BADGE_CAP}+` : esc(n)}</span>`
    : '');

function dmTile(person) {
    const hue = userHue(person.username ?? person.id ?? '');
    const name = person.displayName || person.username || 'Unknown';
    const label = person.unread ? `${name}, ${person.unread} unread` : name;
    return `
      <button type="button"
              class="rail-item${person.current ? ' current' : ''}"
              style="--av: hsl(${hue}, 55%, 40%)"
              data-dm="${esc(person.id ?? person.username)}"
              title="${esc(name)}"
              aria-label="${esc(label)}"
              ${person.current ? 'aria-current="true"' : ''}>
        ${esc(initials(person))}
        ${badge(person.unread ?? 0)}
      </button>`;
}

export function rail({ dms = [], inRoom = true } = {}) {
    return `
    <nav class="rail" aria-label="Direct messages">
      <button type="button" class="rail-item home${inRoom ? ' current' : ''}"
              data-home aria-label="Back to rooms"
              ${inRoom ? 'aria-current="true"' : ''}>${icons.weave}</button>

      ${dms.length ? '<span class="rail-divider" role="separator"></span>' : ''}
      ${dms.map(dmTile).join('')}

      <button type="button" class="rail-item add" data-new-dm
              title="New message" aria-label="Start a direct message">${icons.plus}</button>
    </nav>`;
}

/* ── starting a new DM ────────────────────────────────────────────────────── */

/** The picker panel beside the plus button. The list is painted separately as you type. */
export const dmSearchView = () => `
  <p class="dm-search-title">Message someone</p>
  <div class="search-box">
    ${icons.search}
    <input type="search" id="dmSearchInput" placeholder="Find a person"
           autocomplete="off" spellcheck="false" aria-label="Find a person">
  </div>
  <ul class="dm-search-list" id="dmSearchList"></ul>`;

export const dmSearchResults = (people = []) => (people.length
    ? people.map((p) => `
        <li><button type="button" class="dm-search-row" data-dm-person="${esc(p.id)}">
          ${avatar(p, { size: 'sm' })}
          <span class="mention-name">${esc(p.displayName ?? p.username)}</span>
          <span class="mention-user">@${esc(p.username)}</span>
        </button></li>`).join('')
    : '<li class="dm-search-none">Nobody by that name here.</li>');
