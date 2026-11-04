// Sending a message, from any composer.
//
// The channel composer and a bubble's card used to send through two hand-written paths, and
// the second had drifted: no pasted pictures, and a chosen picture sent before anything
// could be said with it. These tests hold the one shared path to what the server accepts,
// and the last one makes sure no composer goes back to building its own frames.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    outgoingMessage, pastedImage, attachmentClaim, createAttachmentSlot, ATTACHABLE, ATTACH_ERROR_MS,
} from '../src/room/compose.js';
import { attachChipView } from '../src/room/views/attach.js';
import { bubblePopupView } from '../src/room/views/bubbles.js';

const UPLOAD = { id: '0b6c2a8e-3f4d-4b8a-9c1e-2d3f4a5b6c7d', mime: 'image/png', bytes: 2048, url: '/api/uploads/0b6c2a8e-3f4d-4b8a-9c1e-2d3f4a5b6c7d' };
const CLAIM = { id: UPLOAD.id, mime: 'image/png', bytes: 2048, name: 'shot.png' };

test('one builder sends to every kind of place, each with its own address field', () => {
    assert.deepEqual(outgoingMessage({ kind: 'channel', id: 'c1' }, { body: ' hi ' }),
        { type: 'text-chat:send', payload: { channelId: 'c1', body: 'hi' } });
    assert.deepEqual(outgoingMessage({ kind: 'dm', id: 't1' }, { body: 'hi' }),
        { type: 'dm:send', payload: { threadId: 't1', body: 'hi' } });
    assert.deepEqual(outgoingMessage({ kind: 'bubble', id: 'b1' }, { body: 'hi' }),
        { type: 'bubbles:send', payload: { bubbleId: 'b1', body: 'hi' } });
});

test('a picture rides the same way everywhere, and alone it is a whole message', () => {
    for (const [kind, type] of [['channel', 'text-chat:send'], ['dm', 'dm:send'], ['bubble', 'bubbles:send']]) {
        const out = outgoingMessage({ kind, id: 'x' }, { body: '', attachment: CLAIM });
        assert.equal(out.type, type);
        assert.deepEqual(out.payload.attachment, CLAIM, kind);
        assert.equal(out.payload.body, '', `${kind}: no words is fine with a picture`);
    }
});

test('nothing to say, or nowhere to say it, sends nothing', () => {
    assert.equal(outgoingMessage({ kind: 'bubble', id: 'b1' }, { body: '   ' }), null);
    assert.equal(outgoingMessage({ kind: 'channel', id: null }, { body: 'hi' }), null,
        'standing nowhere and viewing nothing: there is no "here"');
    assert.equal(outgoingMessage({ kind: 'mystery', id: 'x' }, { body: 'hi' }), null);
    assert.equal(outgoingMessage(null, { body: 'hi' }), null);
});

/** A stand-in for a paste event's clipboardData. */
const clipboard = ({ text = '', files = [] } = {}) => ({ getData: (kind) => (kind === 'text/plain' ? text : ''), files });

test('a pasted screenshot becomes a picture; pasted words stay words', () => {
    const png = { type: 'image/png', name: 'image.png' };
    assert.equal(pastedImage(clipboard({ files: [png] })), png);
    assert.equal(pastedImage(clipboard({ text: 'a paragraph', files: [png] })), null,
        'text copied with a rendered picture of itself must paste as text');
    assert.equal(pastedImage(clipboard({ files: [{ type: 'image/heic' }] })), null, 'only what the server takes');
    assert.equal(pastedImage(clipboard({ files: [{ type: 'application/pdf' }, png] })), png);
    assert.equal(pastedImage(null), null);
    assert.deepEqual(ATTACHABLE, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        'the server\'s list (core/media/attachment.js)');
});

test('a message claims an upload by id, never by URL', () => {
    const claim = attachmentClaim(UPLOAD, 'x'.repeat(200));
    assert.deepEqual(Object.keys(claim).sort(), ['bytes', 'id', 'mime', 'name']);
    assert.equal(claim.name.length, 80);
    assert.equal(attachmentClaim(UPLOAD, '').name, 'image');
});

/** An upload the test settles by hand. */
function manualUpload() {
    const calls = [];
    const upload = (file) => new Promise((resolve, reject) => { calls.push({ file, resolve, reject }); });
    return { calls, upload };
}

