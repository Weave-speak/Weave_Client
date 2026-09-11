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
import { createAvatarPicker } from './avatar-picker.js';
import { settingsFor } from '../server/store.js';
import {
    $, $$, setFieldError, clearErrors, setFormMessage, setBusy, passwordStrength,
} from '../ui/dom.js';
import { VERSION, platform } from '../platform/index.js';
import { DEFAULT_STREAM_PRESET } from '../media/presets.js';
import { dbToMeterPercent } from '../media/chain.js';
import {
    adminUsersPanel, adminChannelsPanel, adminSoundsPanel, adminServerPanel, adminDangerPanel,
    adminBugsPanel,
} from './admin.js';
import {
    settingsFrame, profilePanel, voicePanel, appearancePanel, invitesPanel, inviteMessage, sessionsPanel,
    securityPanel, bugPanel, placeholderPanel, sectionById, PLACEHOLDER_REASONS,
} from './panels.js';

/**
 * Defaults, chosen to match what the media layer already does.
 *
 * This list is the CONTRACT, not documentation. readPrefs() copies only the keys named
 * here, so a preference written by set() but missing from this object is stored and then
 * silently discarded on the next read — at app start, and again every time the settings
 * modal opens. Eight preferences were in exactly that state: the noise gate never
 * engaged, input gain was always 100%, and anyone who picked 1080p60 got 1080p30 back.
 *
 * If you add a control, add its key here. settings.test.js fails if you do not.
 */
