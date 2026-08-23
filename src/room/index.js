// The room.
//
// Mounts the shell, keeps it in step with the server, and turns clicks into messages on the
// wire. This is the only file here that touches the DOM or the network; the views are pure
// and the state store is synchronous, which is what keeps this one small enough to follow.
//
// Rendering is by REGION, not wholesale. Replacing the whole shell on every event would be
// simpler to write and awful to use: it would blow away half-typed messages, drop focus
// mid-keystroke, and reset the scroll position every time somebody said something. So each
// region has its own container and its own update, and the composer is never re-rendered at
// all.

import { shell, connection as connectionPill } from './shell.js';
import { roomGroups, selfBar } from './views/sidebar.js';
import { memberGroups } from './views/members.js';
import { messageList, typingLine } from './views/timeline.js';
import { createRoomState } from './state.js';
import { WeaveBackground } from '../ui/weave-background.js';
import { userHue } from '../ui/hue.js';
import { $, html } from '../ui/dom.js';

/** Close enough to the bottom that the reader is following along. */
const STICK_PX = 80;

/** How long to wait for an animation frame before painting anyway. */
const PAINT_FLOOR_MS = 100;

export function createRoom({ mount, api, link, user, server, onSignedOut }) {
    const state = createRoomState({
        me: user,
        server: { name: server?.lastSeen?.name ?? server?.label ?? 'Weave' },
    });

    let background = null;
    let painting = false;

    /* ── painting ────────────────────────────────────────────────────────── */

    /**
     * Repaint the regions that data changes.
     *
     * Coalesced, because a roster snapshot arrives as one message but a burst of joins
     * arrives as several, and painting per event would lay out the same list five times.
     *
     * An animation frame is the right moment to paint — but it is not a promise. A window
     * that is minimised, occluded, or otherwise not compositing does not run rAF at all, and
     * a callback that never fires would leave `painting` stuck true, so nothing would ever
     * schedule again and the UI would stay frozen even after the window came back. The
     * timeout is the floor: whichever arrives first wins, and the other is cancelled.
     */
    function paint() {
        if (painting) return;
        painting = true;

        let frame = 0;
        let timer = 0;
        const run = () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            painting = false;
            repaint();
        };
        frame = requestAnimationFrame(run);
        timer = setTimeout(run, PAINT_FLOOR_MS);
    }

    function repaint() {
        const view = state.toShell();

        setHtml('#roomScroll', roomGroups(view.rooms, view.me));
        setHtml('#selfBarSlot', selfBar(view.me));
        setHtml('#membersScroll', memberGroups(view.people, view.room.id));
        setText('#membersCount', `Members — ${view.people.length}`);
        setHtml('.typing', typingLine(view.typing));
        paintConnection(view.connection);
        paintRoomHead(view.room);
        paintMessages(view.items);
    }

    const setHtml = (selector, markup) => {
        const el = $(selector, mount);
        if (el) el.innerHTML = markup;
    };
    const setText = (selector, text) => {
        const el = $(selector, mount);
        if (el) el.textContent = text;
    };

    function paintConnection(conn) {
        const pill = $('.conn-pill', mount);
        if (pill) pill.outerHTML = connectionPill(conn);
    }

    function paintRoomHead(room) {
        const title = $('#roomHead h1', mount);
        if (title) title.textContent = room.name ?? 'Room';
        const composer = $('#composerInput', mount);
        if (composer) composer.placeholder = `Message ${room.name ?? 'the room'}…`;
    }

    /**
     * Repaint the messages, keeping the reader where they were.
     *
     * Sticking to the bottom only when they were ALREADY at the bottom. Scrolling someone
     * down because a new message arrived, while they are reading something further up, is
     * the single most irritating thing a chat client can do.
     */
    function paintMessages(items) {
        const scroller = $('#timeline', mount);
        const list = $('#msgList', mount);
        if (!list || !scroller) return;

        const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
        list.innerHTML = messageList(items);
        if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
    }

    /* ── the living background ───────────────────────────────────────────── */

    function startBackground() {
        const canvas = $('#roomBg', mount);
        if (!canvas) return;
        background = new WeaveBackground(canvas, {
            getState: () => {
                const here = state.toShell().rooms.find((r) => r.current)?.occupants ?? [];
                return {
                    participants: here.map((p) => ({ id: p.username, hue: userHue(p.username) })),
                    // Voice levels arrive with the media layer. Until then the room's pace
                    // comes from how much is being said in text, which is a real signal.
                    noise: 0,
                };
            },
        });
        background.start();
    }

    /* ── talking to the server ───────────────────────────────────────────── */

    function applyFrame(msg) {
        // Module messages arrive namespaced, so a module can never shadow a core type.
        if (msg.type === 'text-chat:message' && msg.message) {
            const record = msg.message;
            state.addMessage(record.channelId, record);
            return;
        }

        if (msg.type === 'moved' || msg.type === 'joined') {
            state.apply(msg);
            loadHistory(msg.channel?.id).catch(() => {});
            return;
        }

        state.apply(msg);
    }

    async function loadHistory(channelId) {
        if (!channelId) return;
        try {
            const { messages = [] } = await api.request('GET', `/api/chat/${encodeURIComponent(channelId)}/messages`);
            // The endpoint returns newest-first; the timeline reads oldest-first.
            state.setMessages(channelId, [...messages].reverse());
        } catch {
            // A server with the chat module disabled answers 404, and that is a legitimate
            // configuration rather than an error. The room still works; it just has no text.
            state.setMessages(channelId, []);
        }
    }

    /* ── what the user does ──────────────────────────────────────────────── */

    function wire() {
        mount.addEventListener('click', (event) => {
            const room = event.target.closest('[data-open]');
            if (room) {
                const id = room.dataset.open;
                if (id !== state.raw.currentChannelId) {
                    link.noteChannel(id);
                    link.send('move', { channelId: id });
                }
                return;
            }

            if (event.target.closest('[data-toggle-mic]')) {
                const me = state.toShell().me;
                link.send('setMute', { muted: !me.muted, deafened: Boolean(me.deafened) });
                return;
            }

            if (event.target.closest('[data-toggle-audio]')) {
                const me = state.toShell().me;
                // Deafening implies muting: it is not honest to keep sending audio to a room
                // you have stopped listening to.
                const deafened = !me.deafened;
                link.send('setMute', { muted: deafened || me.muted, deafened });
                return;
            }

            if (event.target.closest('[data-leave]')) {
                link.close();
                onSignedOut?.();
                return;
            }

            if (event.target.closest('[data-toggle-members]')) {
                $('.members', mount)?.classList.toggle('hidden');
            }
        });

        const composer = $('#composer', mount);
        const input = $('#composerInput', mount);

        composer?.addEventListener('submit', (event) => {
            event.preventDefault();
            sendMessage();
        });

        input?.addEventListener('keydown', (event) => {
            // Enter sends, Shift+Enter starts a new line. The other way round is a choice
            // some apps make and everyone else finds baffling.
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        // Grow with the text, up to a point, so a long message is visible while it is typed.
        input?.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
        });
    }

    function sendMessage() {
        const input = $('#composerInput', mount);
        const body = input?.value.trim();
        if (!body) return;

        // Cleared immediately. Waiting for the server to acknowledge before clearing means
        // that on a slow link people retype, or send twice.
        input.value = '';
        input.style.height = 'auto';
        link.send('text-chat:send', { body });
    }

    /* ── lifecycle ───────────────────────────────────────────────────────── */

    async function start() {
        mount.innerHTML = '';
        mount.append(html(shell(state.toShell())));
        wire();
        startBackground();

        state.subscribe(paint);

        link.onEvent = applyFrame;
        link.onState = (conn) => state.setConnection(conn);
        state.setConnection({ state: link.state, rttMs: link.rttMs, cid: link.cid });

        // The roster and the room list come over HTTP; who is in them comes over the socket.
        const [channels, users] = await Promise.all([
            api.channels().catch(() => ({ channels: [] })),
            api.request('GET', '/api/users').catch(() => ({ users: [] })),
        ]);
        state.setChannels(channels.channels ?? []);
        state.setUsers(users.users ?? []);

        if (state.raw.currentChannelId) await loadHistory(state.raw.currentChannelId);
        paint();
    }

    return {
        start,
        get state() { return state; },
        destroy() {
            background?.destroy();
            link.onEvent = () => {};
            link.onState = () => {};
        },
    };
}
