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
    appearancePanel, invitesPanel, placeholderPanel, PLACEHOLDER_REASONS, settingsFrame,
} from '../src/settings/panels.js';

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
    const markup = placeholderPanel({ label: 'Sessions & Devices', reason: PLACEHOLDER_REASONS.sessions });
    assert.match(markup, /Sessions &amp; Devices/);
    assert.match(markup, /Not built yet/);
    assert.match(markup, /server update/);
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

test('the profile panel is honest about what it cannot change', () => {
    const markup = profilePanel({ me: ME, prefs: {}, features: [] });

    assert.match(markup, /Ghostbyte/);
    assert.match(markup, /@ghostbyte/);
    assert.match(markup, /joined/);

    // The display name field exists because the design has it, but it is disabled and says
    // why rather than accepting a change that would silently go nowhere.
    assert.match(markup, /id="displayName"[^>]*disabled/);
    assert.match(markup, /no route to change it/);
    assert.match(markup, /Profile picture/);
    assert.match(markup, /Status/);
});

test('a disabled module is named as the reason, not hidden', () => {
    // "The personas module is switched off" is actionable — an admin can turn it on.
    // Silently omitting the control leaves somebody hunting for a feature they were shown.
    const off = profilePanel({ me: ME, features: [] });
    assert.match(off, /personas module is switched off/);

    // AFK behaviour lives with the microphone now, in Voice & Audio.
    const voiceOff = voicePanel({ prefs: {}, features: [] });
    assert.match(voiceOff, /away module is switched off/);

    const voiceOn = voicePanel({ prefs: {}, features: ['module.afk'] });
    assert.match(voiceOn, /Exempt me from being moved when idle/);
    assert.ok(!voiceOn.includes('away module is switched off'));
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
