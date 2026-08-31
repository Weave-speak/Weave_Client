// The menu you get by right-clicking a person.
//
// One menu with two halves rather than two menus. The top half is what ANYONE may do to
// how they personally hear this person — local, never signalled, nobody else affected.
// The bottom half is what an administrator may do to everybody's experience of them. They
// are separated by a rule and a label rather than split into separate surfaces, because
// the question you arrive with is "what can I do about this person", and answering it in
// two places means learning which right-click gives which.
//
// The order matters too: the harmless verbs are above the fold and the destructive ones
// below, so the muscle memory of "right-click, first item" can never reach a kick.
//
// A pure function of state, like every other view here. It returns markup and knows
// nothing about the DOM, the socket, or where on screen it is about to be put.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { avatar, displayName } from './parts.js';

/**
 * How long a server mute may run, and what each is called.
 *
 * `minutes: null` is the form the word "irreversible" describes — it ends when an
 * administrator decides it ends, and not before.
 */
export const MUTE_DURATIONS = Object.freeze([
    { minutes: 5, label: '5 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: null, label: 'Until I lift it' },
]);

const volumeRow = (listen) => `
  <div class="peer-menu-volume">
    ${icons.speaker}
    <input type="range" data-peer-volume min="0" max="100"
           value="${Math.round((listen.volume ?? 1) * 100)}"
           aria-label="How loudly you hear them">
  </div>`;

/** The half anyone gets: how YOU hear this person. Nothing here leaves this machine. */
const listenSection = (listen) => `
  <button type="button" class="peer-menu-item" data-peer-mute
          aria-pressed="${listen.muted ? 'true' : 'false'}">
    ${listen.muted ? icons.speakerOff : icons.mic}
    <span>${listen.muted ? 'Unmute for you' : 'Mute for you'}</span>
  </button>
  ${volumeRow(listen)}`;

/**
 * The admin half.
 *
 * `armed` is the kick waiting for a second press — the same arm-then-fire shape the admin
 * settings panel uses for its destructive buttons, and for the same reason: a kick sitting
 * one click away in a menu that opens under the pointer is a kick that will happen by
 * accident.
 */
const adminSection = (person, armed) => `
  <div class="peer-menu-split" role="separator"></div>
  <p class="peer-menu-admin-label">Administrator</p>
  <button type="button" class="peer-menu-item" data-server-mute="${person.forceMuted ? 'off' : 'on'}">
    ${person.forceMuted ? icons.mic : icons.micOff}
    <span>${person.forceMuted ? 'Remove server mute' : 'Server mute…'}</span>
  </button>
  <button type="button" class="peer-menu-item danger" data-kick="${armed ? 'confirm' : 'arm'}">
    ${icons.power}
    <span>${armed ? 'Kick — press again' : 'Kick'}</span>
  </button>`;

/** The second page: how long the server mute should last. */
const durationPage = (person) => `
  <button type="button" class="peer-menu-item" data-menu-back>
    <span aria-hidden="true">←</span><span>Server mute ${displayName(person)} for…</span>
  </button>
  <div class="peer-menu-split" role="separator"></div>
  ${MUTE_DURATIONS.map((d) => `
  <button type="button" class="peer-menu-item"
          data-mute-minutes="${d.minutes == null ? '' : d.minutes}">
    <span>${esc(d.label)}</span>
  </button>`).join('')}
  <p class="peer-menu-note">They cannot lift this themselves.</p>`;

/**
 * @param {object}  person    a roster row — needs username, displayName, forceMuted
 * @param {boolean} isSelf    your own row offers nothing; you have the self bar for that
 * @param {boolean} canModerate  admin AND a server that advertises `moderation`
 * @param {object}  listen    { muted, volume } — how you currently hear them
 * @param {string}  page      'main' | 'duration'
 * @param {boolean} armed     the kick is waiting for its second press
 */
export function peerMenu({
    person, isSelf = false, canModerate = false,
    listen = { muted: false, volume: 1 }, page = 'main', armed = false,
} = {}) {
    const body = page === 'duration'
        ? durationPage(person)
        : `${isSelf ? '' : listenSection(listen)}${canModerate && !isSelf ? adminSection(person, armed) : ''}`;

    return `
    <div class="peer-menu" role="menu" aria-label="${displayName(person)}">
      <div class="peer-menu-head">
        ${avatar(person, { size: 'sm', presence: false })}
        <span class="peer-menu-name">${displayName(person)}</span>
      </div>
      ${body}
    </div>`;
}

/**
 * Whether right-clicking this person would show anything at all.
 *
 * A menu with a head and no items is worse than no menu: it reads as broken rather than as
 * nothing being on offer. Your own row is that case — every verb here is aimed at somebody
 * else, and the self bar already carries your own mute, deafen and leave.
 */
export const peerMenuHasContent = ({ isSelf = false } = {}) => !isSelf;
