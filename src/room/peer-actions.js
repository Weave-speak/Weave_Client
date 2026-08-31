// Right-clicking a person, and dragging one into a room.
//
// Its own file rather than more of room/index.js, because both behaviours own a piece of
// live DOM that must survive a repaint — and the roster does not. `repaint()` rewrites
// #roomScroll's innerHTML wholesale, so anything parented inside a `.room-person` is
// deleted the next time somebody's presence changes. Both the menu and the drag ghost are
// therefore appended to the shell and positioned `fixed`, which also gets them out from
// under `.room-scroll`'s overflow and `.sidebar`'s.
//
// Neither of these is HTML5 drag-and-drop. That API would have the same problem — the
// source node is removed mid-gesture — and gives no control over what the pointer carries.
// Pointer events are what the stage divider already uses.

import { peerMenu, peerMenuHasContent } from './views/peer-menu.js';
import { avatar, displayName } from './views/parts.js';
import { html } from '../ui/dom.js';

/** Below this a press is a press, not a drag. Roughly the width of a shaky click. */
const DRAG_THRESHOLD_PX = 5;

/** Keeps a menu off the window edges. */
const EDGE_GAP_PX = 8;

/** What follows the pointer during a drag: enough to say who is being carried. */
const dragGhost = (person) => `
  <div class="drag-ghost">
    ${avatar(person, { size: 'sm', presence: false })}
    <span>${displayName(person)}</span>
  </div>`;

