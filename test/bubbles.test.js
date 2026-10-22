// Bubbles: how they move, what the client believes about them, and how they are drawn.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stepBubbles, clampBubble, randomVelocity, BUBBLE_RADIUS } from '../src/ui/bubbles.js';
import {
    emptyBubbles, loadBubbles, applyBubbleFrame, setBubbleMessages, markBubbleRead, anyUnread,
} from '../src/room/bubble-store.js';
import { bubblePopupView, allBubblesView } from '../src/room/views/bubbles.js';
import { adminBubblesPanel } from '../src/settings/admin.js';
import { timeline } from '../src/room/views/timeline.js';

const ball = (x, y, vx = 0, vy = 0, extra = {}) => ({ x, y, vx, vy, r: BUBBLE_RADIUS, ...extra });

/* ── motion ───────────────────────────────────────────────────────────────── */

test('a bubble drifts, and turns back at an edge rather than leaving', () => {
    const b = ball(100, 100, 10, 0);
    stepBubbles([b], 400, 300, 1);
    assert.equal(b.x, 110);

    const edge = ball(390, 100, 20, 0);
    stepBubbles([edge], 400, 300, 1);
    assert.equal(edge.x, 400 - BUBBLE_RADIUS, 'held inside the field');
    assert.ok(edge.vx < 0, 'and heading back in');
});

test('two bubbles that meet push apart and trade the speed between them', () => {
    const a = ball(100, 100, 10, 0);
    const b = ball(130, 100, -10, 0);   // overlapping: 30 apart, 48 needed
    stepBubbles([a, b], 400, 300, 0.001);
    assert.ok(b.x - a.x >= BUBBLE_RADIUS * 2 - 0.001, 'no longer overlapping');
    assert.ok(a.vx < 0 && b.vx > 0, 'head-on, they bounce back the way they came');
});

test('a bubble being held neither drifts nor gets pushed', () => {
    const held = ball(100, 100, 50, 50, { dragging: true });
    const other = ball(110, 100, 0, 0);
    stepBubbles([held, other], 400, 300, 1);
    assert.equal(held.x, 100);
    assert.equal(held.y, 100);
});

test('a field with no size yet moves nothing', () => {
    const b = ball(10, 10, 5, 5);
    stepBubbles([b], 0, 0, 1);
    assert.equal(b.x, 10);
});

test('drift is unhurried, and a resize pulls a bubble back into view', () => {
    for (let i = 0; i < 50; i += 1) {
        const { vx, vy } = randomVelocity();
        const speed = Math.hypot(vx, vy);
        assert.ok(speed >= 8 && speed <= 18, `speed ${speed}`);
    }
    const b = clampBubble(ball(900, -40), 400, 300);
    assert.equal(b.x, 400 - BUBBLE_RADIUS);
    assert.equal(b.y, BUBBLE_RADIUS);
});

/* ── what the client knows ────────────────────────────────────────────────── */

const LIST = {
    bubbles: [
        { id: 'b1', name: 'Cats', photo: '/api/bubbles/b1/photo', unread: true },
        { id: 'b2', name: 'Holiday', photo: '/api/bubbles/b2/photo', unread: false },
    ],
    active: ['b2', 'gone'],
};
const loaded = () => loadBubbles(emptyBubbles(), LIST);

test('the list replaces what was known, floating only bubbles that exist', () => {
    const s = loaded();
    assert.equal(s.bubbles.size, 2);
    assert.deepEqual(s.active, ['b2'], 'an id the list does not have cannot float');
    assert.equal(anyUnread(s), true);
});

test('somebody else talking in a bubble you are not looking at is news; your own words are not', () => {
    let s = loaded();
    s = markBubbleRead(s, 'b1');
    s = applyBubbleFrame(s, { type: 'bubbles:message', message: { id: 'm1', bubbleId: 'b2', userId: 'me', body: 'hi', createdAt: 1 } }, { meId: 'me' });
    assert.equal(s.bubbles.get('b2').unread, false, 'your own message');
    s = applyBubbleFrame(s, { type: 'bubbles:message', message: { id: 'm2', bubbleId: 'b2', userId: 'kes', body: 'hi', createdAt: 2 } }, { meId: 'me', openId: 'b2' });
    assert.equal(s.bubbles.get('b2').unread, false, 'arriving in the open conversation is read as it lands');
    s = applyBubbleFrame(s, { type: 'bubbles:message', message: { id: 'm3', bubbleId: 'b2', userId: 'kes', body: 'hi', createdAt: 3 } }, { meId: 'me' });
    assert.equal(s.bubbles.get('b2').unread, true);
    assert.equal(s.bubbles.get('b2').lastMessageAt, 3);
});

