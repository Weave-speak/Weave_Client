// The room browser.
//
// "Where is everyone" is a different question from "what rooms exist", and the sidebar only
// answers the second one well. A list of names with a number beside each is fine for
// switching between rooms you already know; it is poor for deciding where to go, because
// the thing you actually want — who is in there — is the part it compresses to a digit.
//
// So this is cards: each room shows who is in it by face, and the whole point is that you
// pick a room by seeing the people in it.
//
// What is deliberately NOT here: room descriptions and capacities. The design shows both,
// and the server stores neither. Inventing "2 of 40" from nothing would be a number that
// looks authoritative and means nothing at all.

import { esc } from '../ui/dom.js';
import { icons } from '../room/icons.js';
import { avatar } from '../room/views/parts.js';

/** How many faces fit on a card before the rest become a count. */
const FACE_LIMIT = 5;

export const FILTERS = [
    { id: 'all', label: 'All rooms' },
    { id: 'live', label: 'Live only' },
];

/**
 * What a room is doing, in one word.
 *
 * The AFK room is the reason this is not just "empty or not": people parked there are
 * present but not available, and a card that calls that "live" would send you somewhere
 * nobody is actually talking.
 */
export function roomState(room) {
    const count = room.occupants?.length ?? 0;
    if (!count) return { key: 'empty', label: 'empty' };
    if (room.kind === 'afk') return { key: 'idle', label: `${count} idle` };
    return { key: 'live', label: `${count} live` };
}

/** What the button on a card should say. */
export function actionFor(room) {
    if (room.current) return { label: 'You are here', disabled: true };
    if (room.kind === 'text') return { label: 'Open', disabled: false };
    return (room.occupants?.length ?? 0) ? { label: 'Join', disabled: false } : { label: 'Start it', disabled: false };
}

export function applyFilter(rooms, filter) {
    if (filter === 'live') return rooms.filter((r) => (r.occupants?.length ?? 0) > 0);
    return rooms;
}

/** A short, true summary of the whole server. */
export function headline(rooms) {
    const live = rooms.filter((r) => (r.occupants?.length ?? 0) > 0);
    const people = new Set(live.flatMap((r) => (r.occupants ?? []).map((p) => p.id ?? p.username)));

    if (!people.size) return 'Nobody is in a room right now. Start one.';
    const rooms_ = live.length === 1 ? 'room' : 'rooms';
    const are = people.size === 1 ? 'is' : 'are';
    return `${people.size} ${people.size === 1 ? 'person' : 'people'} ${are} in ${live.length} ${rooms_}.`;
}

const faces = (occupants = []) => {
    const shown = occupants.slice(0, FACE_LIMIT);
    const extra = occupants.length - shown.length;
    return `
      <span class="face-stack">
        ${shown.map((p) => avatar(p, { size: 'sm', presence: false })).join('')}
        ${extra > 0 ? `<span class="face-more">+${esc(extra)}</span>` : ''}
      </span>`;
};

function card(room) {
    const state = roomState(room);
    const action = actionFor(room);
    const occupants = room.occupants ?? [];

    return `
    <li class="room-card${room.current ? ' current' : ''}" data-room-card="${esc(room.id)}">
      <div class="card-head" style="--card-hue: ${esc(hueFor(room.name))}">
        <span class="card-icon">${room.kind === 'text' ? '#' : icons.speaker}</span>
        <span class="card-name">${esc(room.name)}</span>
        <span class="card-state ${esc(state.key)}">${esc(state.label)}</span>
      </div>

      <div class="card-body">
        ${occupants.length
        ? faces(occupants)
        : '<span class="card-empty">No one here yet</span>'}
      </div>

      <div class="card-foot">
        <span class="card-who">
          ${occupants.length
        ? esc(occupants.slice(0, 3).map((p) => p.displayName ?? p.username).join(', ')
              + (occupants.length > 3 ? ` and ${occupants.length - 3} more` : ''))
        : ''}
        </span>
        <button type="button" class="btn card-action${action.disabled ? '' : ' primary'}"
                data-enter="${esc(room.id)}" ${action.disabled ? 'disabled' : ''}>
          ${esc(action.label)}
        </button>
      </div>
    </li>`;
}

/**
 * A stable colour per room, so a card is recognisable before it is read.
 *
 * The same hash the avatars use, for the same reason: nothing stored, nothing to
 * synchronise, and identical on every client.
 */
export function hueFor(name) {
    let h = 0;
    const text = String(name ?? '');
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) & 0xffff;
    return h % 360;
}

export function browserView({ rooms = [], filter = 'all', canCreate = false } = {}) {
    const shown = applyFilter(rooms, filter);

    return `
    <div class="browser">
      <header class="browser-head">
        <div>
          <h2 class="panel-title">Where is everyone?</h2>
          <p class="panel-lead">${esc(headline(rooms))}</p>
        </div>
        <span class="browser-spacer"></span>
        <div class="chips" role="group" aria-label="Filter rooms">
          ${FILTERS.map((f) => `
            <button type="button" class="chip${f.id === filter ? ' current' : ''}"
                    data-filter="${esc(f.id)}" aria-pressed="${f.id === filter}">
              ${esc(f.label)}
            </button>`).join('')}
        </div>
        ${canCreate
        ? '<button type="button" class="btn primary" data-new-room-here>Create a room</button>'
        : ''}
        <button type="button" class="icon-btn" data-close-browser aria-label="Close">✕</button>
      </header>

      ${shown.length
        ? `<ul class="room-cards">${shown.map(card).join('')}</ul>`
        : `<p class="browser-empty">${filter === 'live'
            ? 'No one is in a room at the moment.'
            : 'This server has no rooms yet.'}</p>`}

      ${canCreate
        ? ''
        : `<p class="browser-note">
             Only an administrator can create rooms on this server.
           </p>`}
    </div>`;
}

/* ── the controller ───────────────────────────────────────────────────────── */

/**
 * Open the browser over the room.
 *
 * It subscribes to the same state the room does, so the cards move as people move. A
 * browser that shows a snapshot from when you opened it is worse than the sidebar: you pick
 * the busy room and arrive to find it empty, having been told otherwise a second earlier.
 */
export function createRoomBrowser({ state, onEnter, canCreate = false, createModal, dom }) {
    const { $, $$ } = dom;
    let filter = 'all';
    let unsubscribe = null;

    const modal = createModal({
        className: 'browser-modal',
        label: 'Rooms',
        onClose: () => { unsubscribe?.(); unsubscribe = null; },
    });

    function render() {
        modal.setContent(browserView({ rooms: state.toShell().rooms, filter, canCreate }));
        wire();
    }

    function wire() {
        $$('[data-filter]', modal.element).forEach((button) => {
            button.addEventListener('click', () => {
                filter = button.dataset.filter;
                render();
            });
        });

        $$('[data-enter]', modal.element).forEach((button) => {
            button.addEventListener('click', () => {
                onEnter(button.dataset.enter);
                modal.close();
            });
        });

        $('[data-close-browser]', modal.element)?.addEventListener('click', () => modal.close());
    }

    return {
        open(from) {
            modal.open({ from, content: '' });
            render();
            // Repaint as people arrive and leave. Cheap: the whole browser is one small
            // list, and it is only mounted while it is being looked at.
            unsubscribe = state.subscribe(() => { if (modal.isOpen) render(); });
        },
        close: () => modal.close(),
    };
}