export function createPeerActions({
    mount,
    state,
    voice,
    link,
    // Whether this session may act on other people at all. Read fresh on every open, so
    // it is right after a server-info refresh rather than only at construction.
    canMove = () => false,
    canModerate = () => false,
    paint = () => {},
}) {
    let menuEl = null;
    let menuFor = null;         // the person the open menu belongs to
    let menuPage = 'main';
    let kickArmed = false;
    let drag = null;

    /**
     * Whether somebody may be put in this room.
     *
     * A text strand is a place you read, not a place you stand; a private room you are
     * locked out of is one whose membership is the entire point of it.
     */
    function canDropOn(channelId) {
        const room = state.toShell().rooms.find((r) => r.id === channelId);
        return Boolean(room) && room.kind !== 'text' && !(room.private && !room.member);
    }

    /** The roster row for a username, or null once they have gone. */
    const personOf = (username) =>
        state.toShell().people.find((p) => p.username === username) ?? null;

    /** How this machine currently hears them. Peer prefs are per connection. */
    const listenOf = (person) => voice.getListen(person?.cid, 'audio');

    function closeMenu() {
        menuEl?.remove();
        menuEl = null;
        menuFor = null;
        menuPage = 'main';
        kickArmed = false;
        for (const el of mount.querySelectorAll('.room-person.selected')) {
            el.classList.remove('selected');
        }
    }

    /**
     * Put the menu where the pointer is, then pull it back inside the window.
     *
     * Flipping above the pointer rather than clamping when it would overflow the bottom:
     * a menu clamped to the bottom edge sits under the pointer, so the first item is
     * already hovered and a second click lands on it.
     */
    function place(el, x, y) {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const left = Math.min(x, window.innerWidth - w - EDGE_GAP_PX);
        const top = y + h + EDGE_GAP_PX > window.innerHeight
            ? Math.max(EDGE_GAP_PX, y - h)
            : y;
        el.style.left = `${Math.max(EDGE_GAP_PX, Math.round(left))}px`;
        el.style.top = `${Math.round(top)}px`;
    }

    /** Where the menu was opened. Kept so a re-render lands in the same place. */
    let menuAt = { x: 0, y: 0 };

    function renderMenu() {
        const person = personOf(menuFor);
        if (!person) return closeMenu();

        const next = html(peerMenu({
            person,
            isSelf: person.id === state.toShell().me.id,
            canModerate: canModerate(),
            listen: listenOf(person),
            page: menuPage,
            armed: kickArmed,
        }));

        // Off-screen until measured: `place` needs a real height to decide whether to flip
        // above the pointer, and a panel that appears at 0,0 first visibly jumps.
        next.style.visibility = 'hidden';
        if (menuEl) menuEl.replaceWith(next); else mount.append(next);
        menuEl = next;
        place(menuEl, menuAt.x, menuAt.y);
        menuEl.style.visibility = '';
        menuEl.querySelector('button')?.focus({ preventScroll: true });
    }

    function openMenu(row, x, y) {
        const username = row.dataset.person;
        const person = personOf(username);
        const isSelf = person && person.id === state.toShell().me.id;
        // Nothing to offer is not a menu. An empty panel reads as broken.
        if (!person || !peerMenuHasContent({ isSelf })) return closeMenu();

        closeMenu();
        menuFor = username;
        menuAt = { x, y };
        row.classList.add('selected');
        renderMenu();
    }

    /** Re-render in place — a duration page, an armed kick, a changed local mute. */
    const refreshMenu = () => { if (menuEl) renderMenu(); };

    /* ── dragging somebody into a room ───────────────────────────────────── */

    function endDrag(commit) {
        if (!drag) return;
        const { ghost, row, target } = drag;
        ghost.remove();
        row?.classList.remove('is-dragging');
        target?.classList.remove('drop-target');
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragUp);
        const landed = commit ? target : null;
        const person = drag.person;
        drag = null;

        if (landed) {
            // userId, not cid: somebody signed in twice is one row in the roster, and
            // moving half their connections would leave them audible in the old room.
            link.send('adminMove', { userId: person.id, channelId: landed.dataset.room });
        }
        // Suppressed while the gesture was live, so the roster catches up now.
        paint();
    }

    function onDragMove(event) {
        if (!drag) return;
        if (!drag.started) {
            const far = Math.abs(event.clientX - drag.x0) > DRAG_THRESHOLD_PX
                || Math.abs(event.clientY - drag.y0) > DRAG_THRESHOLD_PX;
            if (!far) return;
            drag.started = true;
            drag.row.classList.add('is-dragging');
            mount.append(drag.ghost);
        }
        drag.ghost.style.left = `${event.clientX + 12}px`;
        drag.ghost.style.top = `${event.clientY + 12}px`;

        // The ghost is pointer-events: none, or this would only ever find the ghost.
        const under = document.elementFromPoint(event.clientX, event.clientY);
        const room = under?.closest('.room-item[data-room]');
        // Only somewhere you can STAND, decided from the room list rather than from what
        // the sidebar happens to be showing. The server refuses a text channel anyway, but
        // offering a target and then refusing it is worse than never offering it.
        const valid = room && canDropOn(room.dataset.room);

        if (drag.target !== (valid ? room : null)) {
            drag.target?.classList.remove('drop-target');
            drag.target = valid ? room : null;
            drag.target?.classList.add('drop-target');
        }
    }

    const onDragUp = () => endDrag(true);

    function beginDrag(row, event) {
        const person = personOf(row.dataset.person);
        if (!person) return;

        // Built through html() rather than by assigning a template to innerHTML: both
        // holes are already-escaped view output, but the rule in escaping.test.js has no
        // exceptions on purpose — a rule with one is a rule somebody argues past at 1 a.m.
        const ghost = html(dragGhost(person));

        drag = {
            person, row, ghost, target: null, started: false,
            x0: event.clientX, y0: event.clientY,
        };
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragUp);
    }

    /* ── wiring ──────────────────────────────────────────────────────────── */

    mount.addEventListener('contextmenu', (event) => {
        const row = event.target.closest('.room-person');
        if (!row) return;
        // Only ours. Right-clicking anywhere else keeps whatever the platform offers.
        event.preventDefault();
        openMenu(row, event.clientX, event.clientY);
    });

    mount.addEventListener('pointerdown', (event) => {
        // A click outside the open menu closes it, including one that opens another menu.
        if (menuEl && !event.target.closest('.peer-menu')) closeMenu();

        const row = event.target.closest('.room-person');
        if (!row || !canMove()) return;
        // Mouse only. Claiming touch here would break scrolling the sidebar, which is the
        // thing a finger on this list is almost always trying to do.
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        beginDrag(row, event);
    });

    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (drag) endDrag(false);
        if (menuEl) closeMenu();
    });

    mount.addEventListener('click', (event) => {
        const panel = event.target.closest('.peer-menu');
        if (!panel) return;
        const person = personOf(menuFor);
        if (!person) return closeMenu();

        if (event.target.closest('[data-peer-mute]')) {
            const now = listenOf(person);
            // Every connection they hold, so muting somebody signed in twice is one press.
            for (const cid of person.cids ?? []) voice.setListen(cid, 'audio', { muted: !now.muted });
            refreshMenu();
            return;
        }

        if (event.target.closest('[data-menu-back]')) {
            menuPage = 'main';
            refreshMenu();
            return;
        }

        const serverMute = event.target.closest('[data-server-mute]');
        if (serverMute) {
            if (serverMute.dataset.serverMute === 'off') {
                link.send('serverMute', { userId: person.id, muted: false });
                closeMenu();
            } else {
                // A second page rather than a submenu: one panel, one set of hit targets,
                // and no hover-to-open timing to get wrong.
                menuPage = 'duration';
                refreshMenu();
            }
            return;
        }

        const duration = event.target.closest('[data-mute-minutes]');
        if (duration) {
            const raw = duration.dataset.muteMinutes;
            link.send('serverMute', {
                userId: person.id, muted: true, minutes: raw === '' ? null : Number(raw),
            });
            closeMenu();
            return;
        }

        const kick = event.target.closest('[data-kick]');
        if (kick) {
            // Armed first. A kick one click into a menu that opens under the pointer is a
            // kick that eventually happens by accident.
            if (kick.dataset.kick === 'arm') {
                kickArmed = true;
                refreshMenu();
                return;
            }
            link.send('kickPeer', { userId: person.id });
            closeMenu();
        }
    });

    mount.addEventListener('input', (event) => {
        const slider = event.target.closest?.('[data-peer-volume]');
        if (!slider) return;
        const person = personOf(menuFor);
        if (!person) return;
        const volume = Number(slider.value) / 100;
        for (const cid of person.cids ?? []) voice.setListen(cid, 'audio', { volume });
    });

    return {
        /** True while a drag is live, so the roster is not repainted out from under it. */
        get dragging() { return Boolean(drag?.started); },
        /** After a repaint: the row the menu points at was replaced, so re-mark it. */
        reselect() {
            if (!menuFor) return;
            const row = mount.querySelector(`.room-person[data-person="${CSS.escape(menuFor)}"]`);
            if (row) row.classList.add('selected');
            else closeMenu();      // they left the room; the menu is aimed at nobody
        },
        close: closeMenu,
    };
}