test('a message extends a conversation already fetched, and only that', () => {
    let s = loaded();
    const frame = { type: 'bubbles:message', message: { id: 'm1', bubbleId: 'b1', userId: 'kes', body: 'x', createdAt: 1 } };
    s = applyBubbleFrame(s, frame, {});
    assert.equal(s.messages.has('b1'), false, 'one message is not a history; it is fetched whole when opened');
    s = setBubbleMessages(s, 'b1', [{ id: 'm0', bubbleId: 'b1', body: 'older', createdAt: 0 }]);
    s = applyBubbleFrame(s, frame, {});
    s = applyBubbleFrame(s, frame, {});
    assert.deepEqual(s.messages.get('b1').map((m) => m.id), ['m0', 'm1'], 'once, however often it is announced');
});

test('made, rotated, cleared and deleted, as the server says', () => {
    let s = loaded();
    s = applyBubbleFrame(s, { type: 'bubbles:created', bubble: { id: 'b3', name: 'New' } });
    assert.equal(s.bubbles.get('b3').unread, false);
    s = applyBubbleFrame(s, { type: 'bubbles:active', ids: ['b3', 'b1', 'nope'] });
    assert.deepEqual(s.active, ['b3', 'b1']);
    s = setBubbleMessages(s, 'b1', [{ id: 'm', bubbleId: 'b1' }]);
    s = applyBubbleFrame(s, { type: 'bubbles:cleared', id: 'b1' });
    assert.deepEqual(s.messages.get('b1'), []);
    assert.equal(s.bubbles.get('b1').unread, false);
    s = applyBubbleFrame(s, { type: 'bubbles:deleted', id: 'b1' });
    assert.equal(s.bubbles.has('b1'), false);
    assert.deepEqual(s.active, ['b3'], 'a deleted bubble stops floating at once');
});

/* ── drawing ──────────────────────────────────────────────────────────────── */

test('the conversation reads like a channel, and is escaped like one', () => {
    const markup = bubblePopupView({
        bubble: { id: 'b1', name: '<b>Cats</b>' },
        items: [{ kind: 'message', id: 'm1', at: '10:00', author: { username: 'kes', displayName: 'Kestrel' }, text: '<img src=x>', mentions: [] }],
    });
    assert.ok(!markup.includes('<b>Cats</b>'));
    assert.ok(!markup.includes('<img src=x>'));
    assert.match(markup, /class="msg"/, 'the timeline row itself');
    assert.match(markup, /data-bubble-composer/);
    assert.match(bubblePopupView({ bubble: { id: 'b' }, loading: true }), /Loading/);
    assert.match(bubblePopupView({ bubble: { id: 'b' } }), /Nothing said here yet/);
});

test('the list shows every bubble, which are floating, and which have news', () => {
    const markup = allBubblesView({
        bubbles: [
            { id: 'b1', name: 'Cats', unread: true, floating: false, photoUrl: 'blob:x' },
            { id: 'b2', name: 'Holiday', unread: false, floating: true },
        ],
    });
    assert.match(markup, /data-open-bubble="b1"[\s\S]*Cats[\s\S]*all-bubbles-unread/);
    assert.match(markup, /Holiday[\s\S]*floating/);
    assert.match(allBubblesView({ bubbles: [] }), /Settings → Admin → Bubbles/, 'an empty list says where they come from');
});

test('the room has a place for bubbles to drift, over the timeline and outside it', () => {
    const markup = timeline({ room: { id: 'r', name: 'General' } });
    assert.match(markup, /id="bubblesLayer"/);
    assert.ok(markup.indexOf('id="bubblesLayer"') > markup.indexOf('id="timeline"'), 'after it, so it is drawn over it');
    assert.match(markup, /id="allBubblesBtn"[^>]*hidden/, 'the way in is hidden until there are any');
});

/* ── the admin screen ─────────────────────────────────────────────────────── */

test('an administrator can make, clear and delete bubbles, the last two armed first', () => {
    const markup = adminBubblesPanel({
        bubbles: [{ id: 'b1', name: 'Cats', lastMessageAt: null, photoUrl: null }],
        armedKey: 'bubble-delete:b1',
    });
    assert.match(markup, /data-bubble-create/);
    assert.match(markup, /type="file" name="photo"/);
    assert.match(markup, /data-bubble-clear="b1"/);
    assert.match(markup, /Delete bubble\?/, 'the delete is armed');
    assert.match(markup, /nothing said yet/);
});

test('a server without bubbles says why instead of offering a form that fails', () => {
    const markup = adminBubblesPanel({ bubbles: false, unavailable: 'Switch the Bubbles module on.' });
    assert.match(markup, /Switch the Bubbles module on/);
    assert.ok(!markup.includes('data-bubble-create'));
});
