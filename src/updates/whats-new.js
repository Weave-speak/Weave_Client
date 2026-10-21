// The What's New dialog: the impure half of changelog.js.
//
// The notes are the CHANGELOG.md this build was made from, bundled as text, so the app and
// its notes cannot disagree about which version they describe. What has been seen is kept
// per INSTALLATION rather than per server: the app updated, not the server.

import changelogText from '../../CHANGELOG.md?raw';
import { createModal } from '../ui/modal.js';
import { createStorage, VERSION } from '../platform/index.js';
import {
    parseChangelog, versionsBetween, recentVersions, whatsNewDecision, whatsNewView,
} from './changelog.js';

const store = createStorage('app');
const SEEN_KEY = 'lastSeenVersion';

let parsed = null;
const versions = () => (parsed ??= parseChangelog(changelogText));

function show(list) {
    const modal = createModal({ className: 'whats-new-modal', label: "What's new" });
    modal.open({ content: whatsNewView(list, { current: VERSION }) });
    modal.element.addEventListener('click', (event) => {
        if (event.target.closest('[data-whats-new-close]')) modal.close();
    });
}

/**
 * Once per update: the notes for every version since the one last opened.
 *
 * Remembered as soon as it is decided rather than when the dialog closes, so an app quit
 * with the dialog still up does not show the same notes again at the next launch.
 */
export function showWhatsNewIfUpdated() {
    const lastSeen = store.get(SEEN_KEY, null);
    const decision = whatsNewDecision({ lastSeen, current: VERSION });
    if (decision.remember) store.set(SEEN_KEY, decision.remember);
    if (!decision.show) return false;
    const list = versionsBetween(versions(), lastSeen, VERSION);
    if (!list.length) return false;
    show(list);
    return true;
}

/** On request, from settings: this version and the couple before it. */
export function openWhatsNew() {
    show(recentVersions(versions(), VERSION));
}
