// Bubbles in the room: the drifting few, the conversation each opens into, and the list of
// all of them.
//
// Its own file rather than more of room/index.js, which is long enough. The room hands it
// the socket, the API, a way to resolve faces and to hydrate auth-gated images, and calls
// three things on it: handle() for every frame, load() on joining, setMoving() with the
// rest of the animations. Everything it draws is appended to the room's mount, so the
// room's own click handling — the image lightbox — works inside it unchanged.

import { BubblesField } from '../ui/bubbles.js';
import { bubblePopupView, allBubblesView } from './views/bubbles.js';
import { toTimelineItems } from './messages.js';
import { html } from '../ui/dom.js';
import { createAttachmentSlot, outgoingMessage } from './compose.js';
import {
    emptyBubbles, loadBubbles, applyBubbleFrame, setBubbleMessages, markBubbleRead, anyUnread,
} from './bubble-store.js';

const POPUP_GAP = 10;
const EDGE = 8;
/** As many as the web app showed on opening: the recent conversation, not the archive. */
const FIRST_PAGE = 30;

/**
 * @param {object}   deps
 * @param {HTMLElement} deps.mount
 * @param {object}   deps.api
 * @param {object}   deps.link
 * @param {object}   deps.photos     the bubble-photo cache (createAvatarCache on bubble photos)
 * @param {Function} deps.getMe      the signed-in account
 * @param {Function} deps.getUsers   userId -> account, for names and faces in a conversation
 * @param {Function} deps.withFaces  timeline items -> the same with authors' faces resolved
 * @param {Function} deps.hydrate    fill auth-gated <img data-auth-src> under the mount
 * @param {Function} deps.createModal
 * @param {Function} deps.onChange   something the room header shows has changed
 */
