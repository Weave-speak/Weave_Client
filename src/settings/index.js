// Settings.
//
// A modal over the room, with a nav down the left and one panel at a time. The controller
// owns three things the panels do not: where a preference is stored, what a change actually
// does, and what happens when the server cannot do what the design asks for.
//
// Preferences are stored PER SERVER. Two servers must never share a push-to-talk key or a
// microphone choice — a client that can reach several is exactly the case the previous
// client got wrong, muting "dan" everywhere because you muted a different "dan" somewhere
// else.

import { createModal } from '../ui/modal.js';
import { settingsFor } from '../server/store.js';
import { $, $$ } from '../ui/dom.js';
import {
    settingsFrame, profilePanel, voicePanel, appearancePanel, invitesPanel,
    placeholderPanel, sectionById, PLACEHOLDER_REASONS,
} from './panels.js';

/** Defaults, chosen to match what the media layer already does. */
const DEFAULTS = {
    pushToTalk: false,
    pushToTalkKey: 'Space',
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    staticBackground: false,
    micDevice: '',
    afkExempt: false,
};

/** Read every preference for a server, defaults filled in. */
export function readPrefs(serverId) {
    const store = settingsFor(serverId);
    const prefs = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        const stored = store.get(key, null);
        if (stored !== null) prefs[key] = stored;
    }
    return prefs;
}

