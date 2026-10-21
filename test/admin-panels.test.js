// The administrator screens added with the web app's port: the birthday and per-person
// sounds, restrictions in force, invite codes, server settings, and the audit trail.
//
// As with the other settings tests, the reasons matter as much as the controls: a server
// too old for a screen says so in a line rather than offering buttons that would 404.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    adminSoundsPanel, adminModerationPanel, adminInvitesPanel, adminSettingsPanel, adminServerPanel,
    restrictionText, inviteExpiry, auditAction, SETTINGS_SHOWN_ELSEWHERE,
} from '../src/settings/admin.js';

const SOUNDS = [{ id: 's1', name: 'Fanfare', bytes: 2048 }, { id: 's2', name: 'Door', bytes: 1024 }];
const PEOPLE = [
    { id: 'u1', username: 'kes', displayName: 'Kestrel', joinSound: 's1', leaveSound: null },
    { id: 'u2', username: 'wren', displayName: null, joinSound: null, leaveSound: null },
];

/* ── sounds ───────────────────────────────────────────────────────────────── */

test('the birthday names a person and a sound, and offers to clear one that is set', () => {
    const markup = adminSoundsPanel({
        sounds: SOUNDS, people: PEOPLE, birthday: { userId: 'u1', soundId: 's2', user: PEOPLE[0] },
    });
    assert.match(markup, /data-birthday-form/);
    assert.match(markup, /<option value="u1" selected>Kestrel/);
    assert.match(markup, /<option value="s2" selected>Door/);
    assert.match(markup, /data-birthday-clear/);

    const none = adminSoundsPanel({ sounds: SOUNDS, people: PEOPLE, birthday: { userId: null, soundId: null } });
    assert.ok(!none.includes('data-birthday-clear'), 'nothing to clear');
});

test('each person can be given a sound, and an unchosen one reads as the default', () => {
    const markup = adminSoundsPanel({ sounds: SOUNDS, people: PEOPLE, birthday: { userId: null, soundId: null } });
    const kes = markup.split('data-person-sounds="u1"')[1].split('data-person-sounds=')[0];
    assert.match(kes, /data-person-sound="join"[\s\S]*<option value="s1" selected>Fanfare/);
    assert.match(kes, /data-person-sound="leave"[\s\S]*<option value="" selected>Default leave/);
    assert.match(markup, /@wren/, 'a person with no display name is shown by username');
});

test('a server too old for the birthday and per-person sounds says so', () => {
    const markup = adminSoundsPanel({ sounds: SOUNDS, people: false, birthday: false });
    assert.match(markup, /cannot play a birthday sound yet/);
    assert.match(markup, /cannot choose sounds for people yet/);
    assert.ok(!markup.includes('data-birthday-form'));
    assert.ok(!markup.includes('data-person-sound'));
});

test('a birthday needs a sound to choose from first', () => {
    const markup = adminSoundsPanel({ sounds: [], people: PEOPLE, birthday: { userId: null, soundId: null } });
    assert.match(markup, /Add a sound first/);
});

/* ── moderation ───────────────────────────────────────────────────────────── */

test('each restriction says what it is and until when', () => {
    assert.equal(restrictionText({ action: 'mute', expiresAt: null }), 'Server-muted until lifted');
    assert.match(restrictionText({ action: 'mute', expiresAt: Date.now() + 60_000 }), /^Server-muted until /);
    assert.match(restrictionText({ action: 'kick', expiresAt: Date.now() + 60_000 }), /^Kicked — can come back at /);
});

test('a mute can be lifted from the list; a kick runs out on its own', () => {
    const markup = adminModerationPanel({
        restrictions: [
            { userId: 'u1', username: 'kes', displayName: 'Kestrel', action: 'mute', expiresAt: null, byUsername: 'admin' },
            { userId: 'u2', username: 'wren', action: 'kick', expiresAt: Date.now() + 30_000 },
        ],
    });
    assert.match(markup, /data-lift-mute="u1"/);
    assert.ok(!markup.includes('data-lift-mute="u2"'), 'there is no lifting a kick cooldown');
    assert.match(markup, /by @admin/);
});

test('an empty list, a loading list and an old server each read differently', () => {
    assert.match(adminModerationPanel({ restrictions: [] }), /Nobody is muted or kicked/);
    assert.match(adminModerationPanel({ restrictions: null }), /Loading restrictions/);
    assert.match(adminModerationPanel({ restrictions: false }), /cannot list who is restricted/);
});

