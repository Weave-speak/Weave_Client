// The stage and the share picker: the pure halves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stageView, orderTiles, tileKey, sharePickerView } from '../src/room/views/stage.js';

const t = (cid, slot, extra = {}) => ({ key: tileKey(cid, slot), cid, slot, label: cid, ...extra });

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

test('remote tiles carry listening tools; your own preview never does', () => {
    const remote = stageView({ tiles: [t('kes', 'screen', { audio: { muted: false, volume: 0.8 } })] });
    assert.match(remote, /data-listen-mute/);
    assert.match(remote, /data-listen-volume[^>]*value="80"/);
    assert.match(remote, /data-tile-full/);

    const mine = stageView({ tiles: [t('self', 'webcam', { self: true, label: 'You' })] });
    assert.ok(!mine.includes('data-listen-mute'));
    assert.ok(!mine.includes('data-tile-full'));
});

test('a muted-for-you stream says so on its button', () => {
    const view = stageView({ tiles: [t('kes', 'screen', { audio: { muted: true, volume: 1 } })] });
    assert.match(view, /data-listen-mute[^>]*aria-pressed="true"/);
});

test('a videoless tile still offers fullscreen but no audio tools', () => {
    const view = stageView({ tiles: [t('kes', 'webcam', { audio: null })] });
    assert.ok(!view.includes('data-listen-mute'));
    assert.match(view, /data-tile-full/);
});
