// The stage and the share picker: the pure halves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stageView, orderTiles, tileKey, sharePickerView } from '../src/room/views/stage.js';

const t = (cid, slot, extra = {}) => ({ key: tileKey(cid, slot), cid, slot, label: cid, live: true, ...extra });

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

test('a grid without focus, a main-and-strip with one', () => {
    const tiles = [t('kes', 'screen'), t('moth', 'webcam')];
    const grid = stageView({ tiles });
    assert.match(grid, /stage-grid/);
    assert.ok(!grid.includes('stage-main'));

    const focused = stageView({ tiles, focus: 'kes:screen' });
    assert.match(focused, /stage-main/);
    assert.match(focused, /stage-strip/);
    assert.match(focused, /data-tile="kes:screen"[^>]*/);
    assert.match(focused, /focused/);
});

test('a focus on a tile that left falls back to the grid', () => {
    const view = stageView({ tiles: [t('moth', 'webcam')], focus: 'kes:screen' });
    assert.match(view, /stage-grid/);
    assert.ok(!view.includes('stage-main'));
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

test('the FOCUSED stream carries the pill: listen controls, fullscreen, the way out', () => {
    const focused = stageView({
        tiles: [t('kes', 'screen', { audio: { muted: false, volume: 0.8 } })],
        focus: 'kes:screen',
    });
    assert.match(focused, /stream-pill/);
    assert.match(focused, /data-listen-mute/);
    assert.match(focused, /data-listen-volume[^>]*value="80"/);
    assert.match(focused, /data-tile-full/);
    assert.match(focused, /data-stop-watching/);
    assert.match(focused, /live-badge/);

    // A thumbnail beside it wears its identity chip, never the pill.
    const withThumb = stageView({
        tiles: [t('kes', 'screen', { audio: { muted: false, volume: 1 } }), t('moth', 'webcam')],
        focus: 'kes:screen',
    });
    assert.equal((withThumb.match(/stream-pill/g) ?? []).length, 1);
    assert.match(withThumb, /tile-chip/);
});

test('a muted-for-you stream says so on the pill', () => {
    const view = stageView({
        tiles: [t('kes', 'screen', { audio: { muted: true, volume: 1 } })],
        focus: 'kes:screen',
    });
    assert.match(view, /data-listen-mute[^>]*aria-pressed="true"/);
});

test('a focused stream without audio keeps fullscreen and the way out', () => {
    const view = stageView({ tiles: [t('kes', 'webcam', { audio: null })], focus: 'kes:webcam' });
    assert.ok(!view.includes('data-listen-mute'));
    assert.match(view, /data-tile-full/);
    assert.match(view, /data-stop-watching/);
});

test('grid tiles offer the centred Watch, screens declare LIVE, the divider offers the drag', () => {
    const grid = stageView({ tiles: [t('kes', 'screen'), t('moth', 'webcam')] });
    assert.match(grid, /watch-btn/);
    assert.match(grid, /data-watch-tile="kes:screen"/);
    assert.match(grid, /live-badge small/);
    assert.match(grid, /data-stage-divider/);
    assert.ok(!grid.includes('stream-pill'), 'no pill without a focus');

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
        tiles: [t('a', 'screen'), t('b', 'webcam'), t('c', 'webcam'), t('d', 'webcam'), t('e', 'webcam')],
        focus: 'a:screen',
    });
    assert.ok(!four.includes('strip-nav'), 'four thumbnails need no chrome');

    const six = stageView({
        tiles: [t('a', 'screen'), t('b', 'webcam'), t('c', 'webcam'),
            t('d', 'webcam'), t('e', 'webcam'), t('f', 'webcam')],
        focus: 'a:screen',
    });
    assert.match(six, /data-strip-nav="-1"/);
    assert.match(six, /data-strip-nav="1"/);
    assert.match(six, /strip-shell scrollable/);
});
