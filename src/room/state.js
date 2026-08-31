// What the room knows.
//
// Two different things get conflated constantly in chat clients, so they are kept apart
// here from the start:
//
//   USERS are everyone with an account on this server. They exist whether or not anyone is
//         connected, and they come from the HTTP API.
//   PEERS are the connections that exist right now. One person on two machines is two
//         peers, and someone who closes their laptop stops being a peer while remaining a
//         user. They come from the WebSocket.
//
// Presence is the overlay: a user with at least one peer is here, and which room they are
// in is a property of the peer, not of the user. Modelling peers as "users with a flag"
// works right up until somebody signs in twice, and then it produces ghosts that never
// leave — which is exactly the bug the previous client had.
//
// Everything here is synchronous and pure-ish: apply an event, get new state. Nothing in
// this file fetches, renders or schedules.

import { toTimelineItems } from './messages.js';

/** Producer slots, matching the server's own names. */
const SLOT_SCREEN = 'screen';
const SLOT_CAMERA = 'webcam';   // the wire name — 'camera' here meant the icon never lit

export function createRoomState({ me = null, server = {} } = {}) {
    const listeners = new Set();

    const state = {
        me,                       // the signed-in user
        server,                   // { name, memberCount }
        channels: [],             // from GET /api/channels
        users: new Map(),         // userId -> account
        peers: new Map(),         // cid -> live connection
        currentChannelId: null,
        // What the middle column SHOWS. Null means "follow the voice room" — the
        // default, and what joining a room resets to. A text channel is only ever
        // viewed; standing stays where it is.
        viewChannelId: null,
        // channelId -> { unread, mentions } for text-capable rooms, from the server's
        // read markers plus live message frames.
        unreads: new Map(),
        // Direct messages: the rail. Threads come from GET /api/dm/threads; opening one
        // takes over the middle column the way viewing a text channel does.
        dms: [],
        activeDmId: null,
        dmMessages: new Map(),    // threadId -> [records]
        selfCid: null,
        messages: new Map(),      // channelId -> [items]
        typing: new Map(),        // channelId -> Map(username -> expiresAt)
        connection: { state: 'connecting' },
    };

    const emit = () => { for (const fn of listeners) fn(); };

    /** A peer's producers, as the flags the views actually ask about. */
    function producing(peer) {
        const slots = new Set((peer?.producers ?? []).filter((p) => !p.paused).map((p) => p.slot));
        return { sharing: slots.has(SLOT_SCREEN), camera: slots.has(SLOT_CAMERA) };
    }

    /** Everyone with an account, with live state layered on top. */
    function people() {
        const byUser = new Map();
        for (const peer of state.peers.values()) {
            // If somebody is connected twice, the room they are visibly in is the one their
            // most recent connection is in. Picking arbitrarily makes them flicker.
            const entry = byUser.get(peer.userId) ?? { peer: null, cids: [] };
            entry.peer = peer;
            entry.cids.push(peer.cid);
            byUser.set(peer.userId, entry);
        }

        return [...state.users.values()].map((user) => {
            const { peer = null, cids = [] } = byUser.get(user.id) ?? {};
            const channel = peer ? state.channels.find((c) => c.id === peer.channelId) : null;
            return {
                ...user,
                presence: peer ? (channel?.kind === 'afk' ? 'away' : 'live') : 'offline',
                roomId: peer?.channelId ?? null,
                cid: peer?.cid ?? null,
                // Every connection this person has, not just the one being displayed.
                // Audio levels arrive per PEER, so anything asking "is this person talking"
                // has to consider all of them — otherwise somebody signed in twice is
                // silent on screen while audibly speaking.
                cids,
                muted: Boolean(peer?.muted),
                // Any connection carrying it is enough: the mute is on the account, so a
                // frame that has only reached one of their sockets still tells the truth.
                forceMuted: (byUser.get(user.id)?.cids ?? []).some(
                    (cid) => state.peers.get(cid)?.forceMuted),
                away: channel?.kind === 'afk',
                ...producing(peer),
            };
        }).sort((a, b) => (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username));
    }

    /**
     * Occupants of one channel, one row per PERSON.
     *
     * Deduplicated by user, for the same reason the member list is: somebody signed in on
     * two machines is in the room once, not twice. Mapping peers straight to rows shows
     * them twice, which reads as a bug to everyone who sees it — and it is the one thing a
     * peer-shaped list gets wrong that a user-shaped one does not.
     */
    function occupantsOf(channelId) {
        const all = people();
        const seen = new Set();
        const here = [];

        for (const peer of state.peers.values()) {
            if (peer.channelId !== channelId || seen.has(peer.userId)) continue;
            seen.add(peer.userId);
            here.push(all.find((u) => u.id === peer.userId) ?? {
                // A peer whose account we have not loaded yet. Showing the username we do
                // have beats showing nothing and beats waiting.
                id: peer.userId, username: peer.username, displayName: peer.displayName, presence: 'live',
            });
        }
        return here;
    }

    const currentChannel = () => state.channels.find((c) => c.id === state.currentChannelId) ?? null;
    const viewedId = () => state.viewChannelId ?? state.currentChannelId;
    const viewedChannel = () => state.channels.find((c) => c.id === viewedId()) ?? null;

    function liveTyping(key = viewedId()) {
        const now = Date.now();
        const forChannel = state.typing.get(key);
        if (!forChannel) return [];
        for (const [name, expires] of forChannel) if (expires <= now) forChannel.delete(name);
        return [...forChannel.keys()].filter((n) => n !== state.me?.username);
    }

    return {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

        get raw() { return state; },
        get currentChannel() { return currentChannel(); },
        get people() { return people(); },

        setChannels(channels) {
            state.channels = channels ?? [];
            emit();
        },

        setUsers(users) {
            state.users = new Map((users ?? []).map((u) => [u.id, u]));
            emit();
        },

        setConnection(connection) {
            state.connection = connection;
            emit();
        },

        /**
         * Apply a frame from the server.
         *
         * Unknown types are ignored rather than thrown on: a newer server may send events
         * this build has never heard of, and refusing to run because of one is worse than
         * quietly not showing it.
         */
        apply(msg) {
            switch (msg.type) {
                case 'joined':
                case 'moved': {
                    const target = msg.channel?.id ?? null;

                    // 'joined' now carries the WHOLE roster — every room, and the people
                    // standing nowhere — so it replaces everything. Anything held from
                    // before the (re)connection is exactly the stale state that made
                    // departed peers linger. 'moved' still scopes to the room entered.
                    if (msg.type === 'joined') {
                        state.peers.clear();
                    } else {
                        for (const [cid, peer] of state.peers) {
                            if (peer.channelId === target) state.peers.delete(cid);
                        }
                    }
                    for (const peer of msg.peers ?? []) state.peers.set(peer.cid, peer);

                    // Our own peer needs different handling per frame, and getting this
                    // wrong is invisible until the counts are read: `joined` carries `self`,
                    // but `moved` does not — the server sends the new room's roster with us
                    // excluded from it. Without moving our own record here we stay listed in
                    // the room we just left, so the old room keeps our count and the new one
                    // never gains it.
                    const self = msg.self ?? state.peers.get(state.selfCid);
                    if (self) {
                        self.channelId = target;
                        state.selfCid = self.cid;
                        state.peers.set(self.cid, self);
                    }

                    state.currentChannelId = target;
                    // Joining a room is also choosing to look at it. Arriving NOWHERE
                    // views nothing until something is picked.
                    state.viewChannelId = null;
                    break;
                }

                case 'left': {
                    // Out of the room, still on the server: presence survives, the view
                    // stays on whatever was being read (or nothing, honestly shown).
                    const self = state.peers.get(state.selfCid);
                    if (self) self.channelId = null;
                    state.currentChannelId = null;
                    break;
                }

                case 'channels':
                    // An admin created, renamed or deleted a room — everyone's sidebar
                    // follows at once rather than on their next sign-in.
                    state.channels = msg.channels ?? [];
                    break;

                case 'peer_joined':
                    if (msg.peer) state.peers.set(msg.peer.cid, msg.peer);
                    break;

                case 'peer_left':
                    state.peers.delete(msg.cid);
                    break;

                case 'peer_mute_changed': {
                    const peer = state.peers.get(msg.cid);
                    if (peer) Object.assign(peer, { muted: msg.muted, deafened: msg.deafened });
                    break;
                }

                case 'muteChanged':
                    if (state.selfCid) {
                        const self = state.peers.get(state.selfCid);
                        if (self) Object.assign(self, { muted: msg.muted, deafened: msg.deafened });
                    }
                    break;

                // Per USER, not per connection: a server mute is applied to the account,
                // and somebody signed in twice must not appear muted on one row's worth of
                // their connections and free on the other.
                case 'peer_force_muted':
                    for (const peer of state.peers.values()) {
                        if (peer.userId !== msg.userId) continue;
                        peer.forceMuted = msg.forceMuted === true;
                        peer.forceMutedUntil = msg.forceMuted ? msg.until ?? null : null;
                    }
                    break;

                case 'producer_new': {
                    const peer = state.peers.get(msg.cid);
                    if (peer) {
                        peer.producers = [...(peer.producers ?? []).filter((p) => p.slot !== msg.slot),
                            { slot: msg.slot, id: msg.producerId ?? msg.id, kind: msg.kind, paused: false }];
                    }
                    break;
                }

                case 'producer_closed': {
                    const peer = state.peers.get(msg.cid);
                    if (peer) peer.producers = (peer.producers ?? []).filter((p) => p.slot !== msg.slot);
                    break;
                }

                case 'producer_paused': {
                    const peer = state.peers.get(msg.cid);
                    const producer = (peer?.producers ?? []).find((p) => p.slot === msg.slot);
                    if (producer) producer.paused = msg.paused === true;
                    break;
                }

                default:
                    return false;
            }
            emit();
            return true;
        },

        /** A message that has arrived, or one of ours being echoed back. */
        addMessage(channelId, item) {
            const list = state.messages.get(channelId) ?? [];
            if (item.id && list.some((m) => m.id === item.id)) return false;
            state.messages.set(channelId, [...list, item]);
            // Their message IS the end of their typing; waiting out the expiry would
            // show "X is typing…" under the message X just sent.
            state.typing.get(channelId)?.delete(item.authorName);
            emit();
            return true;
        },

        /**
         * One reaction delta, applied to wherever that message is being shown. count is
         * the server's total — the one number every client converges on regardless of
         * the order deltas arrive in.
         */
        applyReaction({ channelId, messageId, emoji, count, on, username }) {
            const list = state.messages.get(channelId);
            if (!list) return;
            const at = list.findIndex((m) => m.id === messageId);
            if (at < 0) return;
            const record = list[at];
            const rest = (record.reactions ?? []).filter((r) => r.emoji !== emoji);
            const prior = (record.reactions ?? []).find((r) => r.emoji === emoji);
            const mine = username === state.me?.username ? on : (prior?.mine ?? false);
            const next = count > 0 ? [...rest, { emoji, count, mine }] : rest;
            // Keep first-seen order: replace in place rather than re-sorting.
            const reactions = count > 0 && prior
                ? (record.reactions ?? []).map((r) => (r.emoji === emoji ? { emoji, count, mine } : r))
                : next;
            const updated = [...list];
            updated[at] = { ...record, reactions };
            state.messages.set(channelId, updated);
            emit();
        },

        /** A fetched link preview joining its message; repaints via the normal emit. */
        setMessagePreview(channelId, messageId, preview) {
            const list = state.messages.get(channelId);
            if (!list) return;
            const at = list.findIndex((m) => m.id === messageId);
            if (at < 0) return;
            const updated = [...list];
            updated[at] = { ...updated[at], preview };
            state.messages.set(channelId, updated);
            emit();
        },

        setMessages(channelId, items) {
            state.messages.set(channelId, items ?? []);
            emit();
        },

        /** An older page joining the front of the timeline. Duplicates lose to first sighting. */
        prependMessages(channelId, older = []) {
            const list = state.messages.get(channelId) ?? [];
            const seen = new Set(list.map((m) => m.id));
            const fresh = older.filter((m) => !m.id || !seen.has(m.id));
            if (!fresh.length) return false;
            state.messages.set(channelId, [...fresh, ...list]);
            emit();
            return true;
        },

        /**
         * Look at a channel without going anywhere.
         *
         * Viewing the room you are standing in clears the override, so a later move
         * carries the view with it again.
         */
        setView(channelId) {
            state.viewChannelId = channelId === state.currentChannelId ? null : channelId;
            emit();
        },

        /** The server's account-wide unread state, fetched once per connection. */
        setReads(channels = []) {
            state.unreads = new Map(channels.map((c) => [c.channelId, {
                unread: c.unread ?? 0,
                mentions: c.mentions ?? 0,
            }]));
            emit();
        },

        /** A message arrived for a channel nobody here is looking at. */
        bumpUnread(channelId, { mention = false } = {}) {
            const entry = state.unreads.get(channelId) ?? { unread: 0, mentions: 0 };
            entry.unread += 1;
            if (mention) entry.mentions += 1;
            state.unreads.set(channelId, entry);
            emit();
        },

        /**
         * The heartbeat's room snapshot: replace each named peer's producer list with
         * the server's version. Missing frames poisoned the old bookkeeping exactly
         * once too often; this is the antidote arriving every 25 seconds.
         */
        applyProducersTruth(entries = []) {
            let changed = false;
            for (const entry of entries) {
                const peer = state.peers.get(entry.cid);
                if (!peer) continue;
                const now = JSON.stringify(entry.producers ?? []);
                if (JSON.stringify(peer.producers ?? []) !== now) {
                    peer.producers = entry.producers ?? [];
                    changed = true;
                }
            }
            if (changed) emit();
        },

        /**
         * The server announces producers to everyone EXCEPT their owner, so your own
         * screen/camera icon would never light in the sidebar. The client knows the
         * truth firsthand and records it here.
         */
        markOwnProducer(cid, slot, on) {
            const peer = state.peers.get(cid);
            if (!peer) return;
            const rest = (peer.producers ?? []).filter((p) => p.slot !== slot);
            peer.producers = on ? [...rest, { slot }] : rest;
            emit();
        },

        clearUnread(channelId) {
            const entry = state.unreads.get(channelId);
            if (!entry || (!entry.unread && !entry.mentions)) return;
            state.unreads.set(channelId, { unread: 0, mentions: 0 });
            emit();
        },

        /* ── direct messages ─────────────────────────────────────────────── */

        setDmThreads(threads = []) {
            state.dms = threads;
            emit();
        },

        openDm(threadId) {
            state.activeDmId = threadId;
            emit();
        },

        closeDm() {
            if (!state.activeDmId) return;
            state.activeDmId = null;
            emit();
        },

        setDmMessages(threadId, items = []) {
            state.dmMessages.set(threadId, items);
            emit();
        },

        addDmMessage(threadId, record) {
            const list = state.dmMessages.get(threadId) ?? [];
            if (record.id && list.some((m) => m.id === record.id)) return false;
            state.dmMessages.set(threadId, [...list, record]);
            // The rail orders by activity; a fresh word moves the thread up.
            const thread = state.dms.find((t) => t.id === threadId);
            if (thread) {
                thread.lastMessageAt = record.createdAt;
                state.dms = [...state.dms].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
            }
            emit();
            return true;
        },

        bumpDmUnread(threadId) {
            const thread = state.dms.find((t) => t.id === threadId);
            if (thread) { thread.unread = (thread.unread ?? 0) + 1; emit(); }
        },

        clearDmUnread(threadId) {
            const thread = state.dms.find((t) => t.id === threadId);
            if (thread && thread.unread) { thread.unread = 0; emit(); }
        },

        noteTyping(channelId, username, forMs = 5000) {
            const forChannel = state.typing.get(channelId) ?? new Map();
            forChannel.set(username, Date.now() + forMs);
            state.typing.set(channelId, forChannel);
            emit();
        },

        /** The shape the views want, derived rather than stored. */
        toShell() {
            const channel = currentChannel();
            const viewed = viewedChannel();
            const roster = people();
            const self = roster.find((p) => p.id === state.me?.id);
            const activeDm = state.dms.find((t) => t.id === state.activeDmId) ?? null;

            return {
                connection: state.connection,
                server: { name: state.server.name, memberCount: state.users.size },
                dmOpen: Boolean(activeDm),
                dms: state.dms.map((t) => ({
                    id: t.id,
                    username: t.other?.username,
                    displayName: t.other?.displayName || t.other?.username,
                    presence: t.other?.presence,
                    unread: t.unread ?? 0,
                    current: t.id === state.activeDmId,
                })),
                rooms: state.channels.map((c) => ({
                    id: c.id,
                    name: c.name,
                    // The server's kinds are voice | text | both | afk. Only a pure text
                    // channel belongs in the text group; everything else is somewhere you go.
                    kind: c.kind === 'text' ? 'text' : 'voice',
                    allowText: c.allowText !== false,
                    private: Boolean(c.private),
                    member: c.private ? Boolean(c.member) : undefined,
                    // What the reader is LOOKING at is the highlighted row; where they are
                    // STANDING keeps its occupant marker. Usually the same row; while
                    // browsing a text channel they diverge, exactly like Discord.
                    current: c.id === (state.viewChannelId ?? state.currentChannelId),
                    occupied: c.id === state.currentChannelId,
                    unread: state.unreads.get(c.id)?.unread ?? 0,
                    mentions: state.unreads.get(c.id)?.mentions ?? 0,
                    occupants: occupantsOf(c.id),
                })),
                room: activeDm
                    ? {
                        id: activeDm.id,
                        name: activeDm.other?.displayName || activeDm.other?.username || 'Direct message',
                        kind: 'dm',
                        topic: 'Private thread · just the two of you',
                    }
                    : viewed
                        ? {
                            id: viewed.id,
                            name: viewed.name,
                            kind: viewed.kind,
                            topic: viewed.topic ?? '',
                            private: Boolean(viewed.private),
                            member: viewed.private ? Boolean(viewed.member) : undefined,
                        }
                        : {},
                me: {
                    ...state.me,
                    presence: self?.presence ?? 'live',
                    // Standing somewhere the channel list does not contain is standing
                    // in a call room — the one kind of room kept off every list.
                    roomName: channel?.name
                        ?? (state.currentChannelId ? 'Private call' : null),
                    // A room literally called "Away" would otherwise read "Away · Away".
                    status: channel?.kind === 'afk'
                        ? (/away|afk/i.test(channel.name) ? null : 'Away')
                        : 'Weaving',
                    muted: Boolean(self?.muted),
                    deafened: Boolean(state.peers.get(state.selfCid)?.deafened),
                    // Read off the roster row rather than off this connection's peer, so
                    // it is right on a machine that was signed in when the mute landed and
                    // on one that arrived afterwards.
                    forceMuted: Boolean(self?.forceMuted),
                    forceMutedUntil: state.peers.get(state.selfCid)?.forceMutedUntil ?? null,
                },
                // Stored records become timeline items here, so the views never have to
                // know what a database row looks like and day separators are computed once.
                items: toTimelineItems(activeDm
                    ? (state.dmMessages.get(activeDm.id) ?? []).map((m) => ({ ...m, userId: m.authorId }))
                    : state.messages.get(state.viewChannelId ?? state.currentChannelId) ?? [], {
                    users: state.users,
                    me: state.me,
                }),
                typing: activeDm ? liveTyping(activeDm.id) : liveTyping(),
                people: roster,
            };
        },
    };
}
