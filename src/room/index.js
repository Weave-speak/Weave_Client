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
import { messageList, typingLine, voiceNoticeMarkup } from './views/timeline.js';
import { createRoomState } from './state.js';
import { WeaveBackground } from '../ui/weave-background.js';
import { createVoice } from '../media/voice.js';
import { createSettings, readPrefs } from '../settings/index.js';
import { createRoomBrowser } from '../rooms/browser.js';
import { createModal } from '../ui/modal.js';
import { platform } from '../platform/index.js';
import { userHue } from '../ui/hue.js';
import { $, $$, html } from '../ui/dom.js';

/** Close enough to the bottom that the reader is following along. */
const STICK_PX = 80;

/**
 * Loud enough to count as talking.
 *
 * Above room tone and breathing, below a quiet voice. Too low and everyone glows
 * permanently, which is the same as nobody glowing.
 */
const SPEAKING_AT = 0.055;

/**
 * How long the ring stays after someone stops.
 *
 * Speech is full of gaps — every consonant is a moment of near-silence — so a ring driven
 * straight off the level strobes on every syllable. Holding it briefly turns a flicker into
 * a signal.
 */
const SPEAKING_HOLD_MS = 450;

/** How long to wait for an animation frame before painting anyway. */
const PAINT_FLOOR_MS = 100;

