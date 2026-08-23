// Placeholder state for the shell harness.
//
// Development only — nothing imports this from src/. It exists so the layout can be built
// and looked at before a socket exists, and so the awkward cases are always on screen
// rather than being discovered in production: a very long display name, an empty room, a
// room at capacity, a message that mentions you, an attachment, a link preview, a system
// event, and somebody typing.

const person = (username, extra = {}) => ({
    username,
    displayName: extra.displayName ?? username,
    presence: 'online',
    ...extra,
});

export const people = [
    person('kestrel', { displayName: 'Kestrel', isAdmin: true, presence: 'live', roomId: 'great-hall', priority: true }),
    person('vaporwave_dan', { presence: 'live', roomId: 'great-hall', sharing: true }),
    person('ghostbyte', { displayName: 'Ghostbyte', presence: 'live', roomId: 'great-hall', muted: true }),
    person('roan', { displayName: 'Roan', presence: 'live', roomId: 'great-hall', camera: true }),
    person('moth', { displayName: 'Moth', presence: 'live', roomId: 'great-hall' }),
    person('tessellate', { displayName: 'Tessellate', presence: 'away', roomId: 'strung-out', away: true }),
    person('lint', { displayName: 'Lint', presence: 'live', roomId: 'library' }),
    person('bobbin', { displayName: 'Bobbin', presence: 'online' }),
    person('selvedge', { displayName: 'Selvedge', presence: 'dnd', dnd: true }),
    // The name nobody designs for. If the columns survive this they survive real users.
    person('warp', { displayName: 'Warp Weft Winder The Considerably Long', presence: 'offline' }),
    person('heddle', { displayName: 'Heddle', presence: 'offline' }),
    person('nettle', { displayName: 'Nettle', presence: 'offline' }),
];

const inRoom = (id) => people.filter((p) => p.roomId === id);

export const rooms = [
    // Text strands: read, not entered. Their number is unread, not occupancy.
    { id: 'general', kind: 'text', name: 'general' },
    { id: 'patch-notes', kind: 'text', name: 'patch-notes', unread: 2 },
    { id: 'links', kind: 'text', name: 'links' },
    { id: 'strike-team', kind: 'text', name: 'strike-team', private: true, unread: 137 },

    // Voice rooms: entered, not read. Their number is who is in there now.
    { id: 'lobby', name: 'Lobby', occupants: [] },
    { id: 'dungeon', name: 'The Dungeon', occupants: [] },
    { id: 'library', name: 'The Library', occupants: inRoom('library') },
    { id: 'lounge', name: 'The Lounge', occupants: [] },
    { id: 'war-room', name: 'The War Room', occupants: [] },
    { id: 'strung-out', name: 'Strung Out (AFK)', occupants: inRoom('strung-out') },
    { id: 'great-hall', name: 'The Great Hall', current: true, occupants: inRoom('great-hall') },
];

export const items = [
    { kind: 'day', label: 'Yesterday' },
    {
        kind: 'message', id: 'm1', at: '22:14',
        author: people.find((p) => p.username === 'moth'),
        text: 'Anyone up for a run through The Dungeon tomorrow night?',
        reactions: [{ emoji: '🎮', count: 4 }],
    },
    {
        kind: 'message', id: 'm2', at: '22:20',
        author: people.find((p) => p.username === 'roan'),
        text: 'in, as long as we start after 8',
    },
    { kind: 'day', label: 'Today' },
    {
        kind: 'system', id: 's1', at: '19:52', icon: 'afk',
        who: 'Tessellate', text: 'was moved to Strung Out (AFK)',
    },
    {
        kind: 'message', id: 'm3', at: '21:04',
        author: people.find((p) => p.username === 'kestrel'),
        text: 'Putting my screen up — the build is finally green.',
        reactions: [{ emoji: '🎉', count: 6 }, { emoji: '👀', count: 2, mine: true }],
    },
    {
        kind: 'message', id: 'm4', at: '21:05',
        author: people.find((p) => p.username === 'vaporwave_dan'),
        text: 'Finally. Runbook is updated so nobody has to dig through logs again.',
        preview: {
            site: 'docs.example.com',
            title: 'Operations runbook — recovering the SFU',
            description: 'Restart order, what SFU_READY means, and how to tell an OOM from a tunnel drop.',
        },
    },
    {
        kind: 'message', id: 'm5', at: '21:07',
        author: people.find((p) => p.username === 'roan'),
        text: 'memory graph before and after, for the record',
        attachment: { id: 'a1', name: 'sfu-memory-24h.png', mime: 'image/png', size: 1_258_291 },
        reactions: [{ emoji: '📈', count: 4 }],
    },
    {
        kind: 'message', id: 'm6', at: '21:09',
        author: people.find((p) => p.username === 'kestrel'),
        text: '@ghostbyte can you sanity-check that before I pin it?',
        mentions: ['ghostbyte'],
        mentionsMe: true,
    },
    {
        kind: 'message', id: 'm7', at: '21:11',
        author: people.find((p) => p.username === 'ghostbyte'),
        text: 'On it — I am in the room if you would rather talk it through.',
        reactions: [{ emoji: '👍', count: 2 }],
    },
];

export const state = {
    connection: { state: 'live', rttMs: 24, codec: 'Opus', bitrateKbps: 64 },
    server: { name: 'Home Weave', memberCount: people.length },
    dms: [
        { id: 'd1', username: 'tessellate', displayName: 'Tessellate' },
        { id: 'd2', username: 'kestrel', displayName: 'Kestrel', unread: 4 },
        { id: 'd3', username: 'moth', displayName: 'Moth' },
        { id: 'd4', username: 'roan', displayName: 'Roan', unread: 12 },
        { id: 'd5', username: 'lint', displayName: 'Lint', unread: 143 },
    ],
    rooms,
    room: { id: 'great-hall', name: 'The Great Hall', topic: 'Anything goes. Screens up, cameras optional.' },
    me: {
        username: 'ghostbyte',
        displayName: 'Ghostbyte',
        presence: 'live',
        status: 'Weaving',
        roomName: 'The Great Hall',
        muted: true,
    },
    items,
    typing: ['Moth'],
    people,
};
