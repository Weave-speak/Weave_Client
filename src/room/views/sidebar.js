// The rooms column: which rooms exist, who is in them, and who you are.
//
// Rooms come in two kinds and are grouped by kind, because they answer different questions.
// A text strand is a place you read; a voice room is a place you go. Mixing them into one
// list makes the occupancy number next to a text channel meaningless and the unread count
// next to a voice room misleading, which is why each kind carries only the count that means
// something for it.
//
// The occupants of the CURRENT voice room are listed under it. That is the one piece of the
// roster you need without looking away from what you are doing, and it is why the member
// list on the right can be dropped on a narrow window without losing anything essential.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { avatar, personMarks, displayName } from './parts.js';

/** Anything past this reads as "a lot", and the exact number stops being useful. */
const UNREAD_CAP = 99;

function occupant(person, me) {
    const isSelf = person.username === me?.username;
    return `
      <li class="room-person${isSelf ? ' is-self' : ''}" data-person="${esc(person.username)}">
        ${avatar(person, { size: 'sm', presence: false })}
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

    return `
    <li class="room-item${room.current ? ' current' : ''}${room.occupied && !room.current ? ' occupied' : ''}" data-room="${esc(room.id)}">
      <button type="button" class="room-row" data-open="${esc(room.id)}"
              ${room.current ? 'aria-current="true"' : ''}>
        ${roomIcon(room)}
        <span class="room-name">${esc(room.name)}</span>
        ${roomCount(room)}
      </button>
      ${isVoice && !occupants.length && !room.current
        ? '<span class="room-empty">(empty)</span>'
        : ''}
      ${isVoice && room.current && occupants.length
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

/** The bottom bar: who you are, where you are, and the controls you reach for most. */
export function selfBar(me = {}) {
    const inRoom = Boolean(me.roomName);
    // A null status means the room name says it all on its own.
    const where = !inRoom ? 'Not in a room'
        : me.status ? `${me.status} · ${me.roomName}` : me.roomName;
    return `
    <footer class="self-bar">
      <button type="button" class="self-id" data-open-settings aria-label="Your profile and preferences">
        ${avatar(me)}
        <span class="self-text">
          <span class="self-name">${displayName(me)}</span>
          <span class="self-state">${esc(where)}</span>
        </span>
      </button>
      <span class="self-actions">
        ${me.pttOn ? `
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
