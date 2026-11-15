// A person's profile card: banner, face, name, and when they arrived.
//
// One card, drawn by two places — your own, at the top of Settings → My Profile, and
// anybody's, in the dialog a right-click opens. It started life inside the settings panel;
// it moved here so that what you see of yourself is exactly what everybody else sees of you,
// rather than two cards that agree until one of them is changed.
//
// A pure function of state, like every view. The pictures arrive as URLs the avatar cache
// has already resolved — they are behind the session, so nothing here may point at the API.

import { esc } from '../../ui/dom.js';
import { avatar, displayName, adminBadge } from './parts.js';

/**
 * A date a person would recognise, or nothing at all if the server did not send one.
 *
 * SQLite's datetime('now') produces "2026-08-23 14:01:59" — UTC, but with a space instead
 * of a T and no zone marker at all. Handed to `new Date` that is parsed as LOCAL time, so
 * an account created at 23:30 UTC shows the wrong day to anyone west of London. Normalising
 * it to ISO with an explicit Z is the whole fix.
 */
export function joinedOn(value) {
    if (!value) return null;
    const text = String(value);
    const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text;

    const when = new Date(normalised);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The strip behind the name.
 *
 * An <img> rather than a CSS background, for two reasons: the URL then goes through the same
 * escaped attribute every other picture here does instead of into a style string, and
 * `object-fit: cover` says in one property what the person was promised — the picture keeps
 * its proportions and is never stretched. It is stored at the strip's own 4:1 shape, so
 * nothing is cropped a second time either; what was framed is what shows.
 */
function banner(url) {
    return url
        ? `<div class="profile-banner has-image" aria-hidden="true">
             <img class="profile-banner-img" src="${esc(url)}" alt="">
           </div>`
        : '<div class="profile-banner" aria-hidden="true"></div>';
}

/**
 * @param {object}  person      needs username, displayName; uses avatarUrl, isAdmin, createdAt
 * @param {string}  [bannerUrl] resolved by the avatar cache, or null for the plain gradient
 * @param {boolean} [enlargeable] the face is a button that opens it full size. Only where
 *                  there IS a picture: initials blown up to 512px are not a photograph.
 */
export function profileCard({ person = {}, bannerUrl = null, enlargeable = false } = {}) {
    const joined = joinedOn(person.createdAt);
    const face = avatar(person, { size: 'lg', presence: false });
    const picture = enlargeable && person.avatarUrl
        ? `<button type="button" class="profile-avatar-button" data-profile-enlarge
                   aria-label="Show ${displayName(person)}'s picture full size"
                   title="Show full size">${face}</button>`
        : face;

    return `
    <div class="profile-card">
      ${banner(bannerUrl)}
      <div class="profile-identity">
        ${picture}
        <div class="profile-id-text">
          <div class="profile-name">
            ${displayName(person)}
            ${adminBadge(person)}
          </div>
          <div class="profile-meta">
            ${esc(person.username ? `@${person.username}` : '')}${joined ? ` · joined ${esc(joined)}` : ''}
          </div>
        </div>
      </div>
    </div>`;
}
