// The menu you get by right-clicking a person.
//
// One menu with two halves rather than two menus. The top half is what ANYONE may do to
// how they personally hear this person — local, never signalled, nobody else affected.
// The bottom half is what an administrator (or a tester, for the server mute alone) may do
// to everybody's experience of them. They
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
 *
 * Thirty seconds travels as `minutes: 0.5` rather than as a new field, so a server too old
 * to know about short mutes still understands it — it rounds up to its one-minute floor,
 * which is a longer mute than asked for rather than none at all.
 */
export const MUTE_DURATIONS = Object.freeze([
    { minutes: 0.5, label: '30 seconds' },
    { minutes: 5, label: '5 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: null, label: 'Until I lift it' },
]);

const volumeRow = (listen) => `
  <div class="peer-menu-volume">
    ${icons.speaker}
    <input type="range" data-peer-volume min="0" max="200"
           value="${Math.round((listen.volume ?? 1) * 100)}"
           aria-label="How loudly you hear them">
  </div>`;

/**
 * The half anyone gets: how YOU hear this person. Nothing here leaves this machine.
 *
 * Priority speaker lives here rather than with the administrator verbs because it is the
 * web app's version: each listener stars whoever they need to hear over the room — a
 * shot-caller, a raid lead — and only their own ears change.
 */
const listenSection = (listen, priority) => `
  <button type="button" class="peer-menu-item" data-peer-mute
          aria-pressed="${listen.muted ? 'true' : 'false'}">
    ${listen.muted ? icons.speakerOff : icons.mic}
    <span>${listen.muted ? 'Unmute for you' : 'Mute for you'}</span>
  </button>
  <button type="button" class="peer-menu-item${priority ? ' on' : ''}" data-peer-priority
          aria-pressed="${priority ? 'true' : 'false'}"
          title="While they talk, everyone else is turned down — for you only.">
    ${icons.star}
    <span>${priority ? 'Stop prioritising' : 'Priority speaker'}</span>
  </button>
  ${volumeRow(listen)}`;

/**
 * The privileged half: what an administrator — or, for the server mute alone, a tester — may
 * do to everybody's experience of this person.
 *
 * Labelled with the role that grants it, so a tester is never left wondering why the kick
 * an administrator described to them is not there.
 *
 * `armed` is the kick waiting for a second press — the same arm-then-fire shape the admin
 * settings panel uses for its destructive buttons, and for the same reason: a kick sitting
 * one click away in a menu that opens under the pointer is a kick that will happen by
 * accident.
 */
const privilegedSection = (person, { canServerMute, canKick, armed }) => `
  <div class="peer-menu-split" role="separator"></div>
  <p class="peer-menu-admin-label">${canKick ? 'Administrator' : 'Tester'}</p>
  ${canServerMute ? `
  <button type="button" class="peer-menu-item" data-server-mute="${person.forceMuted ? 'off' : 'on'}">
    ${person.forceMuted ? icons.mic : icons.micOff}
    <span>${person.forceMuted ? 'Remove server mute' : 'Server mute…'}</span>
  </button>` : ''}
  ${canKick ? `
  <button type="button" class="peer-menu-item danger" data-kick="${armed ? 'confirm' : 'arm'}">
    ${icons.power}
    <span>${armed ? 'Kick — press again' : 'Kick'}</span>
  </button>` : ''}`;

/**
 * The second page: how long the server mute should last.
 *
 * `timedOnly` leaves out the open-ended choice. A tester's mute always ends on its own; one
 * that lasts until somebody lifts it is an administrator's decision to make.
 */
const durationPage = (person, { timedOnly }) => `
  <button type="button" class="peer-menu-item" data-menu-back>
    <span aria-hidden="true">←</span><span>Server mute ${displayName(person)} for…</span>
  </button>
  <div class="peer-menu-split" role="separator"></div>
  ${MUTE_DURATIONS.filter((d) => !(timedOnly && d.minutes == null)).map((d) => `
  <button type="button" class="peer-menu-item"
          data-mute-minutes="${d.minutes == null ? '' : d.minutes}">
    <span>${esc(d.label)}</span>
  </button>`).join('')}
  <p class="peer-menu-note">They cannot lift this themselves.</p>`;

/**
 * The top of the menu: who it is about, and the way into their profile.
 *
 * A button rather than a heading, because the face and the name are what a hand reaches
 * for when it wants to know more about somebody — the same gesture as clicking a name
 * anywhere else. It is first in the menu for the same reason the harmless verbs are above
 * the fold: it changes nothing for anybody.
 */
const head = (person) => `
  <button type="button" class="peer-menu-head" data-peer-profile
          title="View profile" aria-label="View ${displayName(person)}'s profile">
    ${avatar(person, { size: 'sm', presence: false })}
    <span class="peer-menu-name">${displayName(person)}</span>
    <span class="peer-menu-head-hint" aria-hidden="true">Profile</span>
  </button>`;

/**
 * @param {object}  person    a roster row — needs username, displayName, forceMuted
 * @param {boolean} isSelf    your own row offers only your profile; the self bar has the rest
 * @param {boolean} online    they have a connection. Someone right-clicked from an old chat
 *                  message may not, and muting or turning down a voice that is not there
 *                  is a control that does nothing — so it is not offered.
 * @param {boolean} canServerMute  an administrator, or a tester, on a server that honours it
 * @param {boolean} canKick   an administrator on a server that advertises `moderation`
 * @param {boolean} timedOnly the server mute offers no open-ended duration (a tester)
 * @param {object}  listen    { muted, volume } — how you currently hear them
 * @param {boolean} priority  you have starred them as a priority speaker
 * @param {string}  page      'main' | 'duration'
 * @param {boolean} armed     the kick is waiting for its second press
 */
export function peerMenu({
    person, isSelf = false, online = true, canServerMute = false, canKick = false, timedOnly = false,
    listen = { muted: false, volume: 1 }, priority = false, page = 'main', armed = false,
} = {}) {
    // A kick ends a connection, so with none there is nothing for it to do. A server mute is
    // on the account and outlasts the session, so it stays.
    const kicks = canKick && online;
    const privileged = !isSelf && (canServerMute || kicks);
    const listens = !isSelf && online;
    const body = page === 'duration'
        ? durationPage(person, { timedOnly })
        : `${listens ? listenSection(listen, priority) : ''}${privileged ? privilegedSection(person, { canServerMute, canKick: kicks, armed }) : ''}`;

    // The duration page keeps a plain heading: its first line is already a way back, and a
    // second clickable line above it would be two different exits from one small panel.
    return `
    <div class="peer-menu" role="menu" aria-label="${displayName(person)}">
      ${page === 'duration' ? `
      <div class="peer-menu-head is-static">
        ${avatar(person, { size: 'sm', presence: false })}
        <span class="peer-menu-name">${displayName(person)}</span>
      </div>` : head(person)}
      ${body}
    </div>`;
}

/**
 * Whether right-clicking this person would show anything at all.
 *
 * A menu with a head and no items would read as broken rather than as nothing on offer —
 * which is why your own row used to open nothing. The head is an item now, the way into a
 * profile, so every row has something to offer, yours included.
 */
export const peerMenuHasContent = () => true;
