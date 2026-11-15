// Somebody's profile, opened from the face and name at the top of their right-click menu.
//
// Its own file rather than more of room/index.js, which is long enough. It owns one dialog,
// what it shows, and the picture opened full size from it; the room tells it when anything
// it shows may have changed.
//
// The card is drawn at once from what the roster already knows — name, username, picture —
// and drawn again when GET /api/users/:id answers with the rest: when they joined, their
// banner, whether they run the server. Waiting for the network before showing anything
// would make a right-click feel slow for the sake of a date. Against a server too old to
// send those, the first drawing is simply the last.
//
// The enlarged picture is a modal dialog of its own, stacked on the profile. The room's
// lightbox could not be used: a dialog opened with showModal() is in the top layer, above
// everything on the page, so a lightbox appended to the room opens underneath it, invisible.
// And a lightbox put INSIDE the profile, with Escape intercepted to close it first, was
// tried and does not work in Chromium: whether the profile's `cancel` was prevented or the
// keydown was, the NEXT Escape then did nothing at all, so closing the profile took a third
// press. Two stacked dialogs need nothing intercepted — the browser closes the top one on
// each Escape, which is exactly "the picture first, then the profile".

import { profileCard } from './views/profile.js';
import { html, safe } from '../ui/dom.js';

/**
 * @param {object}   deps
 * @param {object}   deps.api
 * @param {object}   deps.avatars       the room's avatar cache; banners are served beside avatars
 * @param {Function} deps.createModal
 * @param {(id: string) => object|null} deps.personById  the roster's current row for an account
 */
export function createProfileView({ api, avatars, createModal, personById }) {
    let modal = null;
    let picture = null;        // the enlarged picture's own dialog, while it is open
    let userId = null;
    // What /api/users/:id said, for the account on screen. Kept apart from the roster row so
    // a roster change (a rename, a new picture) still shows while this stays valid.
    let detail = null;

    /** The roster row, overlaid with what the profile route added. Roster wins on what both have. */
    function personNow() {
        const row = personById(userId) ?? {};
        return {
            ...detail,
            ...row,
            // Only the profile route knows these; a roster row never carries them.
            createdAt: detail?.createdAt ?? row.createdAt ?? null,
            isAdmin: Boolean(detail?.isAdmin ?? row.isAdmin),
            banner: row.banner !== undefined ? row.banner : (detail?.banner ?? null),
        };
    }

    function card() {
        const person = personNow();
        return profileCard({
            person: { ...person, avatarUrl: avatars.urlFor(person.avatar) },
            bannerUrl: avatars.urlFor(person.banner),
            enlargeable: true,
        });
    }

    // The close button sits outside the card on purpose: it is where focus lands when the
    // dialog opens, and a redraw replaces only the card. See render().
    const markup = () => `
        <div class="profile-view">
          <button type="button" class="profile-view-close" data-profile-close
                  aria-label="Close (Esc)" title="Close (Esc)">✕</button>
          ${card()}
        </div>`;

    /** The picture full size. Escape, the ✕, or a click anywhere but the picture closes it. */
    function enlarge(from) {
        if (picture?.isOpen) return;
        const person = personNow();
        const url = avatars.urlFor(person.avatar);
        if (!url) return;
        const name = person.displayName || person.username || '';

        picture = createModal({
            className: 'picture-modal',
            label: `${name}'s picture`,
            onClose: () => { picture = null; },
        });
        // Through safe``, like every hole here: the URL is an object URL the cache made, but
        // the name beside it came from a server.
        const dialog = picture.open({
            // Focus goes back to the face when this closes — createModal returns it to `from`.
            from,
            content: safe`
              <div class="lightbox profile-lightbox">
                <button type="button" class="lightbox-close" data-picture-close
                        aria-label="Close (Esc)" data-initial-focus>✕</button>
                <img class="profile-lightbox-img" src="${url}" alt="${name}">
              </div>`,
        });
        dialog.addEventListener('click', (event) => {
            // The picture itself is the only thing that is not an exit.
            if (event.target.tagName !== 'IMG') picture?.close();
        });
    }

    /**
     * Redraw the card in place, keeping focus where it is.
     *
     * Only the card, never the whole view. Replacing the element that has focus inside a
     * modal dialog drops focus to <body>, and Chromium then spent the next Escape on nothing
     * — the profile needed two presses to close, but only after the fetch above had
     * answered, which is to say every time and never in a quick test. The close button,
     * where focus starts, is therefore outside what is replaced; the face, which holds focus
     * after the enlarged picture closes, is given it back.
     */
    function render() {
        if (!modal?.isOpen) return;
        const view = modal.element.querySelector('.profile-view');
        const old = view?.querySelector('.profile-card');
        if (!old) return;
        const hadFocus = old.contains(document.activeElement);
        old.replaceWith(html(card()));
        if (hadFocus) {
            (view.querySelector('[data-profile-enlarge]') ?? view.querySelector('[data-profile-close]'))
                ?.focus({ preventScroll: true });
        }
    }

    function close() {
        picture?.close();
        modal?.close();
    }

    return {
        /** Show this person. Opening somebody else while one is showing replaces it. */
        open(person) {
            if (!person?.id) return;
            close();
            userId = person.id;
            detail = null;

            modal = createModal({
                className: 'profile-modal',
                label: `${person.displayName || person.username || 'Somebody'}'s profile`,
                onClose: () => {
                    picture?.close();
                    modal = null; userId = null; detail = null;
                },
            });
            const dialog = modal.open({ content: markup() });

            dialog.addEventListener('click', (event) => {
                if (event.target.closest('[data-profile-close]')) { close(); return; }
                const face = event.target.closest('[data-profile-enlarge]');
                if (face) enlarge(face);
            });

            const asked = userId;
            api.request('GET', `/api/users/${encodeURIComponent(asked)}`)
                .then((reply) => {
                    if (userId !== asked || !reply?.user) return;
                    detail = reply.user;
                    render();
                })
                .catch(() => {
                    // A profile that cannot be fetched still shows everything the roster
                    // knows, which is most of it. Nothing to say.
                });
        },

        /**
         * Something it shows may have changed — a picture arrived from the cache, or the
         * person renamed themselves, replaced their banner. Cheap when nothing is open.
         * `id` limits it to one account; without it, whatever is open redraws.
         */
        refresh(id = null) {
            if (!modal?.isOpen || (id && id !== userId)) return;
            render();
        },

        close,
        get openFor() { return userId; },
    };
}
