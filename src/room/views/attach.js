// The picture waiting on a composer, as markup: the chip above the channel's message box,
// and the same chip on a bubble's card. Pure; the state comes from createAttachmentSlot()
// in room/compose.js, and the thumbnail is filled in by the room's auth-image hydration.

import { esc } from '../../ui/dom.js';

/** Nothing at all when the slot is empty, so a container can hide itself with :empty. */
export function attachChipView(slot = { status: 'empty' }) {
    switch (slot?.status) {
        case 'uploading':
            return `<span class="attach-chip">Uploading ${esc(slot.name ?? 'picture')}…</span>`;
        case 'error':
            return `<span class="attach-chip error" role="alert">${esc(slot.error ?? 'The picture could not be uploaded.')}</span>`;
        case 'ready':
            return `
          <span class="attach-chip">
            <img data-auth-src="${esc(slot.url ?? '')}" alt="">
            <span>${esc(slot.name ?? 'picture')}</span>
            <button type="button" data-attach-clear aria-label="Remove picture">✕</button>
          </span>`;
        default:
            return '';
    }
}