export const DEFAULTS = {
    pushToTalk: false,
    pushToTalkKey: 'Space',
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    staticBackground: false,
    micDevice: '',
    audioOutput: '',
    afkExempt: false,
    // Resolved server-side (personal choice, or the admin's default if there is
    // one) — an empty string just means "nothing to show yet".
    joinSound: '',
    leaveSound: '',
    // The mic chain. `noiseGate` defaults off because a gate the user did not ask for is
    // indistinguishable from a broken microphone; 64 on the sensitivity scale is -41.6 dBFS,
    // which sits above a quiet room and below speech.
    micGain: 100,
    noiseGate: false,
    gateSensitivity: 64,
    // Tone shaping, off because it changes how somebody already sounds. Opt in.
    voiceOptimize: false,
    // Camera and screen share. These are the ones people actually noticed reverting.
    camDevice: '',
    camRes: '720',
    camFps: 30,
    streamPreset: DEFAULT_STREAM_PRESET,
    streamPrefer: 'detail',
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

export function createSettings({
    getActiveMicrophone = null,
    checkForUpdates = null, api, server, me: signedInAs, features = [], onPrefsChange = () => {}, onSignOut = () => {},
    // Which connection this app is, read at the moment it is needed rather than captured:
    // it changes on every reconnect that cannot be resumed. Changing your own password
    // signs out your other devices, and this is how the server knows which one to spare.
    selfCid = () => null,
    // A new picture changes the roster for everybody, so the room repaints rather
    // than the settings dialog quietly knowing something the rest of the app does not.
    onProfileChange = () => {},
    // Avatars live behind the session, so an <img> cannot fetch one on its own. The room
    // owns the cache that turns an id into something renderable; without it this panel
    // could only ever draw initials — which is exactly what it did.
    avatars = null }) {
    const store = settingsFor(server.id);
    let me = signedInAs;
    let current = 'profile';
    let prefs = readPrefs(server.id);
    let devices = [];
    let cameras = [];
    let outputs = [];
    let soundLibrary = [];
    let invite = null;
    let inviteBusy = false;
    let inviteError = null;
    // The cropper's own state. Held here rather than in the picker so a panel redraw
    // reproduces the same screen instead of losing a half-framed picture.
    let avatarError = '';
    let picker = null;

    // Security & Recovery. The questions and the current choice come from the server when
    // the panel is opened; the rest is the working state of two forms, held here so a
    // repaint reproduces the same screen rather than losing what was typed.
    const sec = { question: null, questions: [], error: null, notice: null };

    // The account's signed-in devices. null means "not asked yet", which the panel draws
    // as reading rather than as an account with no devices — a distinction that matters,
    // because one of those is impossible and would be alarming to see.
    const deviceList = { sessions: null, error: null, notice: null };

    // A bug report in progress. The log is read when the dialog opens so it can be SHOWN;
    // nothing leaves until the button is pressed. Held here, like the cropper's state, so a
    // repaint reproduces the same screen rather than losing a half-written paragraph.
    const bug = {
        description: '', log: null, showLog: false, sending: false, sent: false, error: null,
    };

    // The admin console's working state. Data is fetched when its panel is opened and
    // refetched after every action, so the table always shows what the server just did.
    const adm = {
        members: null, channels: null, overview: null, logs: null,
        sounds: null, soundDefaults: { joinSound: null, leaveSound: null }, soundUploadBusy: false,
        // Bug reports: the list, how many there are in total, and the one being read.
        bugs: null, bugTotal: 0, bugOpen: null,
        error: null, notice: null,
        editingId: null,       // user or channel row in rename mode
        armedKey: null,        // 'action:id' of the one destructive button awaiting its second click
        createBusy: false,
        doom: { stage: 'idle', typed: '', error: null, busy: false },
    };

    const modal = createModal({ className: 'settings-modal', label: 'Settings' });

    /* ── panels ──────────────────────────────────────────────────────────── */

    function panelBody() {
        switch (current) {
            case 'profile': return profilePanel({
                me: { ...me, avatarUrl: avatars?.urlFor(me.avatar) ?? null },
                prefs, features, avatarError, soundLibrary,
            });
            case 'voice': return voicePanel({ prefs, devices, cameras, outputs, features });
            case 'sessions': return sessionsPanel({
                version: VERSION, features,
                sessions: deviceList.sessions, error: deviceList.error, notice: deviceList.notice,
            });
            case 'bug': return bugPanel({
                ...bug, features,
                logAvailable: platform.diagnostics.available,
                serverName: server?.lastSeen?.name ?? '',
            });
            case 'security': return securityPanel({
                question: sec.question, questions: sec.questions, features,
                error: sec.error, notice: sec.notice,
            });
            case 'appearance': return appearancePanel({ prefs });
            case 'invites': return invitesPanel({
                invite, busy: inviteBusy, error: inviteError,
                origin: server?.origin ?? null,
            });
            case 'admin-users':
                return adminUsersPanel({
                    members: adm.members, error: adm.error, notice: adm.notice,
                    editingId: adm.editingId, armedKey: adm.armedKey,
                });
            case 'admin-channels':
                return adminChannelsPanel({
                    channels: adm.channels, error: adm.error, notice: adm.notice,
                    editingId: adm.editingId, armedKey: adm.armedKey, busy: adm.createBusy,
                });
            case 'admin-sounds':
                return adminSoundsPanel({
                    sounds: adm.sounds, defaults: adm.soundDefaults, error: adm.error, notice: adm.notice,
                    armedKey: adm.armedKey, uploadBusy: adm.soundUploadBusy,
                });
            case 'admin-bugs':
                return adminBugsPanel({
                    reports: adm.bugs, total: adm.bugTotal, open: adm.bugOpen,
                    error: adm.error, notice: adm.notice, armedKey: adm.armedKey,
                });
            case 'admin-server':
                return adminServerPanel({ overview: adm.overview, logs: adm.logs, error: adm.error });
            case 'admin-danger':
                return adminDangerPanel({
                    ...adm.doom,
                    serverName: server?.lastSeen?.name ?? '',
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
        // The truth line under the mic picker follows the switch it may have caused.
        if (key === 'micDevice') setTimeout(() => paintActiveMic(), 600);

        // The AFK exemption is the one preference that belongs to the ACCOUNT rather than
        // the device: being exempt on your desktop and not on your laptop would be a
        // surprise. The server owns it, so it is written there and not only here.
        if (key === 'afkExempt') {
            await api.request('POST', '/api/afk/opt-out', { body: { optedOut: value } })
                .catch(() => { /* the local preference still applies to this device */ });
        }

        // Join/leave sound choice is also account-level — chosen once, heard everywhere
        // you go, not per device. Both fields travel together; the route expects both.
        if (key === 'joinSound' || key === 'leaveSound') {
            await api.request('PUT', '/api/sounds/me', {
                body: { joinSound: prefs.joinSound || null, leaveSound: prefs.leaveSound || null },
            }).catch(() => { /* the local preference still applies to this device */ });
        }
    }

    /* ── wiring ──────────────────────────────────────────────────────────── */

    function wire() {
        $$('[data-panel]', modal.element).forEach((button) => {
            button.addEventListener('click', () => {
                current = button.dataset.panel;
                // Panel-scoped state must not leak between panels: an armed Remove
                // button or a half-typed rename belongs to the screen it was on.
                adm.error = null; adm.notice = null; adm.editingId = null; adm.armedKey = null;
                if (current !== 'admin-danger') adm.doom = { stage: 'idle', typed: '', error: null, busy: false };
                render();
                $('#settingsPanel', modal.element)?.focus();
                loadAdminData();
            });
        });

        $('[data-close-settings]', modal.element)?.addEventListener('click', () => modal.close());
        $('[data-sign-out]', modal.element)?.addEventListener('click', () => {
            modal.close();
            onSignOut();
        });

        wirePanel();
    }

    /** What the live track ACTUALLY captures, next to what was asked for. */
    function paintActiveMic() {
        const line = $('#activeMic', modal.element);
        if (!line) return;
        const active = getActiveMicrophone?.() ?? null;
        if (!active) { line.textContent = 'Not capturing — join a voice room.'; return; }
        line.textContent = `Capturing: ${active.label ?? 'unnamed device'}`;
        const wanted = prefs.micDevice;
        const mismatch = wanted && active.deviceId && wanted !== active.deviceId && active.deviceId !== 'default';
        line.classList.toggle('is-warn', Boolean(mismatch));
        if (mismatch) line.textContent += ' — NOT the device selected above';
    }

    /** Fetch whatever the open admin panel shows. Stale data is replaced, not merged. */
    async function loadAdminData() {
        try {
            if (current === 'admin-users') {
                const { members } = await api.request('GET', '/api/admin/members');
                adm.members = members;
            } else if (current === 'admin-channels') {
                const { channels } = await api.request('GET', '/api/channels');
                adm.channels = channels;
            } else if (current === 'admin-sounds') {
                const { sounds, defaults } = await api.request('GET', '/api/sounds');
                adm.sounds = sounds;
                adm.soundDefaults = defaults;
            } else if (current === 'admin-bugs') {
                // Only the list. A report is fetched whole when somebody asks to read it,
                // because the logs inside one are the size of the thing.
                const { reports, total } = await api.request('GET', '/api/admin/diagnostics?limit=100');
                adm.bugs = reports;
                adm.bugTotal = total ?? reports.length;
            } else if (current === 'admin-server') {
                // Fetched together: the numbers without the log answer half the question.
                const [overview, logs] = await Promise.all([
                    api.request('GET', '/api/admin/overview'),
                    api.request('GET', '/api/admin/logs?lines=200'),
                ]);
                adm.overview = overview;
                adm.logs = logs;
            } else return;
        } catch (err) {
            adm.error = err?.message ?? 'The server did not answer.';
        }
        renderPanel();
    }

    /**
     * Run one admin action, then refetch and repaint. Every action funnels through here
     * so errors land in the banner instead of vanishing into the console.
     */
    async function adminAct(fn, okNotice = null) {
        adm.error = null; adm.notice = null;
        try {
            await fn();
            adm.notice = okNotice;
            adm.editingId = null; adm.armedKey = null;
        } catch (err) {
            adm.error = err?.message ?? 'That did not work.';
        }
        await loadAdminData();
    }

    /** First click arms, second fires — the repaint between them shows the question. */
    function armThen(key, fire) {
        if (adm.armedKey === key) { adm.armedKey = null; fire(); return; }
        adm.armedKey = key;
        renderPanel();
    }

    function wireAdminPanel() {
        const el = modal.element;
        $('[data-goto-invites]', el)?.addEventListener('click', () => {
            current = 'invites'; render();
        });

        // -- users --
        $$('[data-admin-edit]', el).forEach((b) => b.addEventListener('click', () => {
            adm.editingId = b.dataset.adminEdit; adm.armedKey = null; renderPanel();
            $('[data-rename-input]', el)?.focus();
        }));
        $$('[data-admin-rename-cancel], [data-chan-rename-cancel]', el).forEach((b) =>
            b.addEventListener('click', () => { adm.editingId = null; renderPanel(); }));
        $$('[data-admin-rename-save]', el).forEach((b) => b.addEventListener('click', () => {
            const displayName = $('[data-rename-input]', el)?.value?.trim();
            if (!displayName) return;
            adminAct(() => api.request('PUT', `/api/admin/members/${b.dataset.adminRenameSave}`, {
                body: { displayName },
            }));
        }));
        $$('[data-bug-open]', el).forEach((b) => b.addEventListener('click', async () => {
            adm.error = null;
            try {
                const { report } = await api.request('GET', `/api/admin/diagnostics/${encodeURIComponent(b.dataset.bugOpen)}`);
                adm.bugOpen = report;
            } catch (err) {
                adm.error = err?.message ?? 'That report could not be read.';
            }
            renderPanel();
        }));

        $('[data-bug-close]', el)?.addEventListener('click', () => {
            adm.bugOpen = null;
            renderPanel();
        });

        $$('[data-bug-delete]', el).forEach((b) => b.addEventListener('click', () => {
            const name = b.dataset.bugDelete;
            armThen(`bug:${name}`, () => adminAct(
                async () => {
                    await api.request('DELETE', `/api/admin/diagnostics/${encodeURIComponent(name)}`);
                    // Whatever was open went with it.
                    adm.bugOpen = null;
                },
                'Report deleted.',
            ));
        }));

        $$('[data-admin-reset]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.adminReset;
            armThen(`reset:${id}`, () => adminAct(
                () => api.request('POST', `/api/admin/members/${id}/reset-password`, { body: {} }),
                'Done — they are signed out now and will choose a new password at their next sign-in.',
            ));
        }));
        $$('[data-admin-ban]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.adminBan;
            armThen(`ban:${id}`, () => adminAct(
                () => api.request('POST', `/api/admin/members/${id}/ban`, { body: { banned: true } }),
            ));
        }));
        $$('[data-admin-unban]', el).forEach((b) => b.addEventListener('click', () => {
            adminAct(() => api.request('POST', `/api/admin/members/${b.dataset.adminUnban}/ban`, {
                body: { banned: false },
            }));
        }));
        $$('[data-admin-remove]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.adminRemove;
            armThen(`remove:${id}`, () => adminAct(
                () => api.request('DELETE', `/api/admin/members/${id}`),
            ));
        }));
        // Granting admin is one deliberate click; removing it arms first, because demoting
        // someone (or yourself — the server refuses that outright) is the consequential half.
        $$('[data-admin-promote]', el).forEach((b) => b.addEventListener('click', () => {
            adminAct(() => api.request('POST', `/api/admin/members/${b.dataset.adminPromote}/admin`, {
                body: { isAdmin: true },
            }), 'They are an administrator now.');
        }));
        $$('[data-admin-demote]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.adminDemote;
            armThen(`demote:${id}`, () => adminAct(
                () => api.request('POST', `/api/admin/members/${id}/admin`, { body: { isAdmin: false } }),
            ));
        }));
        // Tester is low-stakes either way — it only shows or hides the stream-quality tools —
        // so both directions are a single click. The button carries the state to move to.
        $$('[data-admin-tester]', el).forEach((b) => b.addEventListener('click', () => {
            const on = b.dataset.testerNext === '1';
            adminAct(() => api.request('POST', `/api/admin/members/${b.dataset.adminTester}/tester`, {
                body: { isTester: on },
            }), on ? 'They can see the stream-quality tools now.' : 'Stream-quality tools removed.');
        }));

        // -- channels --
        $$('[data-chan-edit]', el).forEach((b) => b.addEventListener('click', () => {
            adm.editingId = b.dataset.chanEdit; adm.armedKey = null; renderPanel();
            $('[data-chan-rename-input]', el)?.focus();
        }));
        $$('[data-chan-rename-save]', el).forEach((b) => b.addEventListener('click', () => {
            const name = $('[data-chan-rename-input]', el)?.value?.trim();
            const topic = $('[data-chan-topic-input]', el)?.value?.trim() ?? '';
            if (!name) return;
            adminAct(() => api.request('PUT', `/api/channels/${b.dataset.chanRenameSave}`, { body: { name, topic } }));
        }));
        $$('[data-chan-clear]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.chanClear;
            armThen(`clear:${id}`, () => adminAct(
                () => api.request('DELETE', `/api/chat/${id}/messages`),
                'History cleared for everyone.',
            ));
        }));
        $$('[data-chan-delete]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.chanDelete;
            armThen(`delete:${id}`, () => adminAct(
                () => api.request('DELETE', `/api/channels/${id}`),
            ));
        }));
        $('[data-admin-create-channel]', el)?.addEventListener('submit', (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const name = form.name.value.trim();
            const kind = form.kind.value;
            if (!name) return;
            adm.createBusy = true; renderPanel();
            adminAct(async () => {
                await api.request('POST', '/api/channels', {
                    body: {
                        name,
                        kind,
                        allowVoice: kind !== 'text',
                        allowText: kind !== 'voice',
                    },
                });
            }).finally(() => { adm.createBusy = false; renderPanel(); });
        });

        // -- sounds --
        $$('[data-preview-sound]', el).forEach((b) => b.addEventListener('click', () => {
            previewSound(b, b.dataset.previewSound);
        }));
        $$('[data-set-default]', el).forEach((b) => b.addEventListener('click', () => {
            adminAct(() => api.request('PUT', `/api/sounds/${b.dataset.setDefault}/default`, {
                body: { which: b.dataset.which },
            }));
        }));
        $$('[data-delete-sound]', el).forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.deleteSound;
            armThen(`delete-sound:${id}`, () => adminAct(
                () => api.request('DELETE', `/api/sounds/${id}`),
            ));
        }));
        $('[data-add-sound]', el)?.addEventListener('click', () => {
            $('[data-sound-file]', el)?.click();
        });
        $('[data-sound-file]', el)?.addEventListener('change', async (e) => {
            const files = [...(e.currentTarget.files ?? [])];
            if (!files.length) return;
            adm.soundUploadBusy = true; renderPanel();
            for (const file of files) {
                const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
                // One at a time and best-effort: a batch of 20 shouldn't abort on file 3
                // and lose the other 19 the user already picked.
                await api.uploadSound(file, name).catch((err) => {
                    adm.error = err?.message ?? `"${file.name}" could not be uploaded.`;
                });
            }
            adm.soundUploadBusy = false;
            await loadAdminData();
        });

        // -- server --
        $('[data-admin-refresh-logs]', el)?.addEventListener('click', () => loadAdminData());

        // -- the button --
        $('[data-doom-arm]', el)?.addEventListener('click', () => {
            adm.doom.stage = 'confirm'; renderPanel();
        });
        $$('[data-doom-cancel]', el).forEach((b) => b.addEventListener('click', () => {
            adm.doom = { stage: 'idle', typed: '', error: null, busy: false }; renderPanel();
        }));
        $('[data-doom-continue]', el)?.addEventListener('click', () => {
            adm.doom.stage = 'puzzle'; adm.doom.typed = ''; renderPanel();
            $('[data-doom-answer]', el)?.focus();
        });
        $('[data-doom-answer]', el)?.addEventListener('input', (e) => {
            adm.doom.typed = e.currentTarget.value;
            // Only the fire button's disabled state changes — repainting the panel would
            // steal the caret mid-word.
            const fire = $('[data-doom-fire]', el);
            const name = server?.lastSeen?.name ?? '';
            if (fire) fire.disabled = !(name && adm.doom.typed === name) || adm.doom.busy;
        });
        $('[data-doom-fire]', el)?.addEventListener('click', async () => {
            adm.doom.busy = true; adm.doom.error = null; renderPanel();
            try {
                await api.request('POST', '/api/admin/wipe', { body: { confirm: adm.doom.typed } });
                adm.doom = { stage: 'done', typed: '', error: null, busy: false };
                // The server is now cutting every socket, ours included; the link's
                // failure path walks the whole app back to the connect screen.
            } catch (err) {
                adm.doom.busy = false;
                adm.doom.error = err?.message ?? 'The server refused.';
            }
            renderPanel();
        });
    }

    /**
     * Choosing a picture.
     *
     * The picker owns the frame and the arithmetic; this owns the buttons and what
     * happens after a save. Rebuilt on every panel render because the elements it talks
     * to are replaced wholesale by renderPanel().
     */
    function wireAvatar() {
        const panel = $('#settingsPanel', modal.element);
        const file = $('[data-avatar-file]', panel);
        if (!file) return;

        picker = createAvatarPicker({
            root: panel,
            api,
            onSaved: (result) => {
                avatarError = '';
                me = { ...me, avatar: result.avatar ?? result.user?.avatar ?? null };
                onProfileChange(me);
                renderPanel();
            },
            onError: (message) => {
                avatarError = message;
                renderPanel();
            },
        });

        $('[data-pick-avatar]', panel)?.addEventListener('click', () => {
            avatarError = '';
            // Cleared first, so choosing the SAME file twice still fires a change event.
            file.value = '';
            file.click();
        });

        file.addEventListener('change', () => {
            const chosen = file.files?.[0];
            if (chosen) picker.open(chosen);
        });

        $('[data-crop-frame]', panel)?.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            picker.beginDrag(event);
        });

        $('[data-crop-zoom]', panel)?.addEventListener('input', (event) => {
            picker.setZoom(Number(event.target.value));
        });

        $('[data-crop-cancel]', panel)?.addEventListener('click', () => {
            picker.close();
            avatarError = '';
        });

        $('[data-crop-save]', panel)?.addEventListener('click', () => picker.save());

        $('[data-remove-avatar]', panel)?.addEventListener('click', async () => {
            try {
                await api.removeAvatar();
                me = { ...me, avatar: null };
                onProfileChange(me);
                avatarError = '';
            } catch (err) {
                avatarError = err?.message ?? 'The picture could not be removed.';
            }
            renderPanel();
        });
    }

    /* ── report a bug ────────────────────────────────────────────────────── */

    function wireBug() {
        $('[data-bug-again]', modal.element)?.addEventListener('click', () => {
            bug.sent = false;
            bug.description = '';
            bug.error = null;
            renderPanel();
        });

        $('[data-bug-toggle-log]', modal.element)?.addEventListener('click', () => {
            // Whatever has been typed survives the repaint, because losing a paragraph for
            // looking at the log would teach people not to look at the log.
            bug.description = $('[name="description"]', modal.element)?.value ?? bug.description;
            bug.showLog = !bug.showLog;
            renderPanel();
        });

        const form = $('[data-bug-report]', modal.element);
        if (!form) return;

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            clearErrors(form);

            const description = form.description.value.trim();
            if (!description) {
                setFieldError(form, 'description', 'Tell them what happened, in your own words.');
                return;
            }

            const button = $('button[type="submit"]', form);
            setBusy(button, true, 'Sending…');
            try {
                // To THIS server, and attributed: the api client carries the session token,
                // so an administrator can come back and ask. The endpoint accepts anonymous
                // reports too, which is what the update banner uses before sign-in.
                await api.request('POST', '/api/diagnostics', {
                    body: {
                        kind: 'bug',
                        description,
                        client: { version: VERSION, target: platform.target },
                        ...(bug.log ? { log: bug.log } : {}),
                    },
                });
                bug.sent = true;
                bug.description = '';
                bug.error = null;
                renderPanel();
            } catch (err) {
                setBusy(button, false);
                bug.description = description;
                setFormMessage(form, err?.message ?? 'That could not be sent.');
            }
        });
    }

    /* ── sessions & devices ──────────────────────────────────────────────── */

    async function loadSessions() {
        try {
            const { sessions } = await api.request('GET', '/api/me/sessions');
            deviceList.sessions = sessions ?? [];
            deviceList.error = null;
        } catch (err) {
            deviceList.sessions = [];
            deviceList.error = err?.message ?? 'Could not read your signed-in devices.';
        }
    }

    function wireSessions() {
        $$('[data-session-signout]', modal.element).forEach((button) => {
            button.addEventListener('click', async () => {
                const id = button.dataset.sessionSignout;
                setBusy(button, true, 'Signing out…');
                deviceList.notice = null;
                deviceList.error = null;
                try {
                    await api.request('DELETE', `/api/me/sessions/${encodeURIComponent(id)}`);
                    deviceList.notice = 'That device has been signed out.';
                } catch (err) {
                    deviceList.error = err?.message ?? 'That did not work.';
                }
                // Re-read rather than splicing the row out locally: the server has just
                // changed what is true, and a list that agrees with itself but not with the
                // server is how somebody ends up signing out a device twice.
                await loadSessions();
                renderPanel();
            });
        });
    }

    /* ── security & recovery ─────────────────────────────────────────────── */

    /**
     * The two forms on Security & Recovery.
     *
     * Deliberately nothing to do with set() and the [data-setting] listener below: that
     * path writes everything it touches to this device's storage, which is the last place
     * a password should end up. These post and then forget.
     */
    function wireSecurity() {
        const passwordForm = $('[data-change-password]', modal.element);
        if (passwordForm) {
            const button = $('button[type="submit"]', passwordForm);
            wireStrength(passwordForm);
            wireMatch(passwordForm, button);
            passwordForm.addEventListener('submit', (event) => {
                event.preventDefault();
                changePassword(passwordForm, button);
            });
        }

        const questionForm = $('[data-change-question]', modal.element);
        if (questionForm) {
            const button = $('button[type="submit"]', questionForm);
            questionForm.addEventListener('submit', (event) => {
                event.preventDefault();
                changeQuestion(questionForm, button);
            });
        }
    }

    /** The meter follows what is typed. It encourages; the server's ten characters gate. */
    function wireStrength(form) {
        const input = form.newPassword;
        const meter = $('.strength', form);
        const label = $('.strength-label', form);
        if (!input || !meter) return;

        input.addEventListener('input', () => {
            const { score, label: text } = passwordStrength(input.value);
            $$('i', meter).forEach((bar, i) => bar.classList.toggle('on', i < score));
            meter.dataset.score = String(score);
            if (label) label.textContent = input.value ? text : 'At least 10 characters.';
        });
    }

    /** Live match indicator, and the submit button follows it. */
    function wireMatch(form, button) {
        const a = form.newPassword;
        const b = form.confirmPassword;
        const label = $('.match-label', form);
        if (!a || !b || !button) return;

        const check = () => {
            const long = a.value.length >= 10;
            const same = a.value === b.value;
            const filled = b.value.length > 0;

            if (!filled) {
                label.textContent = '';
                label.className = 'field-help match-label';
            } else if (same) {
                label.textContent = '✓ Passwords match';
                label.className = 'field-help match-label ok';
            } else {
                label.textContent = "✗ Passwords don't match yet";
                label.className = 'field-help match-label bad';
            }
            button.disabled = !(long && same && filled);
        };

        a.addEventListener('input', check);
        b.addEventListener('input', check);
        check();
    }

    async function changePassword(form, button) {
        clearErrors(form);
        const currentPassword = form.currentPassword.value;
        const newPassword = form.newPassword.value;

        // Checked here as well as on the server so the common mistakes are answered without
        // a round trip. The server is still the authority, and says so in its own words.
        if (newPassword.length < 10) {
            setFieldError(form, 'newPassword', 'Use at least 10 characters.');
            return;
        }
        if (newPassword !== form.confirmPassword.value) {
            setFieldError(form, 'confirmPassword', "These don't match.");
            return;
        }

        setBusy(button, true, 'Saving…');
        try {
            const result = await api.request('POST', '/api/me/password', {
                // Which connection is ours, so the server signs out the other devices and
                // not this one. Absent where we are not in a room yet, and the server
                // simply spares nothing.
                body: { currentPassword, newPassword, ...(selfCid() ? { cid: selfCid() } : {}) },
            });
            const gone = result?.sessionsRevoked ?? 0;
            sec.error = null;
            sec.notice = gone
                ? `Password changed. ${gone} other session${gone === 1 ? '' : 's'} signed out.`
                : 'Password changed.';
            // Repainting is what takes the typed passwords back out of the page, which is
            // worth more here than avoiding a flicker.
            renderPanel();
        } catch (err) {
            setBusy(button, false);
            if (err?.field) setFieldError(form, err.field, err.message);
            else setFormMessage(form, err?.message ?? 'That did not work.');
        }
    }

    async function changeQuestion(form, button) {
        clearErrors(form);
        setBusy(button, true, 'Saving…');
        try {
            const result = await api.request('POST', '/api/me/security-question', {
                body: {
                    questionId: form.securityQuestion.value,
                    answer: form.securityAnswer.value,
                },
            });
            sec.question = result?.question ?? sec.question;
            sec.error = null;
            sec.notice = 'Security question saved.';
            renderPanel();
        } catch (err) {
            setBusy(button, false);
            if (err?.field) setFieldError(form, err.field, err.message);
            else setFormMessage(form, err?.message ?? 'That did not work.');
        }
    }

    function wirePanel() {
        paintActiveMic();
        wireAdminPanel();
        wireAvatar();
        wireSecurity();
        wireSessions();
        wireBug();
        $$('[data-setting]', modal.element).forEach((input) => {
            input.addEventListener('change', async () => {
                const value = input.type === 'checkbox' ? input.checked : input.value;
                await set(input.dataset.setting, value);
                // Controls that reveal or grey other controls redraw the panel.
                if (['pushToTalk', 'noiseGate'].includes(input.dataset.setting)) renderPanel();
            });
            // Sliders apply LIVE while dragging: a gain you cannot hear moving and a
            // threshold you cannot see against the meter would both be guesses.
            if (input.type === 'range') {
                input.addEventListener('input', () => {
                    const readout = $(`[data-value-for="${input.id}"]`, modal.element);
                    if (readout) readout.textContent = input.value + (input.id === 'micGain' ? '%' : '');
                    if (input.id === 'micGain') {
                        const reset = $('[data-reset-gain]', modal.element);
                        if (reset) reset.hidden = Number(input.value) === 100;
                    }
                    if (input.id === 'gateSensitivity') {
                        const mark = $('#micThreshMark', modal.element);
                        if (mark) mark.style.left = `${input.value}%`;
                    }
                    set(input.dataset.setting, input.value);
                });
            }
        });

        // A sound's preview follows whatever the select currently shows, not
        // necessarily what was last saved — you're previewing a choice, not replaying it.
        $$('[data-preview-sound-for]', modal.element).forEach((button) => {
            button.addEventListener('click', () => {
                const select = $(`#${button.dataset.previewSoundFor}`, modal.element);
                if (select?.value) previewSound(button, select.value);
            });
        });

        // The mic meter: the chain posts levels while a voice room is live; the panel
        // draws them only while someone is looking.
        const fill = $('#micMeterFill', modal.element);
        if (fill) {
            const onLevel = (event) => {
                const { db } = event.detail ?? {};
                // The meter axis IS the sensitivity slider's axis — same function, imported
                // rather than reimplemented. This panel used to carry its own copy of the
                // arithmetic, against a scale the gate had never used, and the bar and the
                // line therefore described different sounds.
                const pct = dbToMeterPercent(db);
                fill.style.width = `${pct}%`;
                // Open/closed is computed HERE, against the same slider the user drags —
                // the bar crossing the line and the state flipping are one fact twice.
                const threshold = Number($('#gateSensitivity', modal.element)?.value ?? 64);
                const gateOn = Boolean($('#noiseGate', modal.element)?.checked);
                const open = !gateOn || pct >= threshold;
                fill.classList.toggle('open', open);
                const stateLine = $('#gateState', modal.element);
                if (stateLine) {
                    stateLine.textContent = gateOn
                        ? (open ? 'Gate open — transmitting.' : 'Gate closed.')
                        : 'Gate off — always transmitting.';
                }
            };
            window.addEventListener('weave:mic-level', onLevel);
            modal.element.addEventListener('close', () => window.removeEventListener('weave:mic-level', onLevel), { once: true });
        }

        $('[data-capture-key]', modal.element)?.addEventListener('click', (event) => {
            captureKey(event.currentTarget);
        });

        $('[data-check-updates]', modal.element)?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const note = $('#updateCheckNote', modal.element);
            button.disabled = true;
            if (note) note.textContent = 'Checking…';
            const result = await Promise.resolve(checkForUpdates?.()).catch((err) => ({ started: false, message: String(err) }));
            button.disabled = false;
            if (note) {
                note.textContent = result?.started
                    ? (result.version ? `Found ${result.version} — the update bar takes it from here.` : 'Checked. You are on the newest version.')
                    : (result?.message ?? 'The check could not run.');
            }
        });

        $('[data-reset-gain]', modal.element)?.addEventListener('click', async () => {
            const input = $('#micGain', modal.element);
            if (input) {
                input.value = 100;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await set('micGain', '100');
            renderPanel();
        });

        $('[data-create-invite]', modal.element)?.addEventListener('click', createInvite);
        $('[data-copy-link]', modal.element)?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            if (!invite?.code || !server?.origin) return;
            try {
                await navigator.clipboard.writeText(inviteMessage({ origin: server.origin, code: invite.code }));
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

    /**
     * Fetch-and-play a library sound, or stop it — one button, two states.
     *
     * The audio route is authenticated, so this goes through `api.fetchBlob` and an
     * object URL rather than a plain `<audio src>`, the same shape `avatars.js` uses
     * for pictures behind the same session.
     */
    async function previewSound(button, id) {
        if (button._audio && !button._audio.paused) {
            button._audio.pause();
            button.textContent = '▶';
            return;
        }
        try {
            const blob = await api.fetchBlob(`/api/sounds/${encodeURIComponent(id)}/audio`);
            const audio = new Audio(URL.createObjectURL(blob));
            button._audio = audio;
            audio.addEventListener('ended', () => { button.textContent = '▶'; });
            button.textContent = '⏹';
            await audio.play();
        } catch {
            button.textContent = '▶';
        }
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
            cameras = all.filter((d) => d.kind === 'videoinput' && d.label);
            outputs = all.filter((d) => d.kind === 'audiooutput' && d.label);
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

            // Same principle: the server resolves the real value (a personal choice,
            // or the admin's default if there is one) — nothing to guess here.
            if (features.includes('module.sounds')) {
                await api.request('GET', '/api/sounds')
                    .then((r) => { soundLibrary = r.sounds ?? []; })
                    .catch(() => { soundLibrary = []; });
                await api.request('GET', '/api/sounds/me')
                    .then((r) => {
                        prefs = { ...prefs, joinSound: r.joinSound ?? '', leaveSound: r.leaveSound ?? '' };
                    })
                    .catch(() => { /* fall back to what this device remembers */ });
            }

            // Read here so the panel can SHOW it. Redaction already happened in the main
            // process, so this is the text itself rather than a promise about it — which is
            // the whole basis on which somebody decides to press send.
            if (platform.diagnostics.available) {
                await platform.diagnostics.readAppLog?.()
                    .then((result) => { bug.log = result?.text ?? null; })
                    .catch(() => { bug.log = null; });
            }

            // Asked on open rather than when the panel is first shown: the list is small,
            // and a screen that draws itself empty and then fills in is a screen people
            // click on before it is telling the truth.
            if (features.includes('account.sessions')) await loadSessions();

            // Both halves belong to the server: which questions it offers, and which one
            // this account chose. Asked only where the routes exist, so an older server is
            // never sent a request it can only 404.
            if (features.includes('account.security')) {
                sec.error = null;
                sec.notice = null;
                await api.securityQuestions()
                    .then((r) => { sec.questions = r.questions ?? []; })
                    .catch(() => { sec.questions = []; });
                await api.request('GET', '/api/me/security-question')
                    .then((r) => { sec.question = r.question ?? null; })
                    .catch(() => {
                        sec.question = null;
                        sec.error = 'Could not read your current security question.';
                    });
            }

            modal.open({ from, content: '' });
            render();
            loadDevices().then(() => { if (current === 'voice') renderPanel(); });
            // Reopening onto an admin panel must show fresh truth, not last week's table.
            loadAdminData();
        },

        close: () => modal.close(),

        /**
         * Redraw if this is open and showing the profile.
         *
         * Called when an avatar finishes downloading. The room repaints itself on the same
         * event; this panel is a separate piece of DOM and would otherwise sit on initials
         * until something else happened to re-render it.
         */
        refreshProfile() {
            if (!modal.isOpen) return;
            if (current !== 'profile') return;
            if (!$('#settingsPanel', modal.element)) return;
            renderPanel();
        },
    };
}
