// Pieces that appear in more than one column.
//
// Every one of these takes data that ultimately came from a server, so every hole is
// escaped. See the note on `safe` in ui/dom.js for why that is a rule rather than a habit.

import { esc } from '../../ui/dom.js';
import { userHue } from '../../ui/hue.js';
import { icons } from '../icons.js';

/** Two letters at most. A third does not fit and a name is not an acronym. */
export function initials(person) {
    const name = String(person?.displayName || person?.username || '?').trim();
    const words = name.split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

/**
 * An avatar.
 *
 * Colour is derived from the username rather than sent by the server, so it is identical
 * on every client and survives a rename of everything except the username itself. The
 * presence dot is a CSS pseudo-element driven by the data attribute, so there is one
 * element here regardless of state.
 */
export function avatar(person, { size = '', presence = true } = {}) {
    const hue = userHue(person?.username ?? '');
    const cls = ['avatar', size].filter(Boolean).join(' ');
    const state = presence ? ` data-presence="${esc(person?.presence ?? 'offline')}"` : '';
    // The picture goes INSIDE the initials rather than replacing them, so the coloured
    // circle is already the right shape and size while the bytes are still arriving and
    // nothing reflows when they land. `avatarUrl` is resolved by the avatar cache — the
    // pictures are behind the session, so an <img> pointed straight at the API would be a
    // broken image with no explanation.
    const face = person?.avatarUrl
        ? `<img class="avatar-face" src="${esc(person.avatarUrl)}" alt="">`
        : '';
    return `<span class="${cls}" style="--av: hsl(${hue}, 55%, 40%)"${state}`
        + ` aria-hidden="true">${esc(initials(person))}${face}</span>`;
}

/** The small trailing icons on a person: priority speaker, muted, sharing, on camera. */
export function personMarks(person = {}) {
    const marks = [];
    if (person.priority) marks.push(`<span class="mark-star" title="Priority speaker">${icons.star}</span>`);
    // A live stream's mark is a DOOR, not a dot: clicking it takes you to the stream —
    // joining the room first if you are elsewhere. cid is required to aim the click.
    if (person.sharing) {
        marks.push(person.cid
            ? `<button type="button" class="mark-share mark-watch" data-watch="${esc(person.cid)}:screen"
                       title="Watch ${esc(person.displayName ?? person.username ?? '')}'s screen">${icons.screen}</button>`
            : `<span class="mark-share" title="Sharing a screen">${icons.screen}</span>`);
    }
    if (person.camera) {
        marks.push(person.cid
            ? `<button type="button" class="mark-share mark-watch" data-watch="${esc(person.cid)}:webcam"
                       title="See ${esc(person.displayName ?? person.username ?? '')}'s camera">${icons.camera}</button>`
            : `<span class="mark-share" title="On camera">${icons.camera}</span>`);
    }
    if (person.away) marks.push(`<span title="Away">${icons.afk}</span>`);
    // Kept apart from a self-mute, and checked first so it is the one that shows. They
    // look identical to the person reading the roster otherwise, and the difference —
    // "chose not to speak" against "was not allowed to" — is the whole point of it.
    if (person.forceMuted) {
        marks.push(`<span class="mark-forced" title="Muted by an administrator">${icons.micOff}</span>`);
    } else if (person.muted) {
        marks.push(`<span class="mark-muted" title="Muted">${icons.micOff}</span>`);
    }
    if (person.dnd) marks.push(`<span class="mark-muted" title="Do not disturb">${icons.speakerOff}</span>`);
    return marks.length ? `<span class="person-marks">${marks.join('')}</span>` : '';
}

/** Server-controlled display name, plus an admin badge where one applies. */
export function displayName(person) {
    return esc(person?.displayName || person?.username || 'Unknown');
}

export const adminBadge = (person) =>
    (person?.isAdmin ? '<span class="badge admin">Admin</span>' : '');
