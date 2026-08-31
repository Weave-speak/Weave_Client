// The rooms column: which rooms exist, who is in them, and who you are.
//
// Rooms come in two kinds and are grouped by kind, because they answer different questions.
// A text strand is a place you read; a voice room is a place you go. Mixing them into one
// list makes the occupancy number next to a text channel meaningless and the unread count
// next to a voice room misleading, which is why each kind carries only the count that means
// something for it.
//
// The occupants of EVERY voice room are listed under it, the way Discord does it: where
// everyone is standing is exactly what this column is for, and it must not change when you
// merely open a text channel to read. It is also why the member list on the right can be
// dropped on a narrow window without losing anything essential.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { avatar, personMarks, displayName } from './parts.js';

/** Anything past this reads as "a lot", and the exact number stops being useful. */
const UNREAD_CAP = 99;

function occupant(person, me) {
    const isSelf = person.username === me?.username;
    return `
      <li class="room-person${isSelf ? ' is-self' : ''}" data-person="${esc(person.username)}">
        ${/* The dot is on here now that it carries information. It was off while presence
              could only mean "connected" — and everybody listed under a room is connected
              by definition, so it said nothing. A DECLARED status is the opposite: it is
              the one thing about somebody standing in a room you cannot infer from the
              fact that they are standing there. */ ''}
        ${avatar(person, { size: 'sm' })}
        <span class="person-name">${displayName(person)}${isSelf ? ' (you)' : ''}</span>
        ${personMarks(person)}
      </li>`;
}

function roomIcon(room) {
    if (room.private) return icons.lock;
    return room.kind === 'text' ? '<span class="room-hash" aria-hidden="true">#</span>' : icons.speaker;
}

/**
 * The trailing number.
 *
 * A voice room shows how many people are in it — a quiet fact. A text strand shows how many
 * messages you have not read — a demand. They are deliberately styled apart so a full room
 * never looks like an obligation.
 */
function roomCount(room) {
    if (room.kind === 'text') {
        const mentions = room.mentions ?? 0;
        const n = room.unread ?? 0;
        // A mention outranks a count: it is addressed to YOU, so it gets the bell.
        if (mentions) {
            return `<span class="room-mention" aria-label="${esc(mentions)} mention${mentions === 1 ? '' : 's'}">
                      ${icons.bell}${mentions > UNREAD_CAP ? `${UNREAD_CAP}+` : esc(mentions)}
                    </span>`;
        }
        return n
            ? `<span class="room-unread" aria-label="${esc(n)} unread">${n > UNREAD_CAP ? `${UNREAD_CAP}+` : esc(n)}</span>`
            : '';
    }
    const here = (room.occupants ?? []).length;
    return `<span class="room-count" aria-label="${esc(here)} here">${esc(here)}</span>`;
}

function roomItem(room, me) {
    const occupants = room.occupants ?? [];
    const isVoice = room.kind !== 'text';

    const lockedOut = room.private && !room.member;
    return `
    <li class="room-item${room.current ? ' current' : ''}${room.occupied && !room.current ? ' occupied' : ''}${lockedOut ? ' locked' : ''}" data-room="${esc(room.id)}">
      <div class="room-line">
        <button type="button" class="room-row" data-open="${esc(room.id)}"
                ${lockedOut ? 'aria-disabled="true" title="Private — a member has to add you"' : ''}
                ${room.current ? 'aria-current="true"' : ''}>
          ${roomIcon(room)}
          <span class="room-name">${esc(room.name)}</span>
          ${roomCount(room)}
        </button>
        ${isVoice && room.allowText ? `
        <button type="button" class="room-chat" data-open-chat="${esc(room.id)}"
                title="Open the chat without joining"
                aria-label="Open ${esc(room.name)}'s chat without joining">${icons.chat}</button>` : ''}
      </div>
      ${isVoice && !occupants.length && !room.current && !lockedOut
        ? '<span class="room-empty">(empty)</span>'
        : ''}
      ${isVoice && occupants.length
        ? `<ul class="room-people">${occupants.map((p) => occupant(p, me)).join('')}</ul>`
        : ''}
    </li>`;
}

