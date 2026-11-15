// A profile card: yours in Settings, anybody's from a right-click.
//
// The card is one pure view drawn by both places, so what is asserted here is what both
// show — and the gating around it: which faces open full size, which messages can be
// right-clicked for a profile, where a banner may be chosen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { profileCard, joinedOn } from '../src/room/views/profile.js';
import { profilePanel, joinedOn as joinedFromSettings } from '../src/settings/panels.js';
import { timeline } from '../src/room/views/timeline.js';
import { toTimelineItems } from '../src/room/messages.js';

const KES = {
    id: 'u2', username: 'kestrel', displayName: 'Kestrel',
    avatar: 'a.webp', avatarUrl: 'blob:face', createdAt: '2026-08-27 10:00:00',
};

test('a card shows the name, the username and when they joined', () => {
    const card = profileCard({ person: KES });
    assert.match(card, /Kestrel/);
    assert.match(card, /@kestrel/);
    assert.match(card, new RegExp(`joined ${joinedOn(KES.createdAt)}`));
    assert.ok(!card.includes('badge admin'), 'no badge for somebody who does not run the server');
    assert.match(profileCard({ person: { ...KES, isAdmin: true } }), /badge admin/);

    // An older server sends no date; the line simply ends at the username.
    assert.ok(!profileCard({ person: { ...KES, createdAt: null } }).includes('joined'));
});

test('the date moved, and Settings still answers with the same one', () => {
    assert.equal(joinedFromSettings, joinedOn);
});

test('a banner is drawn as a picture that fills the strip, and its absence as the gradient', () => {
    const plain = profileCard({ person: KES });
    assert.match(plain, /class="profile-banner"/);
    assert.ok(!plain.includes('profile-banner-img'));

    const withBanner = profileCard({ person: KES, bannerUrl: 'blob:strip' });
    assert.match(withBanner, /class="profile-banner has-image"/);
    assert.match(withBanner, /<img class="profile-banner-img" src="blob:strip"/);
});

test('only a real picture can be opened full size', () => {
    const open = profileCard({ person: KES, enlargeable: true });
    assert.match(open, /<button[^>]*data-profile-enlarge/);
    assert.match(open, /aria-label="Show Kestrel's picture full size"/);

    // Initials blown up to 512px are not a photograph.
    const noFace = profileCard({ person: { ...KES, avatarUrl: null }, enlargeable: true });
    assert.ok(!noFace.includes('data-profile-enlarge'));

    // Settings draws the card without it: your own picture is a button away already.
    assert.ok(!profileCard({ person: KES }).includes('data-profile-enlarge'));
});

test('everything on a card that came from a server is escaped', () => {
    const evil = {
        username: '"><img src=x onerror=alert(1)>',
        displayName: '<script>alert(1)</script>',
        avatarUrl: 'javascript:"><b>',
        createdAt: null,
    };
    const card = profileCard({ person: evil, bannerUrl: '"><b>banner', enlargeable: true });
    assert.ok(!card.includes('<script>'));
    assert.ok(!card.includes('<img src=x'));
    assert.ok(!card.includes('"><b>'), 'neither picture URL can leave its attribute');
});

test('the banner row is offered only by a server that has the route', () => {
    const me = { username: 'kes', banner: null };
    const without = profilePanel({ me, features: ['profile'] });
    assert.ok(!without.includes('data-pick-banner'), 'a button that can only 404 is worse than none');

    const withIt = profilePanel({ me, features: ['profile', 'profile.banner'] });
    assert.match(withIt, /data-pick-banner/);
    assert.match(withIt, /data-banner-crop-frame/);
    assert.match(withIt, /data-banner-crop-save/);
    assert.ok(!withIt.includes('data-remove-banner'), 'nothing to remove yet');

    const hasOne = profilePanel({ me: { ...me, banner: 'b.webp', bannerUrl: 'blob:b' }, features: ['profile', 'profile.banner'] });
    assert.match(hasOne, /data-remove-banner/);
    assert.match(hasOne, /profile-banner-img/, 'and your own card shows it');

    // The two croppers answer to different attributes, so one panel can hold both.
    assert.match(withIt, /data-crop-frame/);
    assert.ok(withIt.indexOf('data-crop-frame') !== withIt.indexOf('data-banner-crop-frame'));
});

test('a message author with an account can be right-clicked; a departed one cannot', () => {
    const users = new Map([['u2', KES]]);
    const items = toTimelineItems([
        { id: 'm1', userId: 'u2', authorName: 'kestrel', body: 'hello', createdAt: 1_000 },
        { id: 'm2', userId: 'gone', authorName: 'ghost', body: 'boo', createdAt: 900_000 },
    ], { users });
    const markup = timeline({ items });

    assert.match(markup, /class="avatar lg"[^>]*data-author="kestrel"/);
    assert.match(markup, /class="msg-author" data-author="kestrel"/);
    assert.ok(!markup.includes('data-author="ghost"'), 'no account, no profile to open');
    // Never the whole row: right-clicking the text is how somebody copies it.
    assert.ok(!/<li[^>]*data-author/.test(markup));
    // Not data-person, which the speaking ring toggles on ten times a second.
    assert.ok(!markup.includes('data-person'));
});
