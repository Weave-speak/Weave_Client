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
const SLOT_CAMERA = 'camera';

export function createRoomState({ me = null, server = {} } = {}) {
    const listeners = new Set();

    const state = {
        me,                       // the signed-in user
        server,                   // { name, memberCount }
        channels: [],             // from GET /api/channels
        users: new Map(),         // userId -> account
        peers: new Map(),         // cid -> live connection
        currentChannelId: null,
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

    function liveTyping() {
        const now = Date.now();
        const forChannel = state.typing.get(state.currentChannelId);
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
                    const target = msg.channel?.id ?? state.currentChannelId;

                    // A snapshot REPLACES the roster for the room being entered rather than
                    // merging into it. Merging is how a peer that left while we were away
                    // lingers for ever: nothing ever tells us about a departure we missed.
                    for (const [cid, peer] of state.peers) {
                        if (peer.channelId === target) state.peers.delete(cid);
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
                    break;
                }

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
            emit();
            return true;
        },

        setMessages(channelId, items) {
            state.messages.set(channelId, items ?? []);
            emit();
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
            const roster = people();
            const self = roster.find((p) => p.id === state.me?.id);

            return {
                connection: state.connection,
                server: { name: state.server.name, memberCount: state.users.size },
                dms: [],
                rooms: state.channels.map((c) => ({
                    id: c.id,
                    name: c.name,
                    // The server's kinds are voice | text | both | afk. Only a pure text
                    // channel belongs in the text group; everything else is somewhere you go.
                    kind: c.kind === 'text' ? 'text' : 'voice',
                    current: c.id === state.currentChannelId,
                    occupants: occupantsOf(c.id),
                })),
                room: channel
                    ? { id: channel.id, name: channel.name, kind: channel.kind }
                    : {},
                me: {
                    ...state.me,
                    presence: self?.presence ?? 'live',
                    roomName: channel?.name ?? null,
                    // A room literally called "Away" would otherwise read "Away · Away".
                    status: channel?.kind === 'afk'
                        ? (/away|afk/i.test(channel.name) ? null : 'Away')
                        : 'Weaving',
                    muted: Boolean(self?.muted),
                    deafened: Boolean(state.peers.get(state.selfCid)?.deafened),
                },
                // Stored records become timeline items here, so the views never have to
                // know what a database row looks like and day separators are computed once.
                items: toTimelineItems(state.messages.get(state.currentChannelId) ?? [], {
                    users: state.users,
                    me: state.me,
                }),
                typing: liveTyping(),
                people: roster,
            };
        },
    };
}