export function createSettings({ api, server, me: signedInAs, features = [], onPrefsChange = () => {}, onSignOut = () => {} }) {
    const store = settingsFor(server.id);
    let me = signedInAs;
    let current = 'profile';
    let prefs = readPrefs(server.id);
    let devices = [];
    let invite = null;
    let inviteBusy = false;
    let inviteError = null;

    const modal = createModal({ className: 'settings-modal', label: 'Settings' });

    /* ── panels ──────────────────────────────────────────────────────────── */

    function panelBody() {
        switch (current) {
            case 'profile': return profilePanel({ me, prefs, features });
            case 'voice': return voicePanel({ prefs, devices, features });
            case 'appearance': return appearancePanel({ prefs });
            case 'invites': return invitesPanel({
                invite, busy: inviteBusy, error: inviteError,
                origin: server?.origin ?? null,
            });
            default:
                return placeholderPanel({
                    label: sectionById(current).label,
                    reason: PLACEHOLDER_REASONS[current] ?? 'Not built yet.',
                });
        }
    }

    function render() {
        modal.setContent(settingsFrame({
            me,
            current,
            body: panelBody(),
            serverName: server?.lastSeen?.name ?? server?.label ?? '',
        }));
        wire();
    }

    /** Repaint only the panel, so the nav does not lose focus mid-interaction. */
    function renderPanel() {
        const panel = $('#settingsPanel', modal.element);
        if (!panel) return render();
        panel.innerHTML = panelBody();
        wirePanel();
    }

    /* ── changes ─────────────────────────────────────────────────────────── */

    async function set(key, value) {
        prefs = { ...prefs, [key]: value };
        store.set(key, value);
        onPrefsChange(prefs, key);

        // The AFK exemption is the one preference that belongs to the ACCOUNT rather than
        // the device: being exempt on your desktop and not on your laptop would be a
        // surprise. The server owns it, so it is written there and not only here.
        if (key === 'afkExempt') {
            await api.request('POST', '/api/afk/opt-out', { body: { optedOut: value } })
                .catch(() => { /* the local preference still applies to this device */ });
        }
    }

    /* ── wiring ──────────────────────────────────────────────────────────── */

    function wire() {
        $$('[data-panel]', modal.element).forEach((button) => {
            button.addEventListener('click', () => {
                current = button.dataset.panel;
                render();
                $('#settingsPanel', modal.element)?.focus();
            });
        });

        $('[data-close-settings]', modal.element)?.addEventListener('click', () => modal.close());
        $('[data-sign-out]', modal.element)?.addEventListener('click', () => {
            modal.close();
            onSignOut();
        });

        wirePanel();
    }

    function wirePanel() {
        $$('[data-setting]', modal.element).forEach((input) => {
            input.addEventListener('change', async () => {
                const value = input.type === 'checkbox' ? input.checked : input.value;
                await set(input.dataset.setting, value);
                // Turning push-to-talk on reveals its key control, so this panel redraws.
                if (input.dataset.setting === 'pushToTalk') renderPanel();
            });
        });

        $('[data-capture-key]', modal.element)?.addEventListener('click', (event) => {
            captureKey(event.currentTarget);
        });

        $('[data-create-invite]', modal.element)?.addEventListener('click', createInvite);
        $('[data-copy-link]', modal.element)?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            if (!invite?.code || !server?.origin) return;
            try {
                await navigator.clipboard.writeText(`${server.origin}/invite/${invite.code}`);
                flash(button, 'Copied ✓');
            } catch {
                const link = $('.invite-link', modal.element);
                if (link) getSelection()?.selectAllChildren(link);
                flash(button, 'Press Ctrl+C');
            }
        });
        $('[data-copy-invite]', modal.element)?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            if (!invite?.code) return;
            try {
                await navigator.clipboard.writeText(invite.code);
                flash(button, 'Copied ✓');
            } catch {
                // The clipboard can be refused. Select the code so one keystroke finishes
                // the job, and say so — a button that silently does nothing reads as broken
                // because it is.
                const code = $('.invite-code', modal.element);
                if (code) getSelection()?.selectAllChildren(code);
                flash(button, 'Press Ctrl+C');
            }
        });
    }

    /** Show the outcome ON the button, then give the button back. */
    function flash(button, text) {
        if (button.dataset.flashing) return;
        button.dataset.flashing = '1';
        const label = button.textContent;
        button.textContent = text;
        setTimeout(() => {
            button.textContent = label;
            delete button.dataset.flashing;
        }, 1400);
    }

    /**
     * Read one keypress and use it as the push-to-talk key.
     *
     * `event.code` rather than `event.key`: code is the physical key, so a bind made on one
     * keyboard layout still works on another, and it does not change when a modifier is
     * held. Binding "v" and finding it stops working under a different layout is a bug
     * nobody enjoys diagnosing.
     */
    function captureKey(button) {
        const previous = button.textContent;
        button.textContent = 'Press a key…';
        button.classList.add('capturing');

        const done = (label) => {
            button.textContent = label;
            button.classList.remove('capturing');
            window.removeEventListener('keydown', onKey, true);
        };

        const onKey = (event) => {
            event.preventDefault();
            event.stopPropagation();
            // Escape cancels rather than binding itself — Escape also closes this dialog,
            // and a key that does both would be impossible to use.
            if (event.code === 'Escape') return done(previous);
            set('pushToTalkKey', event.code);
            done(event.code);
        };

        window.addEventListener('keydown', onKey, true);
    }

    async function createInvite() {
        inviteBusy = true;
        inviteError = null;
        renderPanel();
        try {
            const result = await api.request('POST', '/api/invites', {
                body: { maxUses: 1, expiresInHours: 168 },
            });
            invite = result.invite;
        } catch (err) {
            inviteError = err?.message ?? 'Could not create an invite.';
        } finally {
            inviteBusy = false;
            renderPanel();
        }
    }

    /**
     * Device labels are blank until microphone access has been granted, so this is only
     * worth asking after voice has started. Asking earlier returns a list of anonymous
     * "Microphone" entries, which is worse than no list.
     */
    async function loadDevices() {
        try {
            const all = await navigator.mediaDevices.enumerateDevices();
            devices = all.filter((d) => d.kind === 'audioinput' && d.label);
        } catch {
            devices = [];
        }
    }

    return {
        get prefs() { return prefs; },

        async open(from) {
            prefs = readPrefs(server.id);

            // The sign-in response carries a slimmer user than /api/me does — no createdAt,
            // no lastSeenAt — so the profile panel asks for the full record rather than
            // quietly rendering a profile with its join date missing.
            await api.me()
                .then((r) => { me = { ...me, ...(r.user ?? r) }; })
                .catch(() => { /* the panel still renders from what sign-in gave us */ });

            // The server is the authority on the account-level preference.
            if (features.includes('module.afk')) {
                await api.request('GET', '/api/afk/opt-out')
                    .then((r) => { prefs = { ...prefs, afkExempt: Boolean(r.optedOut) }; })
                    .catch(() => { /* fall back to what this device remembers */ });
            }

            modal.open({ from, content: '' });
            render();
            loadDevices().then(() => { if (current === 'voice') renderPanel(); });
        },

        close: () => modal.close(),
    };
}
