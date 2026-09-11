// Settings.
//
// Most of what matters here is what the screen says about the things it cannot do. A
// disabled control with no explanation is the worst outcome: it looks broken, and the
// person meeting it cannot tell whether the feature is missing, their account lacks
// permission, or something failed. So the tests below care as much about the reasons as
// about the controls.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__WEAVE_TARGET__ = 'desktop';

import {
    SECTIONS, sectionById, joinedOn, profilePanel, voicePanel,
    appearancePanel, invitesPanel, inviteMessage, placeholderPanel, PLACEHOLDER_REASONS, settingsFrame, sessionsPanel,
    securityPanel, lastActive, bugPanel,
} from '../src/settings/panels.js';
import {
    adminUsersPanel, adminChannelsPanel, adminSoundsPanel, adminDangerPanel, adminBugsPanel, reversedName,
} from '../src/settings/admin.js';

const ME = { id: 'u1', username: 'ghostbyte', displayName: 'Ghostbyte', createdAt: '2026-02-04T10:00:00Z' };

test('every placeholder section has a reason written for it', () => {
    // A section marked "not built" with no explanation is the exact thing this screen is
    // trying not to be.
    const placeholders = SECTIONS.flatMap((s) => s.items).filter((i) => i.placeholder);
    assert.ok(placeholders.length > 0);

    for (const item of placeholders) {
        const reason = PLACEHOLDER_REASONS[item.id];
        assert.ok(reason, `${item.id} is a placeholder with no reason`);
        assert.ok(reason.length > 40, `${item.id}'s reason is too thin to be useful`);
    }
});

test('a placeholder panel says what it is and why it is empty', () => {
    const markup = placeholderPanel({ label: 'Privacy & Blocking', reason: PLACEHOLDER_REASONS.privacy });
    assert.match(markup, /Privacy &amp; Blocking/);
    assert.match(markup, /Not built yet/);
    assert.match(markup, /only cosmetic/);
});

test('an unknown section falls back rather than rendering nothing', () => {
    assert.equal(sectionById('no-such-panel').id, SECTIONS[0].items[0].id);
    assert.equal(sectionById('voice').label, 'Voice & Audio');
});

test('a join date is shown when the server sent one, and skipped when it did not', () => {
    assert.match(joinedOn('2026-02-04T10:00:00Z'), /2026/);
    assert.equal(joinedOn(null), null);
    assert.equal(joinedOn('not a date'), null, 'a bad value must not render "Invalid Date"');
});

test('a SQLite datetime is read as UTC, not as local time', () => {
    // datetime('now') returns "2026-08-23 14:01:59" — UTC, but with a space and no zone
    // marker, which `new Date` parses as LOCAL. An account created late in the UTC day then
    // shows the wrong date to anyone west of London.
    const sqlite = '2026-08-23 23:30:00';
    assert.equal(joinedOn(sqlite), joinedOn('2026-08-23T23:30:00Z'));

    // And the ordinary ISO form still works untouched.
    assert.equal(joinedOn('2026-08-23T23:30:00Z'), joinedOn('2026-08-23T23:30:00.000Z'));
});

