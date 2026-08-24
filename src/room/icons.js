// The icon set.
//
// Inline SVG strings rather than an icon font or a sprite sheet: there are a couple of
// dozen of them, they inherit `currentColor` for free, and neither an extra network
// request nor a build step earns its place at this size.
//
// Every icon is drawn on a 24x24 grid with a 1.8 stroke so they sit together without
// per-icon adjustment. Size comes from CSS, never from the markup.

const svg = (body, { stroke = 1.8, fill = 'none' } = {}) =>
    `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${stroke}"`
    + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
    /** The mark. A thread passing over and under. */
    weave: svg('<path d="M3 14c2.5 0 2.5-4 5-4s2.5 4 5 4 2.5-4 5-4 2.5 4 3 4"/>', { stroke: 2.2 }),

    speaker: svg('<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    speakerOff: svg('<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9l5 6M21 9l-5 6"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),

    search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    chat: svg('<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>'),
    bell: svg('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    dots: svg('<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),

    mic: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    micOff: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M3 3l18 18"/>'),
    headphones: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/>'),
    power: svg('<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),

    screen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    camera: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>'),
    star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),

    afk: svg('<path d="M4 17h6l-6-6h6"/><path d="M13 13h7l-7-7h7"/>'),
    doc: svg('<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/>'),
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>'),
    download: svg('<path d="M12 4v11"/><path d="M8 12l4 4 4-4"/><path d="M5 20h14"/>'),

    emoji: svg('<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>'),
    send: svg('<path d="M4 12l16-8-6 16-2.5-6.5z"/>'),

    gear: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
};