export function createBubbles({
    mount, api, link, photos, getMe, getUsers, withFaces = (items) => items,
    hydrate = () => {}, createModal, onChange = () => {},
}) {
    let state = emptyBubbles();
    let field = null;
    let moving = false;
    // The open conversation: which bubble, its element, and anything to say about it.
    let popup = null;
    let listModal = null;
    // The picture waiting on the card. The channel composer's own slot (compose.js), so a
    // bubble takes a pasted or chosen picture exactly as a channel does: uploaded at once,
    // shown as a chip, sent with the message. It used to send the moment it was chosen, and
    // a paste did nothing at all.
    const picture = createAttachmentSlot({
        upload: (file) => api.uploadFile(file),
        onChange: () => render(),
    });

    const photoOf = (id) => photos.urlFor(id);

    function ensureField() {
        if (field) return field;
        const layer = mount.querySelector('#bubblesLayer');
        if (!layer) return null;
        field = new BubblesField(layer, { onOpen: open });
        field.setMoving(moving);
        return field;
    }

    /** Float exactly what the server says is floating, no more and no fewer. */
    function syncFloating() {
        const f = ensureField();
        if (!f) return;
        const want = new Set(state.active);
        for (const id of f.ids()) if (!want.has(id)) f.remove(id);
        for (const id of want) {
            const b = state.bubbles.get(id);
            if (!b) continue;
            if (!f.has(id)) f.spawn(id, { name: b.name, photoUrl: photoOf(id), unread: b.unread });
            else f.setUnread(id, b.unread);
        }
    }

    function changed() {
        syncFloating();
        paintList();
        onChange();
    }

    /* ── the conversation ────────────────────────────────────────────────── */

    function itemsFor(id) {
        const records = state.messages.get(id) ?? [];
        // No embeds in the small card: the player belongs to the timeline, which knows how
        // to keep one alive across repaints, and a card that cannot start is a dead control.
        const items = toTimelineItems(records, { users: getUsers(), me: getMe() })
            .map((i) => (i.kind === 'message' ? { ...i, embed: null } : i));
        return withFaces(items);
    }

    function render({ keepInput = true } = {}) {
        if (!popup) return;
        const b = state.bubbles.get(popup.id);
        if (!b) { close(); return; }
        const old = popup.el?.querySelector('[data-bubble-input]');
        const typed = keepInput ? old?.value ?? '' : '';
        // The card is rebuilt whole, for a message arriving or a picture finishing its upload,
        // and a rebuilt input has neither focus nor caret. Somebody mid-sentence keeps both.
        const caret = keepInput && old && document.activeElement === old
            ? [old.selectionStart, old.selectionEnd] : null;
        const markup = bubblePopupView({
            bubble: b,
            photoUrl: photoOf(b.id),
            items: itemsFor(b.id),
            loading: !state.messages.has(b.id),
            error: popup.error,
            attachment: picture.state,
        });
        const next = html(markup);
        // Only the first appearance animates. A rebuild is a fresh element, and without this
        // every message arriving made the card pop in again, and the phone's sheet slide up.
        if (popup.el) {
            next.classList.add('settled');
            popup.el.replaceWith(next);
        } else {
            mount.append(next);
        }
        popup.el = next;
        const input = next.querySelector('[data-bubble-input]');
        if (input) {
            input.value = typed;
            if (caret) {
                input.focus({ preventScroll: true });
                input.setSelectionRange(...caret);
            }
        }
        wirePopup(next);
        place();
        hydrate();
        const body = next.querySelector('.bubble-popup-body');
        if (body) body.scrollTop = body.scrollHeight;
    }

    /** Below the bubble it came out of, or over the chat when it is not floating. */
    function place() {
        const el = popup?.el;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const from = field?.rectOf(popup.id);
        const area = mount.querySelector('#timeline')?.getBoundingClientRect();
        let left;
        let top;
        if (from) {
            left = from.left + from.width / 2 - w / 2;
            top = from.bottom + POPUP_GAP;
            if (top + h > window.innerHeight - EDGE) top = from.top - h - POPUP_GAP;
        } else {
            left = (area ? area.left + area.width / 2 : window.innerWidth / 2) - w / 2;
            top = area ? area.top + 40 : 80;
        }
        el.style.left = `${Math.round(Math.min(Math.max(EDGE, left), window.innerWidth - w - EDGE))}px`;
        el.style.top = `${Math.round(Math.min(Math.max(EDGE, top), window.innerHeight - h - EDGE))}px`;
    }

    function wirePopup(el) {
        el.querySelector('[data-bubble-close]')?.addEventListener('click', close);
        const input = el.querySelector('[data-bubble-input]');
        el.querySelector('[data-bubble-composer]')?.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!popup) return;
            const body = input?.value.trim() ?? '';
            if (!body && !picture.ready) return;
            // Emptied before the picture is taken: taking it rebuilds the card, and the
            // rebuild keeps whatever the input held at that moment.
            if (input) input.value = '';
            // The same builder the channel composer sends through.
            const out = outgoingMessage({ kind: 'bubble', id: popup.id }, { body, attachment: picture.take() });
            if (out) link.send(out.type, out.payload);
        });
        input?.addEventListener('paste', (event) => picture.paste(event));
        el.querySelector('[data-bubble-attach]')?.addEventListener('click', () => picture.pick());
        el.querySelector('[data-attach-clear]')?.addEventListener('click', () => picture.clear());
    }

    /** Opening reads it: the newest message is acknowledged, on every device. */
    function acknowledge(id) {
        const newest = (state.messages.get(id) ?? []).at(-1);
        state = markBubbleRead(state, id);
        field?.setUnread(id, false);
        if (newest?.id) link.send('bubbles:read', { bubbleId: id, id: newest.id });
        paintList();
        onChange();
    }

    async function open(id) {
        if (!state.bubbles.has(id)) return;
        closeList();
        if (popup?.id !== id) close();
        popup ??= { id, el: null, error: '' };
        render({ keepInput: false });
        popup.el?.querySelector('[data-bubble-input]')?.focus({ preventScroll: true });
        if (!state.messages.has(id)) {
            try {
                const reply = await api.request('GET', `/api/bubbles/${encodeURIComponent(id)}/messages?limit=${FIRST_PAGE}`);
                state = setBubbleMessages(state, id, reply.messages ?? []);
            } catch (err) {
                state = setBubbleMessages(state, id, []);
                if (popup?.id === id) popup.error = err?.message ?? 'The conversation could not be loaded.';
            }
            if (popup?.id === id) render();
        }
        if (popup?.id === id) acknowledge(id);
    }

    function close() {
        popup?.el?.remove();
        popup = null;
        // A picture chosen for a card that has gone with it. Cleared after the card, so the
        // repaint this asks for finds nothing to draw.
        picture.clear();
    }

    // Escape and a click elsewhere both close it, as every other popover here does.
    const onKey = (event) => { if (event.key === 'Escape' && popup) close(); };
    const onPointer = (event) => {
        if (!popup?.el) return;
        if (popup.el.contains(event.target) || event.target.closest?.('.bubble, .lightbox')) return;
        close();
    };
    // A card placed for the window's old size can end up off the edge of a resized one.
    const onResize = () => place();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    mount.addEventListener('pointerdown', onPointer);

    /* ── the list of every bubble ───────────────────────────────────────── */

    function listMarkup() {
        const floating = new Set(state.active);
        return allBubblesView({
            bubbles: [...state.bubbles.values()].map((b) => ({
                ...b, photoUrl: photoOf(b.id), floating: floating.has(b.id),
            })),
        });
    }

    function paintList() {
        if (listModal) listModal.setContent(listMarkup());
    }

    function openList() {
        if (listModal) return;
        listModal = createModal({
            className: 'all-bubbles-modal',
            label: 'Bubbles',
            onClose: () => { listModal = null; },
        });
        listModal.open({ content: listMarkup() });
        listModal.element.addEventListener('click', (event) => {
            const row = event.target.closest('[data-open-bubble]');
            if (row) { open(row.dataset.openBubble); return; }
            if (event.target.closest('[data-all-bubbles-close]')) closeList();
        });
    }

    function closeList() {
        listModal?.close();
        listModal = null;
    }

    /* ── what the room calls ─────────────────────────────────────────────── */

    return {
        /** Everything there is, fresh from the server — on every join, reconnects included. */
        async load() {
            try {
                state = loadBubbles(state, await api.request('GET', '/api/bubbles'));
            } catch {
                return;   // a server without the module: no bubbles, and nothing to say about it
            }
            changed();
            render();
        },

        /** Returns whether the frame was a bubble's. */
        handle(msg) {
            if (!String(msg?.type ?? '').startsWith('bubbles:')) return false;
            if (msg.type === 'bubbles:accepted') return true;
            const openId = popup?.id ?? null;
            state = applyBubbleFrame(state, msg, { meId: getMe()?.id ?? null, openId });
            if (msg.type === 'bubbles:message' && msg.message?.bubbleId === openId) {
                render();
                if (msg.message.userId !== getMe()?.id) {
                    link.send('bubbles:read', { bubbleId: openId, id: msg.message.id });
                }
            } else if ((msg.type === 'bubbles:deleted' || msg.type === 'bubbles:cleared') && msg.id === openId) {
                render();
            }
            changed();
            return true;
        },

        setMoving(next) {
            moving = Boolean(next);
            field?.setMoving(moving);
        },

        /** A photo arrived from the cache: put it on whatever is showing it. */
        photosArrived() {
            for (const id of field?.ids() ?? []) field.setPhoto(id, photoOf(id));
            paintList();
            if (popup) render();
        },

        openList,
        open,
        get count() { return state.bubbles.size; },
        get unread() { return anyUnread(state); },

        destroy() {
            close();
            closeList();
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
            mount.removeEventListener('pointerdown', onPointer);
            field?.destroy();
            field = null;
        },
    };
}