test('the profile panel shows who you are without offering controls that do nothing', () => {
    const markup = profilePanel({ me: ME, prefs: {}, features: [] });

    assert.match(markup, /Ghostbyte/);
    assert.match(markup, /@ghostbyte/);
    assert.match(markup, /joined/);

    // The display name used to sit here as a disabled input explaining that the server had
    // no route to change one — a control whose only function was to refuse. The name is on
    // the card above, where it is a fact rather than an invitation to try.
    assert.ok(!markup.includes('id="displayName"'), 'no box that cannot be typed in');
    assert.ok(!markup.includes('no route to change it'));

    // Status is not here either: it lives behind your own name in the bottom bar, because
    // one buried in a preferences dialog is one nobody sets and nobody trusts.
    assert.ok(!/not-yet-what">Status/.test(markup));
});

test('the profile picture is offered only where the server can store one', () => {
    const withIt = profilePanel({ me: ME, features: ['profile'] });
    assert.match(withIt, /Profile picture/);
    assert.match(withIt, /data-pick-avatar/);

    const without = profilePanel({ me: ME, features: [] });
    assert.ok(!without.includes('data-pick-avatar'), 'no button that would only 404');
    assert.match(without, /no route to attach one/);
});

test('a picture already chosen is rendered, not just referenced', () => {
    // The bug this covers: the panel was handed `avatar` (an id) but never `avatarUrl`,
    // so it drew initials for ever while the same person appeared correctly in the room.
    const withFace = profilePanel({
        me: { ...ME, avatar: 'abc.webp', avatarUrl: 'blob:xyz' },
        features: ['profile'],
    });
    assert.match(withFace, /<img class="avatar-face" src="blob:xyz"/);
    assert.match(withFace, /data-remove-avatar/, 'and can be taken off again');

    // An id with no resolved URL yet falls back to initials rather than a broken image.
    const stillLoading = profilePanel({
        me: { ...ME, avatar: 'abc.webp', avatarUrl: null },
        features: ['profile'],
    });
    assert.ok(!stillLoading.includes('<img class="avatar-face"'));
});

test('a disabled module is named as the reason, not hidden', () => {
    // "The sounds module is switched off" is actionable — an admin can turn it on.
    // Silently omitting the control leaves somebody hunting for a feature they were shown.
    const off = profilePanel({ me: ME, features: [] });
    assert.match(off, /sounds module is switched off/);

    // AFK behaviour lives with the microphone now, in Voice & Audio.
    const voiceOff = voicePanel({ prefs: {}, features: [] });
    assert.match(voiceOff, /away module is switched off/);

    const voiceOn = voicePanel({ prefs: {}, features: ['module.afk'] });
    assert.match(voiceOn, /Exempt me from being moved when idle/);
    assert.ok(!voiceOn.includes('away module is switched off'));
});

test('join and leave sounds move through three states: off, empty, and pickable', () => {
    const off = profilePanel({ me: ME, features: [] });
    assert.ok(!off.includes('data-setting="joinSound"'));

    // The module is on, but nobody has uploaded anything yet — a real reason, not the
    // "not loaded yet" guess this used to say before the library was ever fetched.
    const empty = profilePanel({ me: ME, features: ['module.sounds'], soundLibrary: [] });
    assert.match(empty, /No sounds have been uploaded to this server yet/);
    assert.ok(!empty.includes('data-setting="joinSound"'));

    const sounds = [{ id: 'a1', name: 'Arrival' }, { id: 'd1', name: 'Departure' }];
    const populated = profilePanel({
        me: ME, features: ['module.sounds'], soundLibrary: sounds,
        prefs: { joinSound: 'd1', leaveSound: 'a1' },
    });
    assert.match(populated, /data-setting="joinSound"/);
    assert.match(populated, /data-setting="leaveSound"/);
    assert.match(populated, /Arrival/);
    assert.match(populated, /Departure/);
    // Whatever the server resolved (a personal choice, or an admin default) is what's
    // selected — not necessarily the first sound in the list.
    assert.match(populated, /<option value="d1" selected>Departure<\/option>/);
    assert.match(populated, /<option value="a1" selected>Arrival<\/option>/);
});

test('the sounds admin panel shows the library, marks the defaults, and offers to add or delete', () => {
    assert.match(adminSoundsPanel({ sounds: null }), /Loading sounds/);
    assert.match(adminSoundsPanel({ sounds: [] }), /No sounds uploaded yet/);

    const markup = adminSoundsPanel({
        sounds: [
            { id: 's1', name: 'Arrival', bytes: 12000 },
            { id: 's2', name: 'Departure', bytes: 8000 },
        ],
        defaults: { joinSound: 's1', leaveSound: null },
    });
    assert.match(markup, /Arrival/);
    assert.match(markup, /Departure/);
    assert.match(markup, /class="badge default">Join default/);
    assert.ok(!markup.includes('Leave default'), 'no badge for a default that is not set');
    assert.match(markup, /data-set-default="s2" data-which="join"/, 'the non-default row still offers to become one');
    assert.ok(!markup.includes('data-set-default="s1" data-which="join"'), 'already the default, nothing to offer');
    assert.match(markup, /data-add-sound/);

    const armed = adminSoundsPanel({
        sounds: [{ id: 's1', name: 'Arrival', bytes: 12000 }],
        armedKey: 'delete-sound:s1',
    });
    assert.match(armed, /Delete sound\?/);
});

test('push-to-talk reveals its key only when it is on', () => {
    // Moved to Voice & Audio: everything the microphone does lives on one screen.
    const off = voicePanel({ prefs: { pushToTalk: false } });
    assert.match(off, /id="pttKey"[^>]*disabled/);

    const on = voicePanel({ prefs: { pushToTalk: true, pushToTalkKey: 'KeyV' } });
    assert.match(on, /KeyV/);
    assert.ok(!/id="pttKey"[^>]*disabled/.test(on));
});

test('audio switches default to on, matching what the microphone already does', () => {
    // The defaults have to agree with voice.js, or opening settings would appear to change
    // something the moment it is looked at.
    const markup = voicePanel({ prefs: {} });
    const checked = [...markup.matchAll(/data-setting="(\w+)"\s*checked/g)].map((m) => m[1]);
    for (const key of ['noiseSuppression', 'echoCancellation', 'autoGainControl']) {
        assert.ok(checked.includes(key), `${key} should default to on`);
    }
});

test('sound optimisation is offered and starts off', () => {
    // Off because it changes how somebody already sounds, and nobody asked for that. The
    // three browser flags above it are a different case — those have always been on.
    const markup = voicePanel({ prefs: {} });
    assert.match(markup, /data-setting="voiceOptimize"/);
    assert.ok(!/data-setting="voiceOptimize"\s*checked/.test(markup), 'opt in, not out');
    assert.match(voicePanel({ prefs: { voiceOptimize: true } }), /data-setting="voiceOptimize"\s*checked/);
});

test('an explicit false is respected rather than treated as unset', () => {
    const markup = voicePanel({ prefs: { noiseSuppression: false } });
    assert.ok(!/data-setting="noiseSuppression"\s*checked/.test(markup));
});

test('microphone selection explains its absence rather than showing an empty list', () => {
    // Device labels are blank until access is granted, so an empty picker is the normal
    // state before a call rather than a fault.
    const none = voicePanel({ prefs: {}, devices: [] });
    assert.match(none, /only readable once microphone access/);

    const some = voicePanel({ prefs: {}, devices: [{ deviceId: 'a', label: 'Headset' }] });
    assert.match(some, /Headset/);
});

test('appearance offers the still background and says what else it follows', () => {
    const markup = appearancePanel({ prefs: { staticBackground: true } });
    assert.match(markup, /data-setting="staticBackground"\s*checked/);
    assert.match(markup, /reduce motion/);
});

test('an invite is shown large enough to read aloud', () => {
    const markup = invitesPanel({ invite: { code: 'JD2K-CNDA-EQ6G-36TA', maxUses: 1, expiresAt: null } });
    assert.match(markup, /JD2K-CNDA-EQ6G-36TA/);
    assert.match(markup, /Single use/);
    assert.match(markup, /never expires/);
});

test('an invite failure is shown rather than swallowed', () => {
    const markup = invitesPanel({ error: 'Too many invites. Try again later.' });
    assert.match(markup, /Too many invites/);
});

test('a hostile display name cannot become markup anywhere in settings', () => {
    const hostile = { username: 'evil', displayName: '<img src=x onerror="steal()">' };
    for (const markup of [
        profilePanel({ me: hostile, prefs: {}, features: [] }),
        settingsFrame({ me: hostile, current: 'profile', body: '', serverName: hostile.displayName }),
        securityPanel({
            features: ['account.security'],
            questions: [{ id: 'q1', text: hostile.displayName }],
            question: { id: 'q1', text: hostile.displayName },
        }),
    ]) {
        assert.ok(!markup.includes('<img src=x'));
        assert.ok(!/\son\w+\s*=\s*["']/.test(markup));
        assert.match(markup, /&lt;img/);
    }
});

test('the frame marks the current section for sighted and assistive users alike', () => {
    const markup = settingsFrame({ me: ME, current: 'appearance', body: '<p>x</p>' });
    assert.match(markup, /data-panel="appearance"[^>]*aria-current="page"/);
    assert.match(markup, /class="nav-item current"/);
    assert.match(markup, /Esc to close/);
    assert.match(markup, /data-sign-out/);
});

test('the copied invite is a self-sufficient message: link, server address, code, and what to do with each', () => {
    const msg = inviteMessage({ origin: 'https://weave.example', code: 'JD2K-CNDA-EQ6G-36TA' });
    assert.match(msg, /Visit https:\/\/weave\.example\/invite\/JD2K-CNDA-EQ6G-36TA/);
    assert.match(msg, /download/i, 'says the link downloads the installer');
    assert.match(msg, /copy https:\/\/weave\.example and paste it into the server connection/i);
    assert.match(msg, /copy JD2K-CNDA-EQ6G-36TA and paste it in during account creation/i);
});


/* ── the admin console ────────────────────────────────────────────────────── */

test('the Admin group exists only for administrators', () => {
    const admin = settingsFrame({ me: { ...ME, isAdmin: true }, current: 'profile', body: '' });
    assert.match(admin, /Admin/);
    assert.match(admin, /data-panel="admin-users"/);
    assert.match(admin, /DO NOT PRESS/);

    const mortal = settingsFrame({ me: { ...ME, isAdmin: false }, current: 'profile', body: '' });
    assert.ok(!mortal.includes('data-panel="admin-users"'), 'no admin nav for non-admins');
    assert.ok(!mortal.includes('DO NOT PRESS'));
});

test('the users panel tells the whole story of each account', () => {
    const markup = adminUsersPanel({
        members: [
            { id: 'u1', username: 'kestrel', displayName: 'Kestrel', invitedBy: 'admin',
                banned: true, mustReset: true, isAdmin: false, offline: true },
            { id: 'u2', username: 'admin', displayName: 'Admin', invitedBy: null,
                banned: false, mustReset: false, isAdmin: true, offline: false },
        ],
    });
    assert.match(markup, /invited by admin/);
    assert.match(markup, /founder/, 'no inviter reads as founder, not as blank');
    assert.match(markup, /class="badge banned"/);
    assert.match(markup, /class="badge reset"/);
    assert.match(markup, /class="badge admin"/);
    assert.match(markup, /data-admin-unban="u1"/, 'a banned account offers Unban');
    assert.match(markup, /data-admin-ban="u2"/, 'an active account offers Ban');
    assert.match(markup, /data-admin-reset="u1"/);
    assert.match(markup, /data-admin-remove="u1"/);
});

test('a destructive button armed shows its question; others stay resting', () => {
    const markup = adminUsersPanel({
        members: [{ id: 'u1', username: 'kestrel', displayName: 'Kestrel' }],
        armedKey: 'remove:u1',
    });
    assert.match(markup, /Erase account\?/);
    assert.match(markup, /Reset password/, 'the unarmed neighbours keep their labels');
});

test('the channels panel: clear only where text exists, and the create form', () => {
    const markup = adminChannelsPanel({
        channels: [
            { id: 'c1', name: 'lounge', allowVoice: true, allowText: true, isDefault: true },
            { id: 'c2', name: 'stage', allowVoice: true, allowText: false },
            { id: 'c3', name: 'secret', private: true },
        ],
    });
    assert.match(markup, /data-chan-clear="c1"/);
    assert.ok(!markup.includes('data-chan-clear="c2"'), 'no text, nothing to clear');
    assert.ok(!markup.includes('secret'), 'private huddles are not the console\'s furniture');
    assert.match(markup, /landing room/);
    assert.match(markup, /data-admin-create-channel/);
});

test('the danger panel walks its stages, and the puzzle is the name reversed', () => {
    assert.equal(reversedName('Weave'), 'evaeW');

    const idle = adminDangerPanel({ stage: 'idle', serverName: 'Weave' });
    assert.match(idle, /DO NOT PRESS/);
    assert.ok(!idle.includes('data-doom-fire'), 'no live trigger while idle');

    const confirm = adminDangerPanel({ stage: 'confirm', serverName: 'Weave' });
    assert.match(confirm, /This destroys everything/);
    assert.match(confirm, /data-doom-continue/);

    const puzzle = adminDangerPanel({ stage: 'puzzle', serverName: 'Weave', typed: 'nope' });
    assert.match(puzzle, /evaeW/, 'the riddle is shown backwards');
    assert.match(puzzle, /data-doom-fire disabled/, 'wrong answer keeps the button dead');

    const solved = adminDangerPanel({ stage: 'puzzle', serverName: 'Weave', typed: 'Weave' });
    assert.match(solved, /data-doom-fire >/, 'the exact name unlocks it');
});

test('hostile names cannot become markup in the admin console', () => {
    const hostile = '<img src=x onerror="steal()">';
    for (const markup of [
        adminUsersPanel({ members: [{ id: 'u1', username: 'x', displayName: hostile, invitedBy: hostile }] }),
        adminChannelsPanel({ channels: [{ id: 'c1', name: hostile, allowText: true }] }),
        adminDangerPanel({ stage: 'puzzle', serverName: hostile, typed: hostile }),
    ]) {
        assert.ok(!markup.includes('<img src=x'));
        assert.match(markup, /&lt;img/);
    }
});

test('the sessions panel states the RUNNING version, because updates install on restart', () => {
    const markup = sessionsPanel({ version: '9.9.9' });
    assert.match(markup, /Weave 9\.9\.9/);
    assert.match(markup, /installs when the app restarts/);
});

// ── the preference contract ──────────────────────────────────────────────────

test('every control the settings panels persist survives a round trip', async () => {
    // A structural test, deliberately. Eight preferences — the noise gate, input gain,
    // gate sensitivity, camera device/resolution/fps and both stream settings — were
    // written by set() and then dropped by readPrefs(), because readPrefs copies only the
    // keys DEFAULTS names. Nothing failed; the values just quietly reverted at every app
    // start and every time the modal reopened, which is why it survived so long.
    //
    // Asserting against the RENDERED markup rather than a hand-kept list is the point: a
    // control added tomorrow without a default fails here rather than in a bug report.
    const { DEFAULTS } = await import('../src/settings/index.js');
    const prefs = { ...DEFAULTS };
    const markup = [
        voicePanel({ prefs, devices: [], cameras: [], features: [] }),
        appearancePanel({ prefs }),
        profilePanel({
            me: ME, prefs, features: ['module.sounds'],
            soundLibrary: [{ id: 's1', name: 'Arrival' }],
        }),
    ].join('\n');

    const named = [...markup.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(named.length > 5, 'the panels should expose several settings to check');

    for (const key of new Set(named)) {
        assert.ok(key in DEFAULTS, `"${key}" is persisted but absent from DEFAULTS, so readPrefs drops it`);
    }
});

test('a stored stream preset is the one that comes back', async () => {
    // The structural test above proves DEFAULTS names every control. This proves the
    // consequence people actually felt: picking 1080p60 and getting 1080p30 back, because
    // readPrefs seeded from DEFAULTS and copied only the keys it already knew.
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
    const { readPrefs } = await import('../src/settings/index.js');
    const { settingsFor } = await import('../src/server/store.js');

    const store = settingsFor('server-1');
    store.set('streamPreset', '1080p60');
    store.set('micGain', 160);
    store.set('noiseGate', true);

    const prefs = readPrefs('server-1');
    assert.equal(prefs.streamPreset, '1080p60');
    assert.equal(prefs.micGain, 160, 'input gain is not silently reset to unity');
    assert.equal(prefs.noiseGate, true, 'a gate the user switched on stays on');
});

/* ── security & recovery ──────────────────────────────────────────────────── */

const FLAG = ['account.security'];
const QUESTIONS = [
    { id: 'first_pet', text: 'What was the name of your first pet?' },
    { id: 'first_car', text: 'What was the make and model of your first car?' },
];

test('an older server keeps its explanation rather than a form that can only fail', () => {
    const markup = securityPanel({ features: [], questions: QUESTIONS });
    assert.ok(!markup.includes('data-change-password'), 'no form against a server without the route');
    assert.match(markup, /older than the app/);
    // The route that DOES still work is the one worth naming.
    assert.match(markup, /forgotten-password/);
});

test('with the server behind it, both forms are there', () => {
    const markup = securityPanel({ features: FLAG, questions: QUESTIONS });
    assert.match(markup, /data-change-password/);
    assert.match(markup, /data-change-question/);
    // The field names are the contract with the server: a 400 names one of these, and the
    // client highlights the box by that name.
    for (const name of ['currentPassword', 'newPassword', 'confirmPassword', 'securityQuestion', 'securityAnswer']) {
        assert.match(markup, new RegExp(`name="${name}"`), `${name} must keep its name`);
    }
    // Saying what will happen before it happens, because signing out your phone is a
    // surprise if you only find out afterwards.
    assert.match(markup, /other devices will be signed out/i);
});

test('nothing on this screen is a preference', () => {
    // data-setting is what routes a control through set(), which writes it to this device's
    // localStorage. A password reaching that path would be the one real mistake available
    // in this panel.
    const markup = securityPanel({ features: FLAG, questions: QUESTIONS, question: QUESTIONS[0] });
    assert.ok(!markup.includes('data-setting'), 'a password must never be persisted anywhere');
});

test('the question you already chose is the one already selected', () => {
    const markup = securityPanel({ features: FLAG, questions: QUESTIONS, question: QUESTIONS[1] });
    assert.match(markup, /<option value="first_car" selected>/);
    assert.ok(!markup.includes('<option value="first_pet" selected>'));
    // And it is said in words too, so the screen answers "which one is it?" without
    // anybody opening the dropdown.
    assert.match(markup, /You will be asked: What was the make/);
});

test('an account with no question is told so, rather than shown a guess', () => {
    const markup = securityPanel({ features: FLAG, questions: QUESTIONS, question: null });
    assert.match(markup, /no security question yet/);
    assert.ok(!markup.includes('selected'), 'nothing is pre-selected when nothing was chosen');
});

test('what went wrong is shown, and what went right is too', () => {
    assert.match(
        securityPanel({ features: FLAG, error: 'Could not read your current security question.' }),
        /Could not read your current/,
    );
    assert.match(
        securityPanel({ features: FLAG, notice: 'Password changed. 2 other sessions signed out.' }),
        /2 other sessions signed out/,
    );
});

/* ── sessions & devices ───────────────────────────────────────────────────── */

const NOW = Date.parse('2026-09-11T12:00:00Z');
const ago = (ms) => NOW - ms;
const SESSIONS = [
    {
        id: 's1', current: true, device: 'Weave desktop on Windows', kind: 'client',
        createdAt: '2026-09-09 08:15:00', lastUsedAt: ago(30_000),
    },
    {
        id: 's2', current: false, device: 'Chrome on Android', kind: 'client',
        createdAt: '2026-09-01 19:40:00', lastUsedAt: ago(3 * 60 * 60 * 1000),
    },
];

test('an older server is told apart from an account with no devices', () => {
    // Both of these draw an empty list, and they mean completely different things.
    const old = sessionsPanel({ version: '0.1.61', features: [] });
    assert.ok(!old.includes('data-session-signout'));
    assert.match(old, /older than the app/);

    const reading = sessionsPanel({ version: '0.1.61', features: ['account.sessions'], sessions: null });
    assert.match(reading, /Reading your devices/);
});

test('each device says what it is and when it was last used', () => {
    const markup = sessionsPanel({
        version: '0.1.61', features: ['account.sessions'], sessions: SESSIONS, now: NOW,
    });
    assert.match(markup, /Weave desktop on Windows/);
    assert.match(markup, /Chrome on Android/);
    assert.match(markup, /Signed in 9 September 2026 · last active just now/);
    assert.match(markup, /last active 3 hours ago/);
});

test('the device you are reading on is marked, and cannot be signed out from the list', () => {
    // Signing out the device you are holding would leave the app looking signed in until
    // its next request failed. Sign out is its own button and does it properly.
    const markup = sessionsPanel({
        version: '0.1.61', features: ['account.sessions'], sessions: SESSIONS, now: NOW,
    });
    assert.match(markup, /This device/);
    assert.ok(!markup.includes('data-session-signout="s1"'), 'no way to sign out the current one');
    assert.match(markup, /data-session-signout="s2"/);
});

test('the version is still the running one, whatever the device list does', () => {
    // The panel gained a whole feature; the thing it already did must survive it.
    const markup = sessionsPanel({ version: '0.1.61', features: ['account.sessions'], sessions: SESSIONS });
    assert.match(markup, /Weave 0\.1\.61/);
    assert.match(markup, /data-check-updates/);
});

test('what happened to the last sign-out is said, either way', () => {
    assert.match(
        sessionsPanel({ features: ['account.sessions'], sessions: [], notice: 'That device has been signed out.' }),
        /has been signed out/,
    );
    assert.match(
        sessionsPanel({ features: ['account.sessions'], sessions: [], error: 'That session has already gone.' }),
        /already gone/,
    );
});

test('a hostile device name cannot become markup', () => {
    // The name is built from a user agent, which is a string somebody else chose.
    const markup = sessionsPanel({
        features: ['account.sessions'],
        sessions: [{ id: 'x', current: false, device: '<img src=x onerror="steal()">', createdAt: null, lastUsedAt: null }],
    });
    assert.ok(!markup.includes('<img src=x'));
    assert.match(markup, /&lt;img/);
});

test('how long ago is said in the words somebody would use', () => {
    const now = NOW;
    assert.equal(lastActive(now - 5_000, now), 'just now');
    assert.equal(lastActive(now - 80_000, now), 'just now');
    assert.equal(lastActive(now - 12 * 60_000, now), '12 minutes ago');
    assert.equal(lastActive(now - 60 * 60_000, now), '1 hour ago');
    assert.equal(lastActive(now - 5 * 60 * 60_000, now), '5 hours ago');
    assert.equal(lastActive(now - 2 * 24 * 60 * 60_000, now), '2 days ago');
    // Past a week the date is the more useful answer again.
    assert.equal(lastActive(Date.parse('2026-08-01T10:00:00Z'), now), '1 August 2026');
    // A session from before last_used_at was recorded says nothing rather than 1970.
    assert.equal(lastActive(null, now), null);
    assert.equal(lastActive(0, now), null);
});

/* ── report a bug ─────────────────────────────────────────────────────────── */

const BUG_FLAG = ['diagnostics.bug-report'];

test('a server with no diagnostics module says so rather than offering a form', () => {
    const markup = bugPanel({ features: [], serverName: 'Weave Dev' });
    assert.ok(!markup.includes('data-bug-report'));
    assert.match(markup, /nowhere for a report to land/);
});

test('the report is addressed to this server, and said to be', () => {
    // Self-hosted software quietly sending diagnostics to its author is not a thing anybody
    // asked for. Who receives this is the first thing the screen says.
    const markup = bugPanel({ features: BUG_FLAG, serverName: 'Weave Dev' });
    assert.match(markup, /Weave Dev/);
    assert.match(markup, /never to anyone else/);
    assert.match(markup, /name="description"/);
});

test('what is attached is stated in bytes, and can be read in full', () => {
    // The requirement this screen exists to keep: redaction happens on this machine, and
    // what is shown IS what would be sent rather than a promise about it.
    const collapsed = bugPanel({ features: BUG_FLAG, logAvailable: true, log: 'x'.repeat(2048) });
    assert.match(collapsed, /Attached: 2 KB/);
    assert.match(collapsed, /Show me exactly what will be sent/);
    assert.ok(!collapsed.includes(String.raw`<pre class="bug-log"`), 'not shown until asked for');

    const shown = bugPanel({ features: BUG_FLAG, logAvailable: true, log: 'secret-looking line', showLog: true });
    assert.match(shown, /<pre class="bug-log"[^>]*>secret-looking line/);
    assert.match(shown, /Hide it/);
});

test('a build with no log says the description is the report', () => {
    // A browser has no log file to read. Refusing the report would lose the part that
    // matters most, which is what the person actually says.
    const markup = bugPanel({ features: BUG_FLAG, logAvailable: false });
    assert.match(markup, /No log is attached/);
    assert.match(markup, /name="description"/);
});

test('a half-written description survives a repaint', () => {
    // Looking at the log repaints the panel. Losing the paragraph for it would teach
    // people not to look.
    const markup = bugPanel({ features: BUG_FLAG, description: 'The stream froze at 8pm.' });
    assert.match(markup, /The stream froze at 8pm\./);
});

test('a sent report says so and offers to start another', () => {
    const markup = bugPanel({ features: BUG_FLAG, sent: true });
    assert.match(markup, /your report has been sent/i);
    assert.match(markup, /data-bug-again/);
    assert.ok(!markup.includes('data-bug-report'), 'the form is gone, so it cannot be sent twice');
});

test('a description cannot become markup, in the panel or in the admin view', () => {
    const hostile = '<img src=x onerror="steal()">';
    for (const markup of [
        bugPanel({ features: BUG_FLAG, description: hostile, log: hostile, logAvailable: true, showLog: true }),
        adminBugsPanel({ reports: [{ name: 'r.json', description: hostile, from: hostile }], total: 1 }),
        adminBugsPanel({ open: { description: hostile, log: hostile, from: { username: hostile } } }),
    ]) {
        assert.ok(!markup.includes('<img src=x'));
        assert.match(markup, /&lt;img/);
    }
});

test('the admin list is told apart from an empty one', () => {
    assert.match(adminBugsPanel({ reports: null }), /Loading reports/);
    assert.match(adminBugsPanel({ reports: [], total: 0 }), /Nothing has been reported/);
});

test('a report opens with both sides of the moment', () => {
    const markup = adminBugsPanel({
        open: {
            receivedAt: '2026-09-11T18:30:00Z',
            kind: 'bug',
            from: { username: 'chris' },
            client: { version: '0.1.61', target: 'desktop' },
            description: 'Screen share froze.',
            log: 'client line',
            server: { loadPerCore: 1.4 },
            serverLog: [{ msg: 'server line' }, 'a plain line'],
        },
    });
    assert.match(markup, /chris/);
    assert.match(markup, /Weave 0\.1\.61/);
    assert.match(markup, /Screen share froze\./);
    assert.match(markup, /client line/);
    assert.match(markup, /loadPerCore/);
    assert.match(markup, /server line/);
    assert.match(markup, /a plain line/);
    assert.match(markup, /data-bug-close/);
});

test('an unreadable report hands over the bytes rather than nothing', () => {
    const markup = adminBugsPanel({ open: { raw: '{ this is not json' } });
    assert.match(markup, /this is not json/);
});