test('a picture uploads at once, waits as a chip, and goes with the next message', async () => {
    const { calls, upload } = manualUpload();
    const seen = [];
    const slot = createAttachmentSlot({ upload, onChange: (s) => seen.push(s.status) });

    slot.attach({ name: 'shot.png', type: 'image/png' });
    assert.equal(slot.state.status, 'uploading');
    assert.equal(slot.ready, false);
    assert.equal(slot.take(), null, 'nothing to hand over while it is still uploading');

    calls[0].resolve(UPLOAD);
    await Promise.resolve();
    assert.deepEqual(slot.state, { status: 'ready', name: 'shot.png', url: UPLOAD.url });
    assert.equal(slot.ready, true);

    assert.deepEqual(slot.take(), CLAIM);
    assert.equal(slot.state.status, 'empty', 'sending empties the chip');
    assert.equal(slot.take(), null, 'and the picture goes once');
    assert.deepEqual(seen, ['uploading', 'ready', 'empty']);
});

test('a failed upload says why, then clears itself', async () => {
    const { calls, upload } = manualUpload();
    const timers = [];
    const slot = createAttachmentSlot({ upload, schedule: (fn, ms) => timers.push({ fn, ms }) });

    slot.attach({ name: 'huge.jpg' });
    calls[0].reject(new Error('That file is too large.'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(slot.state, { status: 'error', name: 'huge.jpg', error: 'That file is too large.' });
    assert.equal(timers[0].ms, ATTACH_ERROR_MS);
    timers[0].fn();
    assert.equal(slot.state.status, 'empty');
});

test('a picture removed or replaced mid-upload never comes back', async () => {
    const { calls, upload } = manualUpload();
    const slot = createAttachmentSlot({ upload });

    slot.attach({ name: 'first.png' });
    slot.clear();
    calls[0].resolve(UPLOAD);
    await Promise.resolve();
    assert.equal(slot.state.status, 'empty', 'removed while uploading stays removed');

    slot.attach({ name: 'second.png' });
    slot.attach({ name: 'third.png' });
    calls[1].resolve({ ...UPLOAD, url: '/second' });
    await Promise.resolve();
    assert.equal(slot.state.name, 'third.png', 'the older upload finishing late does not win');
    calls[2].resolve({ ...UPLOAD, url: '/third' });
    await Promise.resolve();
    assert.deepEqual(slot.state, { status: 'ready', name: 'third.png', url: '/third' });
});

test('a paste is taken only when it is a picture', () => {
    const { calls, upload } = manualUpload();
    const slot = createAttachmentSlot({ upload });
    let prevented = 0;
    const event = (data) => ({ clipboardData: data, preventDefault: () => { prevented += 1; } });

    assert.equal(slot.paste(event(clipboard({ text: 'words' }))), false);
    assert.equal(prevented, 0, 'typing is left alone');
    assert.equal(slot.paste(event(clipboard({ files: [{ type: 'image/png', name: 'image.png' }] }))), true);
    assert.equal(prevented, 1);
    assert.equal(calls.length, 1, 'and it uploads');
});

test('the chip shows each state, escaped, and nothing when empty', () => {
    assert.equal(attachChipView({ status: 'empty' }), '');
    assert.equal(attachChipView(), '');
    assert.equal(attachChipView(null), '');
    assert.match(attachChipView({ status: 'uploading', name: 'a<b>.png' }), /Uploading a&lt;b&gt;\.png…/);
    assert.match(attachChipView({ status: 'error', error: 'Nope' }), /attach-chip error[^>]*role="alert"[^>]*>Nope/);
    const ready = attachChipView({ status: 'ready', name: 'shot.png', url: '/api/uploads/x' });
    assert.match(ready, /data-auth-src="\/api\/uploads\/x"/, 'fetched with the session, like every picture');
    assert.match(ready, /data-attach-clear/);
});

test('a bubble\'s card carries the same chip as the channel composer', () => {
    const waiting = bubblePopupView({ bubble: { id: 'b', name: 'Dogs' }, attachment: { status: 'ready', name: 'pup.jpg', url: '/u/1' } });
    assert.ok(waiting.includes(attachChipView({ status: 'ready', name: 'pup.jpg', url: '/u/1' })));
    assert.match(bubblePopupView({ bubble: { id: 'b' } }), /<div class="bubble-popup-attach"><\/div>/,
        'empty, so the space folds away');
    assert.match(waiting, /data-bubble-attach/, 'and its own picture button');
});

test('every message frame is built by compose.js, so no composer can drift from the others', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
    const offenders = walk(src)
        .filter((f) => f.endsWith('.js') && !f.endsWith(join('room', 'compose.js')))
        .filter((f) => /['"](text-chat|dm|bubbles):send['"]/.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(src.length + 1).replaceAll('\\', '/'));
    assert.deepEqual(offenders, []);
});
