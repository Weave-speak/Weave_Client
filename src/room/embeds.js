// Links inside messages: finding them, and recognising the few whose player is worth
// inviting into the chat.
//
// Pure functions, because URL parsing is exactly the kind of logic that grows dark
// corners — every provider has three URL shapes and someone always pastes the fourth.
// Embeds are click-to-play by design: an iframe per pasted link would hand strangers'
// scripts a seat in the room for a message nobody asked to watch.

/** Every http(s) URL in a message body, in order, deduplicated. */
export function extractUrls(text) {
    const found = String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
    return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))];
}

/**
 * The providers whose players may be embedded, each mapped to the iframe URL of its
 * OFFICIAL embed surface. Anything unrecognised gets a preview card at most.
 */
export function parseProviderUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    const host = url.hostname.replace(/^www\.|^m\./, '');

    if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
        const id = host === 'youtu.be'
            ? url.pathname.slice(1).split('/')[0]
            : url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/embed/')
                ? url.pathname.split('/')[2]
                : url.searchParams.get('v');
        if (!/^[\w-]{6,20}$/.test(id ?? '')) return null;
        const start = Number(url.searchParams.get('t')?.replace(/s$/, '')) || 0;
        return {
            provider: 'youtube',
            label: 'YouTube',
            embedUrl: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
        };
    }

    if (host === 'x.com' || host === 'twitter.com') {
        const m = url.pathname.match(/^\/[A-Za-z0-9_]{1,20}\/status\/(\d{5,25})/);
        if (!m) return null;
        return {
            provider: 'x',
            label: 'X',
            embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&theme=dark&dnt=true`,
        };
    }

    if (host === 'instagram.com') {
        const m = url.pathname.match(/^\/(?:p|reel|tv)\/([\w-]{5,20})/);
        if (!m) return null;
        return {
            provider: 'instagram',
            label: 'Instagram',
            embedUrl: `https://www.instagram.com/p/${m[1]}/embed/`,
        };
    }

    if (host === 'tiktok.com') {
        const m = url.pathname.match(/\/video\/(\d{5,25})/);
        if (!m) return null;
        return {
            provider: 'tiktok',
            label: 'TikTok',
            embedUrl: `https://www.tiktok.com/embed/v2/${m[1]}`,
        };
    }

    return null;
}

/** The first embeddable link in a body, with the URL it came from. */
export function embedFor(text) {
    for (const url of extractUrls(text)) {
        const parsed = parseProviderUrl(url);
        if (parsed) return { ...parsed, url };
    }
    return null;
}
