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
import { messageList, typingLine, voiceNoticeMarkup, emptyState, roomGlyph } from './views/timeline.js';
import { createRoomState } from './state.js';
import { WeaveBackground, createMessageNoise } from '../ui/weave-background.js';
import { createVoice } from '../media/voice.js';
import { effectiveMute, onPushToTalkChange } from '../media/mute-policy.js';
import { createSettings, readPrefs } from '../settings/index.js';
import { createRoomBrowser } from '../rooms/browser.js';
import { createModal } from '../ui/modal.js';
import { platform } from '../platform/index.js';
import { userHue } from '../ui/hue.js';
import { mentionQuery, matchMentions, insertMention } from './mentions.js';
import { freshHistory, advanceHistory, nextPageQuery, shouldLoadOlder } from './history.js';
import { avatar } from './views/parts.js';
import { esc } from '../ui/dom.js';
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
    // Text rooms breathe too: the strands pulse with message rate, exactly as the previous
    // client did. Without this a text channel is a room full of people and a dead canvas.
    const msgNoise = createMessageNoise();
    const history = new Map();   // channelId -> paging bookkeeping (see history.js)

    let prefs = readPrefs(server.id);
    let pttHeld = false;
    // Text channels are openable-from-anywhere only when the server broadcasts chat
    // that way; against an older server every click is still a move.
    const canBrowse = features.includes('chat.browse');

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

        // Flipping push-to-talk changes who owns the microphone, in both directions.
        // ON closes the gate immediately — leaving the mic open until the first press
        // means the setting appears to do nothing, and everything said in between is
        // broadcast by someone who believes it is not. OFF returns to an OPEN mic:
        // the person just asked for an open microphone, so making them hunt for the
        // unmute button after every settings visit would teach them the setting is broken.
        if (prefs.pushToTalk !== wasPushToTalk) {
            const deafened = Boolean(state.toShell().me.deafened);
            const next = onPushToTalkChange({ turnedOn: prefs.pushToTalk, deafened });
            pttHeld = next.held;
            voice.setMuted(next.muted);
            link.send('setMute', { muted: next.muted, deafened });
            paint();   // the mute button greys out (or comes back) right now
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
        setHtml('#selfBarSlot', selfBar({ ...view.me, pttOn: Boolean(prefs.pushToTalk) }));
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
        const icon = $('#roomIcon', mount);
        if (icon) icon.innerHTML = roomGlyph(room);
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
        // Distance from the BOTTOM is the reader's true position: when an older page lands
        // on top, restoring this distance keeps the same message under the cursor instead
        // of teleporting the view to wherever the old scrollTop now points.
        const fromBottom = scroller.scrollHeight - scroller.scrollTop;

        list.innerHTML = messageList(items);

        // The "this is the start" note lives outside the list. Rebuilt every paint rather
        // than cached, so it always names the CURRENT room — it once said "the room"
        // forever because it rendered before the roster arrived.
        $('.timeline-empty', mount)?.remove();
        if (!items.length) list.insertAdjacentHTML('afterend', emptyState(state.toShell().room));
        paintHistoryNote(state.raw.currentChannelId);

        if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
        else scroller.scrollTop = scroller.scrollHeight - fromBottom;
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
                    noise: Math.min(1, Math.max(loudest, average * 1.4, msgNoise.value(Date.now()))),
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
            const viewId = state.raw.viewChannelId ?? state.raw.currentChannelId;
            state.addMessage(record.channelId, record);
            if (record.channelId === viewId) msgNoise.record(Date.now());

            // Seen or owed: a message in front of a reader at the bottom of the timeline
            // is acked; anything else becomes the badge on that channel's row.
            if (record.userId !== state.raw.me?.id) {
                if (readingNow(record.channelId)) {
                    ackRead(record.channelId);
                } else if (record.channelId !== state.raw.currentChannelId || canBrowse) {
                    state.bumpUnread(record.channelId, {
                        mention: (record.mentions ?? []).includes(state.raw.me?.username),
                    });
                }
            }
            return;
        }

        if (msg.type === 'moved' || msg.type === 'joined') {
            msgNoise.reset();
            state.apply(msg);
            if (msg.type === 'joined' && canBrowse) {
                api.request('GET', '/api/chat/reads')
                    .then(({ channels = [] }) => state.setReads(channels))
                    .catch(() => { /* badges start at zero; the frames keep them honest */ });
            }
            // Entering a room is seeing its latest page, so the backlog is acked too —
            // without this, days of history in your home room stay "unread" for ever.
            loadHistory(msg.channel?.id)
                .then(() => { if (canBrowse && msg.channel?.id) ackRead(msg.channel.id); })
                .catch(() => {});
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
            voice.setMuted(effectiveMute({
                pushToTalk: Boolean(prefs.pushToTalk),
                held: pttHeld,
                muted: state.toShell().me.muted,
                deafened: Boolean(state.toShell().me.deafened),
            }));
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
        const entry = freshHistory();
        history.set(channelId, entry);
        try {
            const reply = await api.request('GET',
                `/api/chat/${encodeURIComponent(channelId)}/messages?${nextPageQuery(entry)}`);
            history.set(channelId, advanceHistory(entry, reply));
            // The page arrives oldest-first already; it IS the timeline.
            state.setMessages(channelId, reply.messages ?? []);
        } catch {
            // A server with the chat module disabled answers 404, and that is a legitimate
            // configuration rather than an error. The room still works; it just has no text.
            history.set(channelId, { ...entry, done: true });
            state.setMessages(channelId, []);
        }
    }

    /**
     * The page before the oldest one held, fetched as the reader nears the top.
     *
     * One request at a time, and never again once the server reports the beginning —
     * shouldLoadOlder() is the whole policy, tested on its own.
     */
    async function loadOlder(channelId) {
        const entry = history.get(channelId);
        if (!entry || entry.busy) return;
        history.set(channelId, { ...entry, busy: true });
        paintHistoryNote(channelId);
        try {
            const reply = await api.request('GET',
                `/api/chat/${encodeURIComponent(channelId)}/messages?${nextPageQuery(entry)}`);
            history.set(channelId, advanceHistory(entry, reply));
            if (!state.prependMessages(channelId, reply.messages ?? [])) paint();
        } catch {
            // A failed page is retried by the next scroll; the timeline already held is
            // untouched. busy is released either way.
            history.set(channelId, { ...entry, busy: false });
            paint();
        }
    }

    /** The one line above the oldest message: fetching, or the start of the room. */
    function paintHistoryNote(channelId) {
        const list = $('#msgList', mount);
        if (!list) return;
        $('.history-note', mount)?.remove();
        const entry = history.get(channelId);
        if (!entry) return;
        if (entry.busy) {
            list.insertAdjacentHTML('beforebegin',
                '<div class="history-note">Fetching earlier messages…</div>');
        } else if (entry.done && (state.raw.currentChannelId === channelId)
            && (state.raw.messages.get(channelId)?.length ?? 0) > 0) {
            list.insertAdjacentHTML('beforebegin',
                '<div class="history-note cap">Where it all began.</div>');
        }
    }

    /* ── what the user does ──────────────────────────────────────────────── */

    function wire() {
        mount.addEventListener('click', (event) => {
            const room = event.target.closest('[data-open]');
            if (room) {
                const id = room.dataset.open;
                const target = state.raw.channels.find((c) => c.id === id);
                if (canBrowse && target?.kind === 'text') {
                    // A text channel is opened, not entered: voice stays wherever the
                    // reader is standing.
                    openTextChannel(id);
                } else if (id !== state.raw.currentChannelId) {
                    link.noteChannel(id);
                    link.send('move', { channelId: id });
                }
                setDrawer(false);   // picking a room is why the drawer was opened
                return;
            }

            if (event.target.closest('[data-open-drawer]')) {
                setDrawer(!$('.app-shell', mount)?.classList.contains('drawer-open'));
                return;
            }
            if (event.target.closest('[data-drawer-scrim]')) {
                setDrawer(false);
                return;
            }

            if (event.target.closest('[data-toggle-mic]')) {
                // Under push-to-talk the key owns the stream; the button is disabled in the
                // markup, and this guard is the same rule for anything synthesising clicks.
                if (prefs.pushToTalk) return;
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
                // One button, two situations. Wide: the list is there, hide it. Narrow:
                // the layout dropped it, summon it as an overlay.
                const shellEl = $('.app-shell', mount);
                if (window.matchMedia('(max-width: 1180px)').matches) {
                    shellEl?.classList.toggle('members-open');
                } else {
                    shellEl?.classList.toggle('members-hidden');
                }
            }
        });

        const composer = $('#composer', mount);
        const input = $('#composerInput', mount);

        composer?.addEventListener('submit', (event) => {
            event.preventDefault();
            sendMessage();
        });

        input?.addEventListener('keydown', (event) => {
            // While the mention popover is open it owns the navigation keys — Enter picks
            // a person rather than sending half a name to the room.
            if (mention?.items.length) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    mention.index = (mention.index + delta + mention.items.length) % mention.items.length;
                    paintMentionPop();
                    return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    pickMention(mention.items[mention.index].username);
                    return;
                }
                if (event.key === 'Escape') {
                    mention = null;
                    paintMentionPop();
                    return;
                }
            }

            // Enter sends, Shift+Enter starts a new line. The other way round is a choice
            // some apps make and everyone else finds baffling.
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') setDrawer(false);
        });

        // Nearing the top of the timeline asks for the page before it. The policy —
        // once at a time, never past the beginning — lives in history.js.
        $('#timeline', mount)?.addEventListener('scroll', (event) => {
            const channelId = state.raw.currentChannelId;
            if (shouldLoadOlder(history.get(channelId), event.target.scrollTop)) {
                loadOlder(channelId);
            }
        }, { passive: true });

        wirePushToTalk();

        input?.addEventListener('input', updateMention);
        input?.addEventListener('click', updateMention);
        input?.addEventListener('keyup', (event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateMention();
        });
        input?.addEventListener('blur', () => {
            // Give a popover mousedown its moment before withdrawing the offer.
            setTimeout(() => { mention = null; paintMentionPop(); }, 120);
        });

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
    /* ── mention autocomplete ────────────────────────────────────────────── */

    // Which token is being completed, and which row is highlighted. Null when closed.
    let mention = null;

    function paintMentionPop() {
        const wrap = $('.composer-wrap', mount);
        if (!wrap) return;
        let pop = $('#mentionPop', mount);

        if (!mention || !mention.items.length) {
            pop?.remove();
            return;
        }
        if (!pop) {
            pop = document.createElement('div');
            pop.id = 'mentionPop';
            pop.className = 'mention-pop';
            wrap.append(pop);
        }
        pop.innerHTML = mention.items.map((p, i) => `
            <button type="button" class="mention-row${i === mention.index ? ' current' : ''}"
                    data-mention="${esc(p.username)}">
              ${avatar(p, { size: 'sm', presence: false })}
              <span class="mention-name">${esc(p.displayName ?? p.username)}</span>
              <span class="mention-user">@${esc(p.username)}</span>
            </button>`).join('');

        // mousedown, not click: click fires after the input's blur has already closed
        // the popover, and the pick would be lost.
        pop.querySelectorAll('[data-mention]').forEach((row) => {
            row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                pickMention(row.dataset.mention);
            });
        });
    }

    function updateMention() {
        const input = $('#composerInput', mount);
        if (!input) return;
        const found = mentionQuery(input.value, input.selectionStart ?? input.value.length);
        if (!found) { mention = null; paintMentionPop(); return; }

        const view = state.toShell();
        const items = matchMentions(found.query, view.people, {
            roomId: view.room.id,
            exclude: view.me.username,
        });
        // Keep the highlight on the same row across keystrokes when possible.
        const keep = mention?.items[mention.index]?.username;
        const index = Math.max(0, items.findIndex((p) => p.username === keep));
        mention = { ...found, items, index };
        paintMentionPop();
    }

    function pickMention(username) {
        const input = $('#composerInput', mount);
        if (!input || !mention) return;
        const caret = input.selectionStart ?? input.value.length;
        const next = insertMention(input.value, mention.start, caret, username);
        input.value = next.text;
        input.setSelectionRange(next.caret, next.caret);
        mention = null;
        paintMentionPop();
        input.focus();
    }

    /* ── reading without standing ────────────────────────────────────────── */

    function openTextChannel(id) {
        state.setView(id);
        loadHistory(id).then(() => ackRead(id)).catch(() => {});
        paint();
    }

    let ackTimer = 0;

    /** Tell the server the newest message here has been seen, account-wide. */
    function ackRead(channelId) {
        const list = state.raw.messages.get(channelId) ?? [];
        const newest = list.at(-1);
        if (!newest?.id) { state.clearUnread(channelId); return; }
        clearTimeout(ackTimer);
        ackTimer = setTimeout(() => {
            link.send('text-chat:read', {
                channelId, createdAt: newest.createdAt, id: newest.id,
            });
        }, 400);
        state.clearUnread(channelId);
    }

    /** Whether the reader is actually following the timeline right now. */
    function readingNow(channelId) {
        const viewId = state.raw.viewChannelId ?? state.raw.currentChannelId;
        if (channelId !== viewId) return false;
        if (document.visibilityState === 'hidden') return false;
        const scroller = $('#timeline', mount);
        if (!scroller) return false;
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    }

    /** The narrow-window drawer: the sidebar, floating over the room. */
    function setDrawer(open) {
        $('.app-shell', mount)?.classList.toggle('drawer-open', Boolean(open));
    }

    function wirePushToTalk() {
        const typing = (target) => target instanceof HTMLElement
            && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

        const setTalking = (talking) => {
            if (!prefs.pushToTalk || pttHeld === talking) return;
            pttHeld = talking;
            const deafened = Boolean(state.toShell().me.deafened);
            const muted = effectiveMute({ pushToTalk: true, held: talking, deafened });
            voice.setMuted(muted);
            link.send('setMute', { muted, deafened });
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
        mention = null;
        paintMentionPop();
        msgNoise.record(Date.now());

        // Cleared immediately. Waiting for the server to acknowledge before clearing means
        // that on a slow link people retype, or send twice.
        input.value = '';
        input.style.height = 'auto';
        link.send('text-chat:send', {
            channelId: state.raw.viewChannelId ?? state.raw.currentChannelId,
            body,
        });
    }

    /* ── lifecycle ───────────────────────────────────────────────────────── */

    async function start() {
        mount.innerHTML = '';
        const view = state.toShell();
        mount.append(html(shell({
            ...view,
            me: { ...view.me, pttOn: Boolean(prefs.pushToTalk) },
            voice: voiceState,
        })));
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