test('names in the restriction list are escaped', () => {
    const markup = adminModerationPanel({
        restrictions: [{ userId: 'x', username: 'x', displayName: '<img src=x>', action: 'mute', expiresAt: null }],
    });
    assert.ok(!markup.includes('<img src=x>'));
});

/* ── invites ──────────────────────────────────────────────────────────────── */

test('an invite says how used it is and when it stops working', () => {
    const now = 1_000_000;
    assert.equal(inviteExpiry(null, now), 'never expires');
    assert.equal(inviteExpiry(now - 1, now), 'expired');
    assert.match(inviteExpiry(now + 3_600_000, now), /^expires /);

    const markup = adminInvitesPanel({
        now,
        invites: [{ code: 'ABCD-EFGH', uses: 1, maxUses: 1, expiresAt: now - 5, createdByName: 'kes', note: 'for Moth' }],
    });
    assert.match(markup, /ABCD-EFGH/);
    assert.match(markup, /1 of 1 used · expired · by @kes · for Moth/);
    assert.match(markup, /data-invite-revoke="ABCD-EFGH"/);
});

test('revoking an invite arms before it fires', () => {
    const armed = adminInvitesPanel({ invites: [{ code: 'C1', uses: 0, maxUses: 1 }], armedKey: 'invite:C1' });
    assert.match(armed, /Revoke — sure\?/);
});

/* ── server settings ──────────────────────────────────────────────────────── */

const GROUPS = [
    { owner: 'afk', items: [{ key: 'afk.idleMinutes', label: 'Minutes before moving', type: 'number', min: 1, max: 1440, value: 20 }] },
    { owner: 'sounds', items: [
        { key: 'sounds.enabled', label: 'Play join and leave sounds', type: 'boolean', value: true },
        { key: 'sounds.defaultJoinSound', label: 'Default join sound', type: 'string', value: 's1' },
    ] },
];
const MODULES = [
    { id: 'afk', name: 'Away', description: 'Moves idle people', enabled: true },
    { id: 'sounds', name: 'Sounds', description: 'Join and leave sounds', enabled: false },
];

test('settings render from what the server declares, each by its type', () => {
    const markup = adminSettingsPanel({ groups: GROUPS, modules: MODULES });
    // The web app's AFK timeout, as the away module's own setting.
    assert.match(markup, /type="number"[^>]*data-server-setting="afk\.idleMinutes"[^>]*value="20"/);
    assert.match(markup, /min="1"/);
    assert.match(markup, /data-server-setting="sounds\.enabled" data-setting-type="boolean"\s*checked/);
    assert.match(markup, /<h3 class="panel-section">Away<\/h3>/, 'grouped under the module name');
});

test('ids with a proper home elsewhere are not offered as text boxes here', () => {
    assert.ok(SETTINGS_SHOWN_ELSEWHERE.has('sounds.birthdayUserId'));
    const markup = adminSettingsPanel({ groups: GROUPS, modules: MODULES });
    assert.ok(!markup.includes('sounds.defaultJoinSound'));
});

test('modules can be switched on and off, and say so', () => {
    const markup = adminSettingsPanel({ groups: [], modules: MODULES });
    assert.match(markup, /data-module-toggle="afk"\s*checked/);
    assert.ok(!/data-module-toggle="sounds"\s*checked/.test(markup));
    // A server setting must never ride the device-preference path, which writes to this
    // machine's storage rather than to the server.
    assert.ok(!markup.includes('data-setting='));
});

/* ── server ───────────────────────────────────────────────────────────────── */

test('the server screen links to the web console and lists who did what', () => {
    const markup = adminServerPanel({
        overview: { uptimeSeconds: 60, connections: {}, counts: {}, database: {}, media: {} },
        logs: { entries: [] },
        audit: [{ action: 'ADMIN_SERVER_MUTED', target: 'kes', actor: 'admin', at: '2026-10-21 10:00:00', detail: '60m' }],
        consoleUrl: 'https://weave.example/admin',
    });
    assert.match(markup, /href="https:\/\/weave\.example\/admin" target="_blank"/);
    assert.match(markup, /Server muted · kes/);
    assert.match(markup, /by @admin · 60m/);
    assert.equal(auditAction('ADMIN_SETTINGS'), 'Settings');
    assert.equal(auditAction(undefined), 'Unknown');
});