export function createRoom({ mount, api, link, user, server, features = [], onSignedOut }) {
    const state = createRoomState({
        me: user,
        server: { name: server?.lastSeen?.name ?? server?.label ?? 'Weave' },
    });

    let background = null;
    let painting = false;
    let voiceLevels = new Map();
    const speakingUntil = new Map();   // username -> when the ring may fade

    let prefs = readPrefs(server.id);
    let pttHeld = false;

    const voice = createVoice({
        link,
        getAudioConstraints: () => ({
            echoCancellation: prefs.echoCancellation !== false,
            noiseSuppression: prefs.noiseSuppression !== false,
            autoGainControl: prefs.autoGainControl !== false,
            ...(prefs.micDevice ? { deviceId: { exact: prefs.micDevice } } : {}),
        }),
        onChange: (status) => {
            voiceState = status;
            paint();
        },
        onLevels: (levels) => {
            voiceLevels = levels;
            paintSpeaking();
        },
    });
    let voiceState = { state: 'idle' };

    const browser = createRoomBrowser({
        state,
        canCreate: Boolean(user?.isAdmin),
        createModal,
        dom: { $, $$ },
        onEnter(channelId) {
            if (channelId === state.raw.currentChannelId) return;
            link.noteChannel(channelId);
            link.send('move', { channelId });
        },
    });

    const settings = createSettings({
        api,
        server,
        me: user,
        features,
        onPrefsChange: applyPrefs,
        onSignOut: signOut,
    });

    /**
     * Make a changed preference take effect now, rather than on the next launch.
     *
     * A settings screen whose switches only apply after a restart teaches people that the
     * switches do not work.
     */
    function applyPrefs(next) {
        const wasPushToTalk = prefs.pushToTalk;
        prefs = next;
        voice.applyAudioConstraints().catch(() => {});

        // Switching push-to-talk ON must mute immediately. Leaving the microphone open
        // until the first press means the setting appears to do nothing, and everything
        // said in between is broadcast by someone who believes it is not.
        if (prefs.pushToTalk && !wasPushToTalk) {
            pttHeld = false;
            voice.setMuted(true);
            link.send('setMute', { muted: true, deafened: Boolean(state.toShell().me.deafened) });
        }
        if (background) {
            background.reduceMotion = Boolean(prefs.staticBackground);
            if (prefs.staticBackground) background.stop(); else background.start();
        }
    }

    /**
     * Sign out properly.
     *
     * The order matters and every step earns its place. The server is told first so the
     * session is revoked rather than left live for the rest of its twelve hours — the app
     * previously never called logout at all, so quitting left a usable session behind. The
     * local token goes next, then the socket and the microphone, so the room sees a clean
     * departure rather than a timeout.
     *
     * Saved sign-in details are deliberately NOT cleared: "sign out" and "forget me" are
     * different requests, and someone signing out on a shared machine unticks Remember me
     * to be forgotten. Servers and per-server preferences stay too.
     */
    async function signOut() {
        await api.logout().catch(() => {
            // A network failure must not trap somebody in a signed-in interface. The
            // session lapses on its own; the important part is that this client forgets it.
        });
        api.setToken(null);
        await platform.tokens.clear(server.id).catch(() => {});
        voice.stop();
        link.close();
        onSignedOut?.();
    }

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
        setHtml('#voiceNotice', voiceNoticeMarkup(voiceState));
        paintConnection(view.connection);
        paintRoomHead(view.room);
        paintMessages(view.items);

        // A repaint replaced those rows, so anything currently talking needs its ring back
        // immediately rather than at the next level sample.
        paintSpeaking();
    }

    /**
     * Show who is talking.
     *
     * Deliberately NOT part of paint(). Levels arrive ten times a second, and re-rendering
     * the sidebar and member list at that rate to add one class would be both wasteful and
     * visibly janky — it would also destroy any hover or focus in those lists on every
     * frame. This toggles a class on elements that already exist and touches nothing else.
     */
    function paintSpeaking() {
        const view = state.toShell();
        const now = Date.now();

        for (const person of view.people) {
            // The loudest of ALL their connections. Levels are per peer, and somebody
            // signed in twice would otherwise be silent on screen while audibly talking.
            let level = person.id === view.me.id ? (voiceLevels.get('self') ?? 0) : 0;
            for (const cid of person.cids ?? []) {
                level = Math.max(level, voiceLevels.get(cid) ?? 0);
            }
            if (level >= SPEAKING_AT) speakingUntil.set(person.username, now + SPEAKING_HOLD_MS);
        }

        for (const el of mount.querySelectorAll('[data-person]')) {
            const until = speakingUntil.get(el.dataset.person) ?? 0;
            el.classList.toggle('speaking', until > now);
        }
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
            reduceMotion: prefs.staticBackground || undefined,
            getState: () => {
                const view = state.toShell();
                const here = view.rooms.find((r) => r.current)?.occupants ?? [];

                // The room's pace is how loud it actually is. Favours the loudest speaker
                // blended with the average, so one person talking quietly in a room of
                // eight still registers rather than being averaged into silence.
                const values = here.map((p) => {
                    let level = p.id === view.me.id ? (voiceLevels.get('self') ?? 0) : 0;
                    for (const cid of p.cids ?? []) level = Math.max(level, voiceLevels.get(cid) ?? 0);
                    return level;
                });
                const loudest = values.length ? Math.max(...values) : 0;
                const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

                return {
                    participants: here.map((p) => ({ id: p.username, hue: userHue(p.username) })),
                    noise: Math.min(1, Math.max(loudest, average * 1.4)),
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
            startVoice(msg).catch((err) => {
                voiceState = { state: 'failed', message: err.message };
                paint();
            });
            return;
        }

        // Media frames first: the voice layer is waiting on specific replies, and a frame it
        // has claimed is not something the roster needs to see.
        if (voice.handle(msg)) {
            state.apply(msg);
            return;
        }

        state.apply(msg);
    }

    /**
     * Bring voice up for the room we have just entered.
     *
     * A move puts us on a different router, so every consumer from the old room is dead and
     * the whole set has to be rebuilt against whoever is here now.
     */
    async function startVoice(frame) {
        const channel = frame.channel;
        if (frame.type === 'moved') {
            await voice.onMoved({
                rtpCapabilities: frame.rtpCapabilities,
                mediaReset: frame.mediaReset === true,
            });
        }
        if (!frame.rtpCapabilities) return;

        await voice.start(frame.rtpCapabilities);

        // Consume everyone already talking before opening our own microphone, so the room
        // is audible immediately rather than after a permission prompt is answered.
        for (const peer of frame.peers ?? []) await voice.consumePeer(peer);

        if (channel?.allowVoice === false) {
            voiceState = { state: 'unavailable', message: `Voice is off in ${channel.name}.` };
            paint();
            return;
        }

        try {
            await voice.enableMic();
            voice.setMuted(state.toShell().me.muted);
        } catch (err) {
            // A refused microphone is a completely normal thing for someone to do, and the
            // room still works without one — you can read, type and listen.
            voiceState = {
                state: 'no-mic',
                message: err?.name === 'NotAllowedError'
                    ? 'Microphone blocked. You can still hear everyone.'
                    : `Microphone unavailable: ${err.message}`,
            };
            paint();
        }
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
                const next = !me.muted;
                // Locally first so the button responds immediately, then tell the room. The
                // server's broadcast is what everyone else sees; this is what we hear.
                voice.setMuted(next);
                link.send('setMute', { muted: next, deafened: Boolean(me.deafened) });
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
                signOut();
                return;
            }

            if (event.target.closest('[data-browse-rooms]') || event.target.closest('[data-new-room]')) {
                browser.open(event.target.closest('button'));
                return;
            }

            if (event.target.closest('[data-open-settings]')) {
                settings.open(event.target.closest('[data-open-settings]'));
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

        wirePushToTalk();

        // Grow with the text, up to a point, so a long message is visible while it is typed.
        input?.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
        });
    }

    /**
     * Push to talk.
     *
     * Bound on the window with capture, so it works wherever focus happens to be — except
     * while typing, because a push-to-talk key bound to Space would otherwise make the
     * composer unusable. That exception is the whole reason this is not three lines.
     *
     * `event.code` is the physical key, so a bind survives a keyboard-layout change.
     * `event.repeat` is ignored: holding a key fires keydown continuously, and sending an
     * unmute frame per repeat would hammer the server for the entire time somebody speaks.
     */
    function wirePushToTalk() {
        const typing = (target) => target instanceof HTMLElement
            && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

        const setTalking = (talking) => {
            if (!prefs.pushToTalk || pttHeld === talking) return;
            pttHeld = talking;
            voice.setMuted(!talking);
            link.send('setMute', { muted: !talking, deafened: Boolean(state.toShell().me.deafened) });
        };

        window.addEventListener('keydown', (event) => {
            if (!prefs.pushToTalk || event.repeat) return;
            if (event.code !== prefs.pushToTalkKey || typing(event.target)) return;
            event.preventDefault();
            setTalking(true);
        }, true);

        window.addEventListener('keyup', (event) => {
            if (!prefs.pushToTalk || event.code !== prefs.pushToTalkKey) return;
            setTalking(false);
        }, true);

        // Releasing the key while the window is not focused never reaches us, so a peer
        // would be left permanently unmuted after alt-tabbing mid-sentence.
        window.addEventListener('blur', () => setTalking(false));
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
        mount.append(html(shell({ ...state.toShell(), voice: voiceState })));
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
            voice.stop();
            background?.destroy();
            link.onEvent = () => {};
            link.onState = () => {};
        },
    };
}
