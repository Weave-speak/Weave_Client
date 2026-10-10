// The stage and the share picker: the pure halves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stageView, orderTiles, tileKey, sharePickerView, shareSetupView, MAX_WATCHED } from '../src/room/views/stage.js';
import { SHARE_QUALITIES, SHARE_CONTENT } from '../src/media/presets.js';

const t = (cid, slot, extra = {}) => ({ key: tileKey(cid, slot), cid, slot, label: cid, live: true, ...extra });
/** A stream the person chose to watch. */
const w = (cid, slot, extra = {}) => t(cid, slot, { watched: true, ...extra });
const count = (markup, re) => (markup.match(re) ?? []).length;

test('no video, no stage — the room looks exactly as it always did', () => {
    assert.equal(stageView({ tiles: [] }), '');
    assert.equal(stageView(), '');
});

test('screens outrank cameras, and your own face comes last', () => {
    const ordered = orderTiles([
        t('me', 'webcam', { self: true }),
        t('kes', 'webcam'),
        t('kes', 'screen'),
        t('me', 'screen', { self: true }),
    ]);
    assert.deepEqual(ordered.map((x) => x.key),
        ['kes:screen', 'me:screen', 'kes:webcam', 'me:webcam']);
});

test('nothing watched is a compact row; something watched takes the big area', () => {
    const grid = stageView({ tiles: [t('kes', 'screen'), t('moth', 'webcam')] });
    assert.match(grid, /stage-grid/);
    assert.ok(!grid.includes('stage-main'));

    const watching = stageView({ tiles: [w('kes', 'screen'), t('moth', 'webcam')] });
    assert.match(watching, /stage has-focus/);
    assert.match(watching, /stage-main/);
    assert.match(watching, /stage-strip/);
    assert.match(watching, /watch-grid" data-count="1"/);
    assert.match(watching, /tile focused watched[^"]*"\s*data-tile="kes:screen"/);
});

test('several watched streams share the big area, each with its own controls', () => {
    const view = stageView({
        tiles: [w('kes', 'screen', { audio: { muted: false, volume: 1 } }), w('moth', 'screen'), t('ash', 'webcam')],
    });
    assert.match(view, /watch-grid" data-count="2"/);
    assert.equal(count(view, /class="stream-pill"/g), 2, 'one pill per watched stream');
    assert.equal(count(view, /data-stop-watching/g), 2, 'each can be stopped on its own');
    assert.equal(count(view, /data-tile-full/g), 2, 'and each can go fullscreen');
    // The unwatched camera waits in the strip, still an invitation.
    const strip = view.slice(view.indexOf('stage-strip'));
    assert.match(strip, /data-watch-tile="ash:webcam"/);
    assert.ok(!strip.includes('stream-pill'));
});

test('a spotlight makes one stream big; the other watched ones keep playing in the strip', () => {
    const tiles = [w('kes', 'screen'), w('moth', 'screen'), t('ash', 'webcam', { live: false })];
    const view = stageView({ tiles, spotlight: 'moth:screen' });
    const main = view.slice(view.indexOf('stage-main'), view.indexOf('strip-shell'));
    const strip = view.slice(view.indexOf('stage-strip'));

    assert.ok(!main.includes('watch-grid'), 'one picture, not a grid of one');
    assert.match(main, /data-tile="moth:screen"/);
    assert.ok(!main.includes('kes:screen'));
    assert.match(main, /data-spotlight[^>]*aria-pressed="true"/, 'and the way back to the grid');

    assert.match(strip, /tile watched[^"]*"\s*data-tile="kes:screen"/);
    assert.match(strip, /data-tile="kes:screen"[^]*?<video/, 'still live, not a placeholder');
    assert.ok(!/data-watch-tile="kes:screen"/.test(strip), 'already watched: nothing to offer');
    assert.match(strip, /data-watch-tile="ash:webcam"/);
});

test('a spotlight on a stream that is not watched falls back to the grid', () => {
    const tiles = [w('kes', 'screen'), w('moth', 'screen'), t('ash', 'webcam')];
    const gone = stageView({ tiles, spotlight: 'ghost:screen' });
    assert.match(gone, /watch-grid" data-count="2"/);
    const unwatched = stageView({ tiles, spotlight: 'ash:webcam' });
    assert.match(unwatched, /watch-grid" data-count="2"/);
    const none = stageView({ tiles: [t('moth', 'webcam')], spotlight: 'moth:webcam' });
    assert.match(none, /stage-grid/);
    assert.ok(!none.includes('stage-main'));
});

test('the spotlight is only offered when there is more than one stream to choose between', () => {
    const one = stageView({ tiles: [w('kes', 'screen'), t('ash', 'webcam')] });
    assert.ok(!one.includes('data-spotlight'));
    const two = stageView({ tiles: [w('kes', 'screen'), w('moth', 'webcam')] });
    assert.equal(count(two, /data-spotlight/g), 2);
    assert.match(two, /data-spotlight[^>]*aria-pressed="false"/);
});

test('at the watch limit, the remaining Watch buttons are drawn disabled; your own are not', () => {
    const tiles = [w('kes', 'screen'), t('ash', 'webcam'), t('self', 'screen', { self: true, live: false })];
    const open = stageView({ tiles });
    assert.ok(!/data-watch-tile="ash:webcam"\s+disabled/.test(open));

    const full = stageView({ tiles, watchLimitReached: true });
    assert.match(full, /data-watch-tile="ash:webcam"\s+disabled/);
    assert.match(full, new RegExp(`Watching ${MAX_WATCHED} streams`));
    assert.ok(!/data-watch-tile="self:screen"\s+disabled/.test(full), 'your own stream costs nothing to watch');
});

test('your own preview is muted and mirrored; a screen never is', () => {
    const cam = stageView({ tiles: [t('self', 'webcam', { self: true, label: 'You' })] });
    assert.match(cam, /<video autoplay playsinline muted>/);
    assert.match(cam, /tile self/);

    const someone = stageView({ tiles: [t('kes', 'webcam')] });
    assert.match(someone, /<video autoplay playsinline >/);
});

test('a hostile display name cannot become markup on a tile', () => {
    const view = stageView({ tiles: [t('kes', 'webcam', { label: '<img src=x onerror=steal()>' })] });
    assert.ok(!view.includes('<img src=x'));
    assert.match(view, /&lt;img/);
});

test('the picker splits screens from windows and escapes window titles', () => {
    const view = sharePickerView({
        sources: [
            { id: 'screen:0:0', kind: 'screen', name: 'Entire screen', thumb: 'data:image/png;base64,x' },
            { id: 'window:1:0', kind: 'window', name: '<script>evil()</script> — Notepad', thumb: 'data:image/png;base64,y' },
        ],
    });
    assert.match(view, /Screens/);
    assert.match(view, /Windows/);
    assert.ok(!view.includes('<script>evil'));
    assert.match(view, /&lt;script&gt;/);
    assert.match(view, /id="shareAudio" checked/, 'computer audio rides along by default');
});

/** The value of the one checked radio in a named group, read out of the markup. */
const checkedIn = (markup, name) => [...markup.matchAll(/<input type="radio" name="([^"]+)" value="([^"]+)" ([^>]*)>/g)]
    .filter((m) => m[1] === name && /\bchecked\b/.test(m[3]))
    .map((m) => m[2]);

test('the share chooser offers every quality and both kinds of content', () => {
    const view = shareSetupView({});
    for (const key of Object.keys(SHARE_QUALITIES)) assert.match(view, new RegExp(`name="quality" value="${key}"`));
    for (const key of Object.keys(SHARE_CONTENT)) assert.match(view, new RegExp(`name="content" value="${key}"`));
    assert.match(view, /High/);
    assert.match(view, /1440p/, 'the tier the web app has and this app did not');
    assert.match(view, /Source/);
});

test('the share chooser opens on the last choice, exactly one per group', () => {
    const view = shareSetupView({ quality: '1440p', content: 'text' });
    assert.deepEqual(checkedIn(view, 'quality'), ['1440p']);
    assert.deepEqual(checkedIn(view, 'content'), ['text']);

    // With nothing remembered, the defaults — and still exactly one each, so the form can
    // never submit an empty group.
    const fresh = shareSetupView();
    assert.deepEqual(checkedIn(fresh, 'quality'), ['1080p']);
    assert.deepEqual(checkedIn(fresh, 'content'), ['video']);
});

test('nothing starts until "Choose screen", and there is a way out', () => {
    // On the web app, clicking a quality started the share at once — so the content type,
    // which sat BELOW the qualities, had to be picked first. Here the cards only select.
    const view = shareSetupView({});
    assert.equal((view.match(/type="submit"/g) ?? []).length, 1, 'one thing starts a share');
    assert.match(view, /type="submit"[^>]*data-share-go[^>]*data-initial-focus/, 'and Enter reaches it');
    assert.ok((view.match(/data-share-cancel/g) ?? []).length >= 1);
    assert.ok(!/<button[^>]*name="quality"/.test(view), 'a quality is a choice, not a button that acts');
});

test('a WATCHED stream carries the pill: listen controls, fullscreen, the way out', () => {
    const focused = stageView({
        tiles: [w('kes', 'screen', { audio: { muted: false, volume: 0.8 } })],
    });
    assert.match(focused, /stream-pill/);
    assert.match(focused, /data-listen-mute/);
    assert.match(focused, /data-listen-volume[^>]*value="80"/);
    assert.match(focused, /data-tile-full/);
    assert.match(focused, /data-stop-watching/);
    assert.match(focused, /live-badge/);

    // A thumbnail beside it wears its identity chip, never the pill.
    const withThumb = stageView({
        tiles: [w('kes', 'screen', { audio: { muted: false, volume: 1 } }), t('moth', 'webcam')],
    });
    assert.equal((withThumb.match(/stream-pill/g) ?? []).length, 1);
    assert.match(withThumb, /tile-chip/);
});

test('a muted-for-you stream says so on the pill', () => {
    const view = stageView({
        tiles: [w('kes', 'screen', { audio: { muted: true, volume: 1 } })],
    });
    assert.match(view, /data-listen-mute[^>]*aria-pressed="true"/);
});

test('a watched stream without audio keeps fullscreen and the way out', () => {
    const view = stageView({ tiles: [w('kes', 'webcam', { audio: null })] });
    assert.ok(!view.includes('data-listen-mute'));
    assert.match(view, /data-tile-full/);
    assert.match(view, /data-stop-watching/);
});

test('grid tiles offer the centred Watch, screens declare LIVE, the divider offers the drag', () => {
    const grid = stageView({ tiles: [t('kes', 'screen'), t('moth', 'webcam')] });
    assert.match(grid, /watch-btn/);
    assert.match(grid, /data-watch-tile="kes:screen"/);
    assert.match(grid, /live-badge small/);
    assert.ok(!grid.includes('data-stage-divider'),
        'no divider while nothing is watched — the compact row sizes itself');
    assert.ok(!grid.includes('stream-pill'), 'no pill while nothing is watched');

    const focused = stageView({ tiles: [w('kes', 'screen'), t('moth', 'webcam')] });
    assert.match(focused, /data-stage-divider/, 'the split brings the drag with it');

    const sized = stageView({ tiles: [t('kes', 'screen')], heightPx: 400 });
    assert.match(sized, /style="height: 400px"/);
});

test('an unwatched stream is a placeholder: no video, no packets, just the invitation', () => {
    const screen = stageView({ tiles: [t('kes', 'screen', { live: false })] });
    assert.ok(!screen.includes('<video'), 'nothing is being received');
    assert.match(screen, /ph-screen/);
    assert.match(screen, /tile idle/);
    assert.match(screen, /data-watch-tile="kes:screen"/);

    const cam = stageView({ tiles: [t('kes', 'webcam', { live: false, chipName: 'kestrel' })] });
    assert.match(cam, /ph-face/, 'a camera placeholder wears the face, not stripes');
    assert.match(cam, /KE/, 'initials come from the person');
});

test('the strip is a carousel: quiet at four, scroll buttons past it', () => {
    const four = stageView({
        tiles: [w('a', 'screen'), t('b', 'webcam'), t('c', 'webcam'), t('d', 'webcam'), t('e', 'webcam')],
    });
    assert.ok(!four.includes('strip-nav'), 'four thumbnails need no chrome');

    const six = stageView({
        tiles: [w('a', 'screen'), t('b', 'webcam'), t('c', 'webcam'),
            t('d', 'webcam'), t('e', 'webcam'), t('f', 'webcam')],
    });
    assert.match(six, /data-strip-nav="-1"/);
    assert.match(six, /data-strip-nav="1"/);
    assert.match(six, /strip-shell scrollable/);
});

test('a stopped stream wears its last frame blurred — a picture, but not a live one', () => {
    const still = stageView({ tiles: [t('kes', 'screen', {
        live: false, frame: 'data:image/jpeg;base64,AAAA',
    })] });
    assert.ok(!still.includes('<video'), 'the feed is gone');
    assert.match(still, /ph-still/);
    assert.match(still, /ph-blur/);
    assert.match(still, /data:image\/jpeg;base64,AAAA/);
    assert.match(still, /data-watch-tile="kes:screen"/, 'and the way back in is right there');

    const never = stageView({ tiles: [t('kes', 'screen', { live: false })] });
    assert.match(never, /ph-screen/, 'never-watched streams keep the plain placeholder');
});
