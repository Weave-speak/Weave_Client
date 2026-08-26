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
import { rail, dmSearchView, dmSearchResults } from './views/rail.js';
import { messageList, typingLine, voiceNoticeMarkup, emptyState, roomGlyph } from './views/timeline.js';
import { createRoomState } from './state.js';
import { WeaveBackground, createMessageNoise } from '../ui/weave-background.js';
import { createVoice } from '../media/voice.js';
import { effectiveMute, onPushToTalkChange } from '../media/mute-policy.js';
import { screenShareSettings, cameraConstraints } from '../media/presets.js';
import { createSettings, readPrefs } from '../settings/index.js';
import { createRoomBrowser } from '../rooms/browser.js';
import { createModal } from '../ui/modal.js';
import { platform } from '../platform/index.js';
import { userHue } from '../ui/hue.js';
import { mentionQuery, matchMentions, insertMention } from './mentions.js';
import { freshHistory, advanceHistory, nextPageQuery, shouldLoadOlder } from './history.js';
import { stageView, tileKey, sharePickerView } from './views/stage.js';
import { extractUrls } from './embeds.js';
import { avatar } from './views/parts.js';
import { esc } from '../ui/dom.js';
import { $, $$, html, safe } from '../ui/dom.js';

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

    /** The people standing in MY room right now, producers and all — the sync's truth. */
    const roomPeers = () => [...state.raw.peers.values()]
        .filter((p) => p.channelId === state.raw.currentChannelId && p.cid !== state.raw.selfCid);

    // The self-heal beat: cheap when nothing is wrong (two set-diffs), decisive when a
    // frame was lost. Fifteen seconds keeps "X can't hear Y" from ever lasting a minute.
    const syncTimer = setInterval(() => {
        if (state.raw.currentChannelId) voice.sync(roomPeers()).catch(() => {});
    }, 15_000);

    // The pill's "opus 64 kb/s": polled while voice is up, blank otherwise.
    let mediaStats = { codec: null, bitrateKbps: null };
    const statsTimer = setInterval(async () => {
        const next = (await voice.mediaStats().catch(() => null)) ?? { codec: null, bitrateKbps: null };
        if (next.codec !== mediaStats.codec || next.bitrateKbps !== mediaStats.bitrateKbps) {
            mediaStats = next;
            paintConnection({ ...state.raw.connection, ...mediaStats });
        }
    }, 5_000);

    let prefs = readPrefs(server.id);
    let pttHeld = false;
    // Text channels are openable-from-anywhere only when the server broadcasts chat
    // that way; against an older server every click is still a move.
    const canBrowse = features.includes('chat.browse');
    const canDm = features.includes('module.dm');
    const canReact = features.includes('chat.reactions');
    const canPreview = features.includes('chat.link-previews');
    const canCall = features.includes('dm.calls');
    // The call the user is part of, and where to stand again when it ends.
    let activeCallThreadId = null;
    let preCallChannelId = null;
    let ringModal = null;

    // key `${cid}:${slot}` -> MediaStream. 'self' is our own preview.
    const videoStreams = new Map();
    let stageFocus = null;
    // The user's own stream/chat split, in pixels, once they have dragged the divider.
    // Null means the CSS default share.
    let stageHeightPx = null;
    // A watch clicked from another room: focus lands when the stream does.
    let pendingFocus = null;

    const voice = createVoice({
        link,
        onVideo({ cid, slot, stream }) {
            const key = tileKey(cid, slot);
            // Our own tile appearing or vanishing is also the sidebar icon's truth.
            if (cid === 'self' && link.cid) state.markOwnProducer(link.cid, slot, Boolean(stream));
            if (!stream) {
                videoStreams.delete(key);
                if (stageFocus === key) stageFocus = null;
            } else {
                videoStreams.set(key, stream);
                // Watching is opt-in now, so every remote stream that arrives here was
                // ASKED for — pendingFocus carries the click that asked.
                if (pendingFocus === key) {
                    stageFocus = key;
                    pendingFocus = null;
                }
            }
            paintStage();
        },
        getAudioConstraints: () => ({
            echoCancellation: prefs.echoCancellation !== false,
            noiseSuppression: prefs.noiseSuppression !== false,
            autoGainControl: prefs.autoGainControl !== false,
            ...(prefs.micDevice ? { deviceId: { exact: prefs.micDevice } } : {}),
        }),
        getChainSettings: () => ({
            micGain: Number(prefs.micGain ?? 100),
            noiseGate: Boolean(prefs.noiseGate),
            gateSensitivity: Number(prefs.gateSensitivity ?? 64),
        }),
        onMicTelemetry(data) {
            try { window.dispatchEvent(new CustomEvent('weave:mic-level', { detail: data })); } catch { /* no DOM */ }
        },
        getVideoConstraints: () => cameraConstraints({
            device: prefs.camDevice ?? null,
            res: prefs.camRes ?? '720',
            fps: Number(prefs.camFps ?? 30),
        }),
        getScreenConstraints: () => screenShareSettings({
            preset: prefs.streamPreset, prefer: prefs.streamPrefer,
        }).constraints,
        getScreenContentHint: () => screenShareSettings({
            preset: prefs.streamPreset, prefer: prefs.streamPrefer,
        }).contentHint,
        getScreenEncodings: () => screenShareSettings({
            preset: prefs.streamPreset, prefer: prefs.streamPrefer,
        }).encodings,
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

    const canPrivate = features.includes('channels.private');
    const browser = createRoomBrowser({
        state,
        canCreate: Boolean(user?.isAdmin) || canPrivate,
        isAdmin: Boolean(user?.isAdmin),
        canPrivate,
        createModal,
        dom: { $, $$ },
        onEnter(channelId) {
            const target = state.raw.channels.find((c) => c.id === channelId);
            if (canBrowse && target?.kind === 'text') {
                openTextChannel(channelId);
                return;
            }
            if (channelId === state.raw.currentChannelId) return;
            link.noteChannel(channelId);
            link.send('move', { channelId });
        },
        async onCreate({ name, kind, private: isPrivate = false }) {
            const { channel } = await api.request('POST', '/api/channels', {
                body: { name, kind, ...(isPrivate ? { private: true } : {}) },
            });
            // The server broadcasts the fresh list to everyone, us included; nothing to
            // merge locally. Older servers do not broadcast, so fetch once to be sure.
            api.request('GET', '/api/channels')
                .then(({ channels }) => state.setChannels(channels))
                .catch(() => {});
            return channel;
        },
    });

    const settings = createSettings({
        api,
        server,
        me: user,
        features,
        onPrefsChange: applyPrefs,
        onSignOut: signOut,
        getActiveMicrophone: () => voice.activeMicrophone(),
        checkForUpdates: () => platform.updates.check?.(),
    });

    /**
     * Make a changed preference take effect now, rather than on the next launch.
     *
     * A settings screen whose switches only apply after a restart teaches people that the
     * switches do not work.
     */
    function applyPrefs(next, changedKey) {
        const wasPushToTalk = prefs.pushToTalk;
        const wasMicDevice = prefs.micDevice;
        prefs = next;
        // A device change cannot ride applyConstraints — it needs a fresh capture,
        // swapped into the live producer.
        if (changedKey === 'micDevice' || (next.micDevice ?? null) !== (wasMicDevice ?? null)) {
            voice.switchMicrophone().catch(() => { /* the old device keeps working */ });
        } else {
            voice.applyAudioConstraints().catch(() => {});
        }
        voice.applyChainSettings();

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
    /** The server ended us — do the local half of signing out and surface why. */
    let walkingOut = false;
    async function signedOutBy(failure) {
        if (walkingOut) return;
        walkingOut = true;
        clearInterval(syncTimer);
        clearInterval(statsTimer);
        api.setToken(null);
        await platform.tokens.clear(server.id).catch(() => {});
        // A wiped or revoked account's saved password is dead weight that would re-fill
        // a login that can never succeed again.
        if (failure?.code !== 'password_reset') {
            await platform.credentials.clear(server.id).catch(() => {});
        }
        voice.stop();
        link.close();
        onSignedOut?.({ notice: failure?.message ?? 'You were signed out by the server.' });
    }

    async function signOut() {
        clearInterval(syncTimer);
        clearInterval(statsTimer);
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
        const railEl = $('.rail', mount);
        if (railEl) railEl.outerHTML = rail({ dms: view.dms, inRoom: !view.dmOpen });
        setHtml('.typing', typingLine(view.typing));
        setHtml('#voiceNotice', voiceNoticeMarkup(voiceState));
        paintConnection({ ...view.connection, ...mediaStats });
        paintRoomHead(view.room);
        paintMediaButtons();
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

    function paintConnection(conn) {
        const pill = $('.conn-pill', mount);
        if (pill) pill.outerHTML = connectionPill(conn);
    }

    function paintRoomHead(room) {
        const title = $('#roomHead h1', mount);
        if (title) title.textContent = room.name ?? 'Room';
        const icon = $('#roomIcon', mount);
        if (icon) icon.innerHTML = roomGlyph(room);
        const topic = $('#roomTopic', mount);
        if (topic) {
            topic.textContent = room.topic ?? '';
            topic.hidden = !room.topic;
        }
        const addBtn = $('#addMemberBtn', mount);
        // Private huddles only. A DM is a strict pair — the server has no operation that
        // could grow one — so the button never shows there, whatever else is true.
        if (addBtn) addBtn.hidden = !(room.private && room.member && room.kind !== 'dm');
        const callBtn = $('#dmCallBtn', mount);
        const hangupBtn = $('#dmHangupBtn', mount);
        const inThisCall = room.kind === 'dm' && activeCallThreadId === room.id;
        if (callBtn) callBtn.hidden = !(canCall && room.kind === 'dm' && !inThisCall);
        if (hangupBtn) hangupBtn.hidden = !inThisCall;
        const composer = $('#composerInput', mount);
        if (composer) composer.placeholder = `Message ${room.name ?? 'the room'}…`;
    }

    /**
     * Paint the stage — and ONLY when video actually changed.
     *
     * Deliberately not part of repaint(): rebuilding <video> elements on every chat
     * message or presence blink would visibly restart the pictures. The stage answers to
     * onVideo, focus clicks and room moves, nothing else.
     */
    function paintStage() {
        const slot = $('#stageSlot', mount);
        if (!slot) return;

        const me = state.raw.me;
        const tiles = [];

        // Your own streams: always live (they are local tracks, they cost nothing).
        for (const [key, stream] of videoStreams) {
            const [cid, slotName] = key.split(':');
            if (cid !== 'self') continue;
            tiles.push({
                key, cid, slot: slotName, label: 'You', self: true, live: true, stream,
                chipName: me?.username ?? 'You',
            });
        }

        // Everyone else's come from the ROSTER's producer list, watched or not: an
        // unwatched stream is a placeholder tile — present, silent, costing nothing —
        // and clicking Watch is what starts the packets.
        for (const peer of state.raw.peers.values()) {
            if (peer.channelId !== state.raw.currentChannelId) continue;
            if (peer.userId === me?.id) continue;
            for (const producer of peer.producers ?? []) {
                if (producer.slot !== 'screen' && producer.slot !== 'webcam') continue;
                const key = tileKey(peer.cid, producer.slot);
                const stream = videoStreams.get(key) ?? null;
                const audioSlot = producer.slot === 'screen' ? 'screen-audio' : 'audio';
                const hasAudio = (peer.producers ?? []).some((pr) => pr.slot === audioSlot);
                tiles.push({
                    key,
                    cid: peer.cid,
                    slot: producer.slot,
                    label: peer.displayName || peer.username || 'Someone',
                    chipName: peer.username,
                    self: false,
                    live: Boolean(stream),
                    stream,
                    frame: stream ? null : lastFrames.get(key) ?? null,
                    audio: stream && hasAudio
                        ? { ...voice.getListen(peer.cid, audioSlot), slot: audioSlot } : null,
                });
            }
        }

        // Focus may only rest on a live tile; a placeholder in focus would be a black box.
        if (stageFocus && !tiles.some((t) => t.key === stageFocus && t.live)) stageFocus = null;
        // A dragged height belongs to the SPLIT; the compact indication row sizes itself.
        if (!stageFocus) stageHeightPx = null;

        slot.innerHTML = stageView({ tiles, focus: stageFocus, heightPx: stageHeightPx });

        // Streams attach after paint; a view that touched srcObject would not be a view.
        for (const el of slot.querySelectorAll('[data-tile]')) {
            const stream = videoStreams.get(el.dataset.tile);
            const video = el.querySelector('video');
            if (video && stream && video.srcObject !== stream) {
                video.srcObject = stream;
                video.play().catch(() => { /* autoplay policies; the click that follows fixes it */ });
            }
        }

        paintMediaButtons();
    }

    /**
     * Put one stream in the big frame — the SWAP the carousel promises. Whatever held
     * focus before goes back to being a thumbnail; if it was a remote stream, watching
     * it ends too, so exactly one remote stream is consumed at a time.
     */
    // The last thing a stream showed, kept as a small JPEG per tile key. When someone
    // stops watching, the placeholder wears this frame BLURRED — "there is a picture
    // here, you are just not receiving it" — instead of falling back to stripes.
    const lastFrames = new Map();

    function snapshotTile(key) {
        const video = $(`[data-tile="${key}"] video`, mount);
        if (!video || !video.videoWidth) return;
        try {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 320 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            lastFrames.set(key, canvas.toDataURL('image/jpeg', 0.6));
        } catch { /* a tainted or dead frame just means the plain placeholder */ }
    }

    function focusTileKey(key) {
        if (!key || key === stageFocus) return;
        const previous = stageFocus;
        if (previous && !previous.startsWith('self:') && previous !== key) {
            snapshotTile(previous);
            const [prevCid, prevSlot] = previous.split(':');
            voice.setWatching(prevCid, prevSlot, false);
        }
        if (key.startsWith('self:')) {
            // Your own preview is already local and live; focus is immediate.
            stageFocus = key;
            pendingFocus = null;
        } else {
            const [cid, slot] = key.split(':');
            if (videoStreams.has(key)) {
                stageFocus = key;
                pendingFocus = null;
            } else {
                pendingFocus = key;
                voice.setWatching(cid, slot, true);
            }
        }
        paintStage();
    }

    /** The header's camera and screen buttons: shown where sending is possible, lit while on. */
    function paintMediaButtons() {
        const standing = state.raw.channels.find((c) => c.id === state.raw.currentChannelId);
        // A room the list does not contain is a call room: video belongs there most of all.
        const canSend = standing
            ? standing.allowVideo !== false
            : Boolean(state.raw.currentChannelId);
        const cam = $('#camBtn', mount);
        const screen = $('#screenBtn', mount);
        if (cam) {
            cam.hidden = !canSend;
            cam.classList.toggle('on', voice.webcamOn);
            cam.setAttribute('aria-pressed', String(voice.webcamOn));
            cam.title = voice.webcamOn ? 'Turn your camera off' : 'Turn your camera on';
        }
        if (screen) {
            screen.hidden = !canSend;
            screen.classList.toggle('on', voice.screenOn);
            screen.setAttribute('aria-pressed', String(voice.screenOn));
            screen.title = voice.screenOn ? 'Stop sharing your screen' : 'Share your screen';
        }
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

        // Reacting is possible in channels when the server carries the module; DM
        // messages have no reaction store yet, so the add button stays away there.
        const inDm = Boolean(state.raw.activeDmId);
        list.innerHTML = messageList(items.map((i) =>
            (i.kind === 'message'
                ? { ...i, canReact: canReact && !inDm, embedPlaying: playingEmbeds.has(i.id) }
                : i)));
        hydrateAuthImages();
        if (!inDm) requestPreviews(state.raw.viewChannelId ?? state.raw.currentChannelId);

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

        if (msg.type === 'media_reset') {
            // The server's announced media address moved — on a home line the ISP can
            // change it under us, and every transport we hold is now pointed at somebody
            // else's IP. Nothing looks wrong from here: the socket is fine, the roster is
            // right, and no audio arrives in either direction. Rebuild against the new
            // address rather than waiting out an ICE timeout per transport.
            const channel = state.raw.channels.find((c) => c.id === state.raw.currentChannelId)
                ?? { id: state.raw.currentChannelId };
            // Without capabilities startVoice() tears media down and then returns before
            // rebuilding it — worse than doing nothing. Leave the existing path alone and
            // let it heal the slow way instead.
            if (state.raw.currentChannelId && msg.rtpCapabilities) {
                startVoice({
                    type: 'moved',
                    channel,
                    mediaReset: true,
                    rtpCapabilities: msg.rtpCapabilities,
                    peers: roomPeers(),
                }).catch((err) => {
                    voiceState = { state: 'failed', message: err.message };
                    paint();
                });
            }
            return;
        }

        if (msg.type === 'producers_truth') {
            // Server memory beats client memory: update the roster's bookkeeping AND
            // hand the same list straight to the media layer, so the heal runs on what
            // the server knows rather than on whatever frames happened to survive.
            state.applyProducersTruth(msg.producers);
            voice.sync(msg.producers).catch(() => {});
            paintStage();
            return;
        }

        if (msg.type === 'text-chat:typing' && msg.channelId) {
            // 8s of life per ping against the server's 4s relay throttle: one lost ping
            // costs a flicker, never a stuck banner. The receiver owns expiry — and
            // schedules the repaint that makes the lapse visible, since expiry is the
            // one state change no event announces.
            state.noteTyping(msg.channelId, msg.username, 8000);
            setTimeout(() => paint(), 8200);
            return;
        }
        if (msg.type === 'dm:typing' && msg.threadId) {
            state.noteTyping(msg.threadId, msg.username, 8000);
            setTimeout(() => paint(), 8200);
            return;
        }
        if (msg.type === 'reactions:changed' && msg.messageId) {
            state.applyReaction(msg);
            return;
        }

        if (msg.type === 'text-chat:cleared' && msg.channelId) {
            // An admin emptied the channel. What we are showing of it is now fiction.
            state.setMessages(msg.channelId, []);
            state.clearUnread(msg.channelId);
            return;
        }

        if (msg.type === 'dm:message' && msg.message) {
            const record = msg.message;
            state.raw.typing.get(record.threadId)?.delete(record.authorName);
            const known = state.raw.dms.some((t) => t.id === record.threadId);
            if (!known) {
                // Someone opened a brand-new thread by writing into it: fetch the rail
                // fresh so their tile appears, then account for this first word.
                api.request('GET', '/api/dm/threads')
                    .then(({ threads = [] }) => { state.setDmThreads(threads); paint(); })
                    .catch(() => {});
            }
            state.addDmMessage(record.threadId, record);
            if (record.authorId !== state.raw.me?.id) {
                if (state.raw.activeDmId === record.threadId && document.visibilityState !== 'hidden') {
                    ackDmRead(record.threadId);
                } else {
                    state.bumpDmUnread(record.threadId);
                }
            }
            return;
        }
        if (msg.type === 'dm:accepted') return;   // our own echo carries the message frame

        if (msg.type === 'dm:ring') {
            showRing(msg);
            return;
        }
        if (msg.type === 'dm:call_live') {
            activeCallThreadId = msg.threadId;
            ringModal?.close();
            ringModal = null;
            paint();
            return;
        }
        if (msg.type === 'dm:call_ended') {
            ringModal?.close();
            ringModal = null;
            const wasMine = activeCallThreadId === msg.threadId || msg.threadId;
            activeCallThreadId = null;
            if (wasMine) {
                const back = preCallChannelId;
                preCallChannelId = null;
                const standing = state.raw.currentChannelId;
                const inCallRoom = standing && !state.raw.channels.some((c) => c.id === standing);
                if (inCallRoom) {
                    if (back && state.raw.channels.some((c) => c.id === back)) {
                        link.noteChannel(back);
                        link.send('move', { channelId: back });
                    } else {
                        voice.stop();
                        link.noteChannel(null);
                        link.send('leave');
                    }
                }
                voiceState = {
                    state: 'unavailable',
                    message: msg.reason === 'declined' ? 'Call declined.'
                        : msg.reason === 'no_answer' ? 'No answer.'
                            : 'Call ended.',
                };
                paint();
                setTimeout(() => { voiceState = { state: 'idle' }; paint(); }, 4000);
            }
            return;
        }

        if (msg.type === 'left') {
            state.apply(msg);
            return;
        }

        if (msg.type === 'moved' || msg.type === 'joined') {
            msgNoise.reset();
            stageFocus = null;
            // Stepping INTO a call room remembers the room being left, so ending the
            // call puts you back where you stood rather than nowhere.
            if (msg.channel?.system && !state.raw.channels.some((c) => c.id === msg.channel.id)) {
                preCallChannelId ??= state.raw.currentChannelId;
            }
            state.apply(msg);
            // Both fetches land AFTER the joined frame has painted, so they must paint
            // again themselves — without it the rail and the badges sat empty until the
            // next unrelated event happened to repaint (caught by an E2E on a restart).
            if (msg.type === 'joined' && canBrowse) {
                api.request('GET', '/api/chat/reads')
                    .then(({ channels = [] }) => { state.setReads(channels); paint(); })
                    .catch(() => { /* badges start at zero; the frames keep them honest */ });
            }
            if (msg.type === 'joined' && canDm) {
                api.request('GET', '/api/dm/threads')
                    .then(({ threads = [] }) => { state.setDmThreads(threads); paint(); })
                    .catch(() => { /* the rail stays empty; a reconnect retries */ });
            }
            // Entering a room is seeing its latest page, so the backlog is acked too —
            // without this, days of history in your home room stay "unread" for ever.
            // Arriving NOWHERE loads nothing and starts nothing.
            if (msg.channel?.id) loadHistory(msg.channel.id)
                .then(() => { if (canBrowse) ackRead(msg.channel.id); })
                .catch(() => {});
            if (!msg.channel) return;
            startVoice(msg).catch((err) => {
                voiceState = { state: 'failed', message: err.message };
                paint();
            });
            return;
        }

        // A screen starting or stopping is part of what happened in this room, so it
        // lands in the timeline the way the design draws it — before the voice layer
        // claims the frame. Screens only: camera toggles would be noise.
        if ((msg.type === 'producer_new' || msg.type === 'producer_closed') && msg.slot === 'screen') {
            const peer = state.raw.peers.get(msg.cid);
            const channelId = peer?.channelId ?? state.raw.currentChannelId;
            if (peer && channelId) {
                state.addMessage(channelId, {
                    kind: 'system',
                    id: `sys-${msg.type === 'producer_new' ? 'start' : 'end'}-${msg.producerId}`,
                    icon: 'screen',
                    who: peer.displayName || peer.username,
                    text: msg.type === 'producer_new'
                        ? 'started streaming their screen'
                        : 'stopped streaming',
                    createdAt: Date.now(),
                });
            }
        }

        // Media frames first: the voice layer is waiting on specific replies, and a frame it
        // has claimed is not something the roster needs to see.
        if (voice.handle(msg)) {
            state.apply(msg);
            // Placeholder tiles are drawn from the roster's producer lists, so the frames
            // that change those lists repaint the stage even when no stream is consumed.
            if (msg.type === 'producer_closed' && msg.cid) lastFrames.delete(`${msg.cid}:${msg.slot}`);
            if (msg.type === 'peer_left' && msg.cid) {
                for (const key of [...lastFrames.keys()]) if (key.startsWith(`${msg.cid}:`)) lastFrames.delete(key);
            }
            if (['producer_new', 'producer_closed', 'peer_left'].includes(msg.type)) paintStage();
            return;
        }

        state.apply(msg);
        if (['joined', 'moved', 'peer_joined', 'peer_left'].includes(msg.type)) paintStage();
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
        } else if (frame.type === 'joined') {
            // A 'joined' frame is a BRAND-NEW server-side peer — which is exactly what a
            // reconnect produces, and what every client gets after the server restarts.
            // The server has no transports, producers or consumers for us at all, but the
            // local objects survive the socket drop: ensureSend()/ensureRecv() see them,
            // hand them straight back without asking for replacements, and every produce
            // and consume against those zombies is refused with 'no_transport' for the
            // rest of the session. The room looks joined, the roster is right, and no
            // audio moves in either direction. Rebuild from nothing instead.
            await voice.onMoved({ rtpCapabilities: frame.rtpCapabilities, mediaReset: true });
        }
        if (!frame.rtpCapabilities) return;

        await voice.start(frame.rtpCapabilities);

        // Consume everyone already talking before opening our own microphone, so the room
        // is audible immediately rather than after a permission prompt is answered.
        //
        // FILTERED to this channel: the joined frame carries the whole server's roster
        // (for the sidebar), and consuming someone in another room stalls twelve seconds
        // per producer waiting for a reply the server rightly refuses — enough stalls and
        // the people actually beside you are never consumed. That was a real, reported
        // one-way-audio bug.
        for (const peer of (frame.peers ?? []).filter((p) => p.channelId === channel?.id)) {
            await voice.consumePeer(peer);
        }
        // And one reconciliation straight after: anything that changed WHILE the loop
        // above was awaiting is caught now rather than at the next beat — and once more
        // shortly after, for the peer whose arrival raced this very join (the second
        // party of a call answering while the first was still setting up).
        voice.sync(roomPeers()).catch(() => {});
        setTimeout(() => voice.sync(roomPeers()).catch(() => {}), 3000);

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

    /** Staple aggregated reactions onto a fetched page. Absent module, absent call. */
    async function withReactions(records) {
        if (!canReact || !records?.length) return records ?? [];
        try {
            const ids = records.map((r) => r.id).join(',');
            const { reactions } = await api.request('GET', `/api/reactions?messageIds=${ids}`);
            return records.map((r) => (reactions[r.id] ? { ...r, reactions: reactions[r.id] } : r));
        } catch {
            return records;   // history without reaction counts still beats no history
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
            state.setMessages(channelId, await withReactions(reply.messages));
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
            if (!state.prependMessages(channelId, await withReactions(reply.messages))) paint();
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

    /* ── rich content: uploads, previews, images, embeds ─────────────────── */

    // The image waiting on the composer, if any: uploaded already, sent with the next
    // message, shown as a chip the user can discard.
    let pendingAttachment = null;
    let attachInput = null;

    // Messages whose video embed the user has started; the view renders those as the
    // live iframe rather than the card.
    const playingEmbeds = new Set();

    // url -> objectURL for auth-gated images, so each image is fetched once.
    const blobUrls = new Map();
    // url -> preview | null (null = asked and answered nothing), so the server is asked once.
    const previewCache = new Map();
    const previewAsked = new Set();

    /** Fill every <img data-auth-src> with bearer-fetched bytes. Idempotent per paint. */
    function hydrateAuthImages() {
        for (const img of $$('img[data-auth-src]', mount)) {
            const url = img.dataset.authSrc;
            delete img.dataset.authSrc;
            const held = blobUrls.get(url);
            if (held) { img.src = held; continue; }
            api.fetchBlob(url).then((blob) => {
                const obj = URL.createObjectURL(blob);
                blobUrls.set(url, obj);
                img.src = obj;
            }).catch(() => { img.closest('.attach-image-wrap')?.remove(); });
        }
    }

    /**
     * Ask the server about the first link in any message that has one and no preview
     * yet. Once per message, once per URL — the server caches too, but not asking at
     * all is cheaper than asking politely.
     */
    function requestPreviews(channelId) {
        if (!canPreview) return;
        const list = state.raw.messages.get(channelId) ?? [];
        for (const record of list) {
            if (record.preview !== undefined && record.preview !== null) continue;
            if (previewAsked.has(record.id)) continue;
            const url = extractUrls(record.body)[0];
            if (!url) continue;
            previewAsked.add(record.id);
            const held = previewCache.get(url);
            if (held !== undefined) {
                if (held) state.setMessagePreview(channelId, record.id, held);
                continue;
            }
            api.request('GET', `/api/link-preview?url=${encodeURIComponent(url)}`)
                .then((data) => {
                    previewCache.set(url, data);
                    state.setMessagePreview(channelId, record.id, data);
                })
                .catch(() => { previewCache.set(url, null); });
        }
    }

    async function pickAttachment() {
        if (!attachInput) {
            attachInput = document.createElement('input');
            attachInput.type = 'file';
            attachInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
            attachInput.addEventListener('change', async () => {
                const file = attachInput.files?.[0];
                attachInput.value = '';
                if (!file) return;
                paintAttachStrip({ uploading: true, name: file.name });
                try {
                    const stored = await api.uploadFile(file);
                    pendingAttachment = { ...stored, name: file.name.slice(0, 80) };
                    paintAttachStrip();
                } catch (err) {
                    pendingAttachment = null;
                    paintAttachStrip({ error: err?.message ?? 'Upload failed.' });
                }
            });
        }
        attachInput.click();
    }

    /** The little chip above the composer: what is about to ride the next message. */
    function paintAttachStrip(stateOverride = null) {
        let strip = $('#attachStrip', mount);
        if (!strip) {
            const wrap = $('.composer-wrap', mount) ?? $('.composer', mount)?.parentElement;
            if (!wrap) return;
            strip = document.createElement('div');
            strip.id = 'attachStrip';
            wrap.prepend(strip);
        }
        if (stateOverride?.uploading) {
            strip.innerHTML = safe`<span class="attach-chip">Uploading ${stateOverride.name}…</span>`;
            return;
        }
        if (stateOverride?.error) {
            strip.innerHTML = safe`<span class="attach-chip error">${stateOverride.error}</span>`;
            setTimeout(() => { if (!pendingAttachment) strip.innerHTML = ''; }, 4000);
            return;
        }
        if (!pendingAttachment) { strip.innerHTML = ''; return; }
        strip.innerHTML = safe`
          <span class="attach-chip">
            <img data-auth-src="${pendingAttachment.url}" alt="">
            <span>${pendingAttachment.name}</span>
            <button type="button" data-attach-clear aria-label="Remove attachment">✕</button>
          </span>`;
        hydrateAuthImages();
    }

    /* ── the composer's emoji palette ────────────────────────────────────── */

    const COMPOSER_EMOJI = [
        '😀', '😄', '😂', '🤣', '😊', '😉', '😍', '😘',
        '🤔', '🙃', '😅', '😭', '😤', '😡', '🥶', '😱',
        '👍', '👎', '👏', '🙌', '🤝', '💪', '🙏', '👀',
        '❤️', '🔥', '✨', '🎉', '💯', '✅', '❌', '❓',
        '🍕', '☕', '🍺', '🎮', '🎲', '🎧', '🖥️', '🚀',
    ];
    let emojiPopEl = null;

    function closeEmojiPop() { emojiPopEl?.remove(); emojiPopEl = null; }

    function toggleEmojiPop(anchor) {
        if (emojiPopEl) return closeEmojiPop();
        const pop = document.createElement('div');
        pop.className = 'emoji-pop';
        pop.innerHTML = COMPOSER_EMOJI.map((e) =>
            `<button type="button" data-emoji-insert="${e}" aria-label="Insert ${e}">${e}</button>`).join('');
        const wrap = anchor.closest('.composer');
        wrap.style.position = 'relative';
        wrap.append(pop);
        emojiPopEl = pop;
    }

    /* ── the image lightbox ──────────────────────────────────────────────── */

    function openLightbox(src, alt = '') {
        closeLightbox();
        const layer = document.createElement('div');
        layer.className = 'lightbox';
        layer.id = 'lightbox';
        layer.innerHTML = safe`
          <button type="button" class="lightbox-close" data-lightbox-close
                  aria-label="Close (Esc)">✕</button>
          <img src="${src}" alt="${alt}">`;
        layer.addEventListener('click', (e) => {
            // The image itself is the only thing that is not an exit.
            if (e.target.tagName !== 'IMG') closeLightbox();
        });
        mount.append(layer);
        document.addEventListener('keydown', lightboxKey);
    }
    function lightboxKey(e) { if (e.key === 'Escape') closeLightbox(); }
    function closeLightbox() {
        $('#lightbox', mount)?.remove();
        document.removeEventListener('keydown', lightboxKey);
    }

    /* ── the reaction picker ─────────────────────────────────────────────── */

    // A fixed palette rather than a full emoji keyboard: eight covers most reacting,
    // and any emoji already on the message can be joined by clicking it.
    const REACT_SET = ['👍', '❤️', '😂', '😮', '😢', '🔥', '✅', '👀'];
    let reactPickEl = null;

    function closeReactPicker() {
        reactPickEl?.remove();
        reactPickEl = null;
    }

    function toggleReactPicker(anchor) {
        const messageId = anchor.closest('[data-message]')?.dataset.message;
        if (!messageId) return;
        if (reactPickEl?.dataset.for === messageId) return closeReactPicker();
        closeReactPicker();
        const pick = document.createElement('div');
        pick.className = 'react-pick';
        pick.dataset.for = messageId;
        pick.innerHTML = REACT_SET.map((e) =>
            `<button type="button" data-react="${e}" aria-label="React with ${e}">${e}</button>`).join('');
        // Inside the message li, so [data-message] resolves for the delegated handler
        // and a repaint of the list sweeps the popover away with its message. Absolute
        // within the li: the palette floats over the text and costs the layout nothing.
        const host = anchor.closest('[data-message]');
        if (!host) return;
        host.append(pick);
        const a = anchor.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        pick.style.left = `${Math.max(8, Math.round(a.left - h.left) - 8)}px`;
        // Above the button by default; below it when the timeline's edge would clip it.
        const scroller = host.closest('.timeline');
        const clipTop = scroller ? scroller.getBoundingClientRect().top : 0;
        const above = a.top - pick.offsetHeight - 8 >= clipTop;
        pick.style.top = above
            ? `${Math.round(a.top - h.top) - pick.offsetHeight - 8}px`
            : `${Math.round(a.bottom - h.top) + 8}px`;
        reactPickEl = pick;
    }

    /* ── what the user does ──────────────────────────────────────────────── */

    function wire() {
        mount.addEventListener('click', (event) => {
            const dmTile = event.target.closest('[data-dm]');
            if (dmTile) {
                openDm(dmTile.dataset.dm);
                return;
            }
            if (event.target.closest('[data-home]')) {
                state.closeDm();
                paint();
                return;
            }
            if (event.target.closest('[data-new-dm]')) {
                if (canDm) toggleDmSearch();
                return;
            }
            if (event.target.closest('[data-dm-call]')) {
                if (state.raw.activeDmId) {
                    activeCallThreadId = state.raw.activeDmId;
                    link.send('dm:call', { threadId: state.raw.activeDmId });
                    paint();
                }
                return;
            }
            if (event.target.closest('[data-dm-hangup]')) {
                // Hanging up is walking home: the move empties the call room, which is
                // what tells the server — and the other side — that the call is over.
                const back = preCallChannelId;
                preCallChannelId = null;
                activeCallThreadId = null;
                if (back && state.raw.channels.some((c) => c.id === back)) {
                    link.noteChannel(back);
                    link.send('move', { channelId: back });
                } else {
                    voice.stop();
                    link.noteChannel(null);
                    link.send('leave');
                }
                paint();
                return;
            }
            if (event.target.closest('[data-add-member]')) {
                toggleMemberPicker();
                return;
            }

            if (event.target.closest('[data-attach]')) { pickAttachment(); return; }
            if (event.target.closest('[data-attach-clear]')) {
                pendingAttachment = null;
                paintAttachStrip();
                return;
            }
            const emojiBtn = event.target.closest('[data-emoji]');
            if (emojiBtn) { toggleEmojiPop(emojiBtn); return; }
            const emojiPick = event.target.closest('[data-emoji-insert]');
            if (emojiPick) {
                const input = $('#composerInput', mount);
                if (input) {
                    const at = input.selectionStart ?? input.value.length;
                    input.setRangeText(emojiPick.dataset.emojiInsert, at, input.selectionEnd ?? at, 'end');
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                return;
            }
            if (!event.target.closest('.emoji-pop') && emojiPopEl) closeEmojiPop();

            const shot = event.target.closest('[data-lightbox]');
            if (shot?.src) { openLightbox(shot.src, shot.alt); return; }
            if (event.target.closest('[data-lightbox-close]')) { closeLightbox(); return; }

            const embed = event.target.closest('[data-embed-play]');
            if (embed) {
                // Click-to-play: only NOW does the provider's player get a seat, and only
                // its official embed surface, sandboxed. The playing set drives the VIEW,
                // so repaints re-render the iframe instead of killing the video.
                playingEmbeds.add(embed.dataset.embedPlay);
                paint();
                return;
            }

            const dl = event.target.closest('[data-download]');
            if (dl) {
                const a = dl.closest('[data-message]');
                const url = `/api/uploads/${dl.dataset.download}`;
                api.fetchBlob(url).then((blob) => {
                    const obj = URL.createObjectURL(blob);
                    const link2 = document.createElement('a');
                    link2.href = obj;
                    link2.download = a?.querySelector('.attach-name')?.textContent ?? 'file';
                    link2.click();
                    setTimeout(() => URL.revokeObjectURL(obj), 30_000);
                }).catch(() => {});
                return;
            }

            const chip = event.target.closest('[data-react]');
            if (chip) {
                const messageId = chip.closest('[data-message]')?.dataset.message;
                if (messageId) link.send('reactions:react', { messageId, emoji: chip.dataset.react });
                closeReactPicker();
                return;
            }
            const adder = event.target.closest('[data-add-reaction]');
            if (adder) {
                toggleReactPicker(adder);
                return;
            }
            if (!event.target.closest('.react-pick')) closeReactPicker();

            const watch = event.target.closest('[data-watch]');
            if (watch) {
                const key = watch.dataset.watch;
                const [cid] = key.split(':');
                const peer = state.raw.peers.get(cid);
                if (!peer) return;
                if (peer.channelId === state.raw.currentChannelId) {
                    focusTileKey(key);
                } else if (peer.channelId) {
                    // Elsewhere: participate — join their room, and focus their stream
                    // the moment it lands.
                    pendingFocus = key;
                    link.noteChannel(peer.channelId);
                    link.send('move', { channelId: peer.channelId });
                }
                return;
            }

            const watchBtn = event.target.closest('[data-watch-tile]');
            if (watchBtn) {
                focusTileKey(watchBtn.dataset.watchTile);
                return;
            }
            const nav = event.target.closest('[data-strip-nav]');
            if (nav) {
                const strip = nav.closest('.strip-shell')?.querySelector('.stage-strip');
                // One viewport of thumbnails per press, in reading order.
                strip?.scrollBy({ left: Number(nav.dataset.stripNav) * strip.clientWidth, behavior: 'smooth' });
                return;
            }

            const mute = event.target.closest('[data-listen-mute]');
            if (mute) {
                const holder = mute.closest('[data-tile]');
                const [cid, slotName] = holder.dataset.tile.split(':');
                const audioSlot = slotName === 'screen' ? 'screen-audio' : 'audio';
                const now = voice.getListen(cid, audioSlot);
                voice.setListen(cid, audioSlot, { muted: !now.muted });
                paintStage();
                return;
            }

            if (event.target.closest('[data-stop-watching]')) {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                const key = stageFocus;
                stageFocus = null;
                // Stopping means stopping: the subscription ends server-side and the tile
                // becomes a BLURRED still of the last frame received — no live feed.
                if (key && !key.startsWith('self:')) {
                    snapshotTile(key);
                    const [cid, slot] = key.split(':');
                    voice.setWatching(cid, slot, false);
                }
                paintStage();
                return;
            }
            if (event.target.closest('[data-tile-full]')) {
                const holder = event.target.closest('[data-tile]');
                if (document.fullscreenElement === holder) {
                    document.exitFullscreen().catch(() => { /* already leaving */ });
                } else {
                    holder?.requestFullscreen?.().catch(() => { /* denied is fine */ });
                }
                return;
            }
            if (event.target.closest('[data-listen-volume]')) return;   // the slider is not a focus click

            const tile = event.target.closest('[data-tile]');
            if (tile) {
                // The focused window itself is inert — misclicks on a stream you are
                // reading must not tear the layout down. Thumbnails and grid tiles focus.
                if (tile.closest('.stage-main')) return;
                focusTileKey(tile.dataset.tile);
                return;
            }

            if (event.target.closest('[data-toggle-cam]')) {
                (voice.webcamOn ? Promise.resolve(voice.disableWebcam()) : voice.enableWebcam())
                    .catch((err) => {
                        voiceState = {
                            state: 'no-mic',
                            message: err?.name === 'NotAllowedError'
                                ? 'Camera blocked. Voice still works.'
                                : `Camera unavailable: ${err.message}`,
                        };
                        paint();
                    })
                    .finally(() => paintMediaButtons());
                return;
            }

            if (event.target.closest('[data-toggle-screen]')) {
                (voice.screenOn ? Promise.resolve(voice.disableScreen()) : voice.enableScreen())
                    .catch((err) => {
                        // Cancelling the picker is a decision, not a failure.
                        if (err?.name === 'NotAllowedError') return;
                        voiceState = { state: 'no-mic', message: `Screen share failed: ${err.message}` };
                        paint();
                    })
                    .finally(() => paintMediaButtons());
                return;
            }

            const chat = event.target.closest('[data-open-chat]');
            if (chat) {
                openTextChannel(chat.dataset.openChat);
                setDrawer(false);
                return;
            }

            const room = event.target.closest('[data-open]');
            if (room) {
                const id = room.dataset.open;
                const target = state.raw.channels.find((c) => c.id === id);
                if (target?.private && !target.member) return;   // a locked door is not a button
                state.closeDm();
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
                // Disconnect from VOICE, stay on the server — the tooltip always said
                // "Leave the room" and it now means it. Sign out lives in settings.
                voice.stop();
                voiceState = { state: 'idle' };
                link.noteChannel(null);
                link.send('leave');
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
            if (event.key !== 'Escape') return;
            if (stageFocus) { stageFocus = null; paintStage(); return; }
            setDrawer(false);
        });

        // Nearing the top of the timeline asks for the page before it. The policy —
        // once at a time, never past the beginning — lives in history.js.
        $('#timeline', mount)?.addEventListener('scroll', (event) => {
            const channelId = state.raw.currentChannelId;
            if (shouldLoadOlder(history.get(channelId), event.target.scrollTop)) {
                loadOlder(channelId);
            }
        }, { passive: true });

        mount.addEventListener('input', (event) => {
            const slider = event.target.closest?.('[data-listen-volume]');
            if (!slider) return;
            const holder = slider.closest('[data-tile]');
            if (!holder) return;
            const [cid, slotName] = holder.dataset.tile.split(':');
            voice.setListen(cid, slotName === 'screen' ? 'screen-audio' : 'audio',
                { volume: Number(slider.value) / 100 });
        });

        mount.addEventListener('pointerdown', (event) => {
            const divider = event.target.closest?.('[data-stage-divider]');
            if (!divider) return;
            event.preventDefault();
            const stage = $('.stage', mount);
            const room = $('.room', mount);
            if (!stage || !room) return;
            const startY = event.clientY;
            const startH = stage.offsetHeight;
            const max = room.clientHeight * 0.62;
            const move = (ev) => {
                stageHeightPx = Math.min(max, Math.max(280, startH + ev.clientY - startY));
                stage.style.height = `${Math.round(stageHeightPx)}px`;
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });

        mount.addEventListener('dblclick', (event) => {
            const holder = event.target.closest?.('[data-tile]');
            if (!holder) return;
            if (document.fullscreenElement === holder) {
                document.exitFullscreen().catch(() => { /* already leaving */ });
            } else {
                holder.requestFullscreen?.().catch(() => { /* denied is fine */ });
            }
        });

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

        // Typing pings: throttled to one per 5s of ACTIVE typing (the server relays at
        // most every 4s regardless), never for an emptied composer, and reset on send so
        // the next message starts a fresh window.
        let typingSentAt = 0;
        input?.addEventListener('input', () => {
            if (!input.value.trim()) return;
            const now = Date.now();
            if (now - typingSentAt < 5000) return;
            typingSentAt = now;
            if (state.raw.activeDmId) {
                link.send('dm:typing', { threadId: state.raw.activeDmId });
            } else {
                const channelId = state.raw.viewChannelId ?? state.raw.currentChannelId;
                if (channelId) link.send('text-chat:typing', { channelId });
            }
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

    async function openDm(threadId) {
        state.openDm(threadId);
        paint();
        try {
            const reply = await api.request('GET', `/api/dm/threads/${encodeURIComponent(threadId)}/messages?limit=50`);
            state.setDmMessages(threadId, reply.messages ?? []);
            ackDmRead(threadId);
        } catch { /* the thread renders empty; sending still works */ }
        paint();
    }

    function ackDmRead(threadId) {
        const list = state.raw.dmMessages.get(threadId) ?? [];
        const newest = list.at(-1);
        state.clearDmUnread(threadId);
        if (!newest?.id) return;
        link.send('dm:read', { threadId, createdAt: newest.createdAt, id: newest.id });
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

    /* ── starting a new DM ───────────────────────────────────────────────── */

    function toggleDmSearch() {
        const existing = $('#dmSearch', mount);
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.id = 'dmSearch';
        panel.className = 'dm-search';
        panel.innerHTML = dmSearchView();
        mount.append(panel);

        const input = panel.querySelector('#dmSearchInput');
        const list = panel.querySelector('#dmSearchList');

        const paintList = () => {
            const q = input.value.trim().toLowerCase();
            const me = state.raw.me?.username;
            const options = state.toShell().people
                .filter((p) => p.username && p.username !== me)
                .filter((p) => !q
                    || p.username.toLowerCase().includes(q)
                    || (p.displayName ?? '').toLowerCase().includes(q))
                .slice(0, 12);
            list.innerHTML = dmSearchResults(options);

            list.querySelectorAll('[data-dm-person]').forEach((row) => {
                row.addEventListener('click', async () => {
                    panel.remove();
                    try {
                        const { thread } = await api.request('POST', '/api/dm/threads', {
                            body: { userId: row.dataset.dmPerson },
                        });
                        const { threads = [] } = await api.request('GET', '/api/dm/threads');
                        state.setDmThreads(threads);
                        openDm(thread.id);
                    } catch { /* the rail is unchanged; nothing was promised */ }
                });
            });
        };

        input.addEventListener('input', paintList);
        panel.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') panel.remove();
        });
        paintList();
        input.focus();
    }

    /** Add someone to the private room being viewed. Members only; the server re-checks. */
    async function toggleMemberPicker() {
        const existing = $('#memberPicker', mount);
        if (existing) { existing.remove(); return; }
        const roomId = state.toShell().room.id;
        if (!roomId) return;

        let already = new Set();
        try {
            const { members = [] } = await api.request('GET', `/api/channels/${encodeURIComponent(roomId)}/members`);
            already = new Set(members.map((m) => m.id));
        } catch { return; /* not a member after all; the server said so */ }

        const panel = document.createElement('div');
        panel.id = 'memberPicker';
        panel.className = 'dm-search member-picker';
        panel.innerHTML = dmSearchView();
        mount.append(panel);
        panel.querySelector('.dm-search-title').textContent = 'Add people';

        const input = panel.querySelector('#dmSearchInput');
        const list = panel.querySelector('#dmSearchList');
        const paintList = () => {
            const q = input.value.trim().toLowerCase();
            const options = state.toShell().people
                .filter((p) => p.username && !already.has(p.id))
                .filter((p) => !q
                    || p.username.toLowerCase().includes(q)
                    || (p.displayName ?? '').toLowerCase().includes(q))
                .slice(0, 12);
            list.innerHTML = dmSearchResults(options);
            list.querySelectorAll('[data-dm-person]').forEach((row) => {
                row.addEventListener('click', async () => {
                    try {
                        await api.request('POST', `/api/channels/${encodeURIComponent(roomId)}/members`, {
                            body: { userId: row.dataset.dmPerson },
                        });
                        already.add(row.dataset.dmPerson);
                        paintList();
                    } catch { /* the server refused; the row simply stays */ }
                });
            });
        };
        input.addEventListener('input', paintList);
        panel.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') panel.remove();
        });
        paintList();
        input.focus();
    }

    /* ── incoming calls ──────────────────────────────────────────────────── */

    function showRing({ threadId, from }) {
        ringModal?.close();
        ringModal = createModal({
            className: 'ring-modal',
            label: 'Incoming call',
            onClose: () => { ringModal = null; },
        });
        const name = from?.displayName || from?.username || 'Someone';
        ringModal.open({
            content: `
              <div class="ring-card">
                <p class="ring-name">${esc(name)}</p>
                <p class="ring-sub">is calling you privately</p>
                <div class="ring-actions">
                  <button type="button" class="btn primary" data-ring-accept>Accept</button>
                  <button type="button" class="btn" data-ring-decline>Decline</button>
                </div>
              </div>`,
        });
        ringModal.element.addEventListener('click', (event) => {
            if (event.target.closest('[data-ring-accept]')) {
                activeCallThreadId = threadId;
                link.send('dm:accept', { threadId });
                if (state.raw.dms.some((t) => t.id === threadId)) openDm(threadId);
                ringModal?.close();
            } else if (event.target.closest('[data-ring-decline]')) {
                link.send('dm:decline', { threadId });
                ringModal?.close();
            }
        });
    }

    /* ── the desktop share picker ────────────────────────────────────────── */

    // The main process holds a pending capture request while this modal is open; every
    // exit path MUST answer it, or the request only dies by its own timeout.
    platform.share.onPick(({ nonce, sources }) => {
        let answered = false;
        const modal = createModal({
            className: 'share-modal',
            label: 'Share your screen',
            onClose: () => {
                if (!answered) { answered = true; platform.share.answer(nonce, {}); }
            },
        });
        modal.open({ content: sharePickerView({ sources }) });

        modal.element.addEventListener('click', (event) => {
            const source = event.target.closest('[data-share-source]');
            if (source) {
                answered = true;
                platform.share.answer(nonce, {
                    id: source.dataset.shareSource,
                    audio: modal.element.querySelector('#shareAudio')?.checked ?? true,
                });
                modal.close();
                return;
            }
            if (event.target.closest('[data-share-cancel]')) modal.close();
        });
    });

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
        const body = input?.value.trim() ?? '';
        const attachment = pendingAttachment
            ? { id: pendingAttachment.id, mime: pendingAttachment.mime,
                bytes: pendingAttachment.bytes, name: pendingAttachment.name }
            : null;
        if (!body && !attachment) return;
        mention = null;
        paintMentionPop();
        msgNoise.record(Date.now());

        // Cleared immediately. Waiting for the server to acknowledge before clearing means
        // that on a slow link people retype, or send twice.
        input.value = '';
        input.style.height = 'auto';
        pendingAttachment = null;
        paintAttachStrip();
        closeEmojiPop();
        if (state.raw.activeDmId) {
            link.send('dm:send', { threadId: state.raw.activeDmId, body, ...(attachment ? { attachment } : {}) });
        } else if (!(state.raw.viewChannelId ?? state.raw.currentChannelId)) {
            return;   // standing nowhere, viewing nothing: there is no "here" to message
        } else {
            link.send('text-chat:send', {
                channelId: state.raw.viewChannelId ?? state.raw.currentChannelId,
                body,
                ...(attachment ? { attachment } : {}),
            });
        }
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
        link.onState = (conn) => {
            state.setConnection(conn);
            // An administrator ended this session — kicked, banned, or wiped the server.
            // Staying in a dead room with a spinner would be dishonest; walk back to the
            // sign-in screen carrying the reason.
            const adminEnd = ['password_reset', 'access_revoked', 'server_wiped', 'unauthenticated'];
            if (conn?.state === 'failed' && adminEnd.includes(conn?.failure?.code)) {
                signedOutBy(conn.failure);
            }
        };
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
            clearInterval(syncTimer);
            clearInterval(statsTimer);
            voice.stop();
            background?.destroy();
            link.onEvent = () => {};
            link.onState = () => {};
        },
    };
}