/** The scrolling room list. Exported so a roster change can replace just this. */
export const roomGroups = (rooms, me) => groupRooms(rooms).map((g) => group(g, me)).join('');

const group = (g, me) => `
  <section class="room-group">
    <h3 class="room-group-head">
      <span class="room-group-caret" aria-hidden="true">▾</span>${esc(g.label)}
    </h3>
    <ul class="room-list">${g.rooms.map((r) => roomItem({ kind: g.kind, ...r }, me)).join('')}</ul>
  </section>`;

/**
 * Group a flat room list by kind.
 *
 * Taking a flat list and grouping here rather than demanding pre-grouped input keeps the
 * server's shape simple: it sends rooms, each of which knows what it is.
 */
export function groupRooms(rooms = []) {
    const text = rooms.filter((r) => r.kind === 'text');
    const voice = rooms.filter((r) => r.kind !== 'text');
    return [
        text.length ? { kind: 'text', label: 'Text strands', rooms: text } : null,
        voice.length ? { kind: 'voice', label: 'Voice rooms', rooms: voice } : null,
    ].filter(Boolean);
}

/**
 * When a timed mute ends, as a clock time rather than a countdown.
 *
 * "until 21:14" is still true after the bar has sat there for five minutes; "for 10
 * minutes" starts lying the moment it is rendered.
 */
const untilClock = (until) => new Date(until)
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * What a person may say about themselves.
 *
 * Two, and no more without a reason. Every value here is a promise: a colour in the
 * roster, a word in a tooltip, and something every other client has to understand. Adding
 * "Do not disturb" later is a value and a token, not a redesign.
 *
 * "Offline" is deliberately absent. It is not a choice — it is what having no connection
 * looks like — and letting somebody claim it while connected would make the roster lie.
 */
export const STATUS_CHOICES = Object.freeze([
    { value: 'online', label: 'Online', hint: 'Here and available' },
    { value: 'away', label: 'Away', hint: 'Around, but not really' },
]);

/**
 * The panel behind your own name.
 *
 * Status sits at the top because it is the thing you came here to change; Settings is
 * below a rule because it is a different kind of act — one changes what everybody else
 * sees about you now, the other opens a room full of preferences.
 *
 * This is where status lives INSTEAD of in the profile panel. A status buried three
 * clicks into a settings dialog is one nobody sets, and one nobody trusts to be current.
 */
export function selfMenu(me = {}, { open = false } = {}) {
    const current = me.status ?? 'online';
    return `
    <div class="self-menu" role="menu" aria-label="Your status"${open ? '' : ' hidden'}>
      <p class="self-menu-head">
        <span class="self-menu-name">${displayName(me)}</span>
        <span class="self-menu-handle">${esc(me.username ? `@${me.username}` : '')}</span>
      </p>
      <div class="self-menu-split" role="separator"></div>
      ${STATUS_CHOICES.map((c) => `
      <button type="button" class="self-menu-item${c.value === current ? ' current' : ''}"
              role="menuitemradio" aria-checked="${c.value === current ? 'true' : 'false'}"
              data-set-status="${esc(c.value)}">
        <span class="status-dot" data-presence="${esc(c.value)}" aria-hidden="true"></span>
        <span class="self-menu-text">
          <span class="self-menu-label">${esc(c.label)}</span>
          <span class="self-menu-hint">${esc(c.hint)}</span>
        </span>
      </button>`).join('')}
      <div class="self-menu-split" role="separator"></div>
      <button type="button" class="self-menu-item" role="menuitem" data-open-settings>
        ${icons.gear}
        <span class="self-menu-text"><span class="self-menu-label">Settings</span></span>
      </button>
    </div>`;
}

/** The bottom bar: who you are, where you are, and the controls you reach for most. */
export function selfBar(me = {}) {
    const inRoom = Boolean(me.roomName);
    // A null activity means the room name says it all on its own.
    const where = !inRoom ? 'Not in a room'
        : me.activity ? `${me.activity} · ${me.roomName}` : me.roomName;
    return `
    <footer class="self-bar">
      ${selfMenu(me)}
      <button type="button" class="self-id" data-self-menu aria-haspopup="menu"
              aria-expanded="false" aria-label="Your status, profile and preferences">
        ${avatar({ ...me, presence: me.status ?? 'online' })}
        <span class="self-text">
          <span class="self-name">${displayName(me)}</span>
          <span class="self-state">${esc(where)}</span>
        </span>
      </button>
      <span class="self-rule" aria-hidden="true"></span>
      <span class="self-actions">
        ${me.forceMuted ? `
        <button type="button" class="round-btn on forced" data-toggle-mic disabled
                title="An administrator muted you${me.forceMutedUntil ? ` until ${untilClock(me.forceMutedUntil)}` : ''}"
                aria-label="An administrator has muted your microphone">
          ${icons.micOff}
        </button>` : me.pttOn ? `
        <button type="button" class="round-btn ptt" data-toggle-mic disabled
                title="Push-to-talk is on — hold your key to speak"
                aria-label="Microphone is controlled by push-to-talk">
          ${icons.mic}
        </button>` : `
        <button type="button" class="round-btn${me.muted ? ' on' : ''}" data-toggle-mic
                aria-pressed="${me.muted ? 'true' : 'false'}"
                title="${me.muted ? 'Unmute' : 'Mute'}"
                aria-label="${me.muted ? 'Unmute your microphone' : 'Mute your microphone'}">
          ${me.muted ? icons.micOff : icons.mic}
        </button>`}
        <button type="button" class="round-btn${me.deafened ? ' on' : ''}" data-toggle-audio
                aria-pressed="${me.deafened ? 'true' : 'false'}"
                title="${me.deafened ? 'Undeafen' : 'Deafen'}"
                aria-label="${me.deafened ? 'Turn sound back on' : 'Turn all sound off'}">
          ${me.deafened ? icons.speakerOff : icons.headphones}
        </button>
        <button type="button" class="round-btn media-btn" id="camBtn" data-toggle-cam hidden
                title="Turn your camera on" aria-label="Turn your camera on"
                aria-pressed="false">${icons.camera}</button>
        <button type="button" class="round-btn media-btn" id="screenBtn" data-toggle-screen hidden
                title="Share your screen" aria-label="Share your screen"
                aria-pressed="false">${icons.screen}</button>
        ${inRoom ? `
        <button type="button" class="round-btn leave" data-leave
                title="Leave the room" aria-label="Leave the room">${icons.power}</button>` : ''}
      </span>
    </footer>`;
}

export function sidebar({ server = {}, rooms = [], me = {} } = {}) {
    return `
    <div class="sidebar">
      <header class="sidebar-head">
        <h2 class="sidebar-title">${esc(server.name ?? 'Weave')}</h2>
        ${(server.memberCount ?? 0) > 0
        ? `<span class="pill-count" title="${esc(server.memberCount)} members">${esc(server.memberCount)}</span>`
        : ''}
        <button type="button" class="icon-btn" data-browse-rooms
                title="Where is everyone?" aria-label="Browse rooms">${icons.weave}</button>
      </header>

      <div class="sidebar-search">
        <div class="search-box">
          ${icons.search}
          <input type="search" id="roomSearch" placeholder="Search rooms &amp; people"
                 autocomplete="off" spellcheck="false" aria-label="Search rooms and people">
        </div>
      </div>

      <div class="room-scroll" id="roomScroll">${roomGroups(rooms, me)}</div>

      <div id="selfBarSlot">${selfBar(me)}</div>
    </div>`;
}
