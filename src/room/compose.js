// Sending a message, from any composer: a channel's, a direct message's, a bubble's.
//
// One module because the three are one thing to the person typing. They used to be two:
// the channel composer had its own picture handling, and the bubble card a second copy that
// had drifted — it took no pasted pictures at all, and sent a chosen one the instant it was
// picked, with no chance to add words or think better of it. The server has one rule for
// what a message may carry (core/media/attachment.js, shared by text-chat, dm and bubbles);
// this is the client's half of keeping it one.
//
//   outgoingMessage()      what goes on the wire, for every kind of place     — pure
//   pastedImage()          the picture a paste carries, if it should be one   — pure
//   attachmentClaim()      what a message says about an upload                — pure
//   createAttachmentSlot() a composer's picture: chosen or pasted, uploaded, held until sent

/** What the server's uploads module will take. Anything else would only come back refused. */
export const ATTACHABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** How long an upload failure stays on screen before the slot empties itself. */
export const ATTACH_ERROR_MS = 4_000;

/**
 * The frame that sends a message, or null when there is nothing to send or nowhere to send it.
 *
 * @param {{ kind: 'channel'|'dm'|'bubble', id: string|null }} to
 * @param {{ body?: string, attachment?: object|null }} message
 */
export function outgoingMessage(to, { body = '', attachment = null } = {}) {
    const text = String(body ?? '').trim();
    if (!to?.id || (!text && !attachment)) return null;
    // A picture alone is a whole message, as the server agrees; only nothing at all is nothing.
    const carried = attachment ? { attachment } : {};
    switch (to.kind) {
        case 'channel': return { type: 'text-chat:send', payload: { channelId: to.id, body: text, ...carried } };
        case 'dm': return { type: 'dm:send', payload: { threadId: to.id, body: text, ...carried } };
        case 'bubble': return { type: 'bubbles:send', payload: { bubbleId: to.id, body: text, ...carried } };
        default: return null;
    }
}

/**
 * The picture a paste should attach, or null to let the paste be ordinary typing.
 *
 * Only when the clipboard holds an image the server accepts and NO text: pasting a paragraph
 * that arrives with a rendered picture of itself (as copying from a web page or a document
 * often does) must still paste the paragraph.
 */
export function pastedImage(clipboardData) {
    if (!clipboardData) return null;
    if (clipboardData.getData?.('text/plain')) return null;
    return [...(clipboardData.files ?? [])].find((file) => ATTACHABLE.includes(file?.type)) ?? null;
}

/**
 * What a message claims about an upload: its id, type, size and a display name. Never the
 * URL — the server derives that from the id, so a message cannot point anywhere else.
 */
export function attachmentClaim(stored, name) {
    return {
        id: stored.id,
        mime: stored.mime,
        bytes: stored.bytes,
        name: String(name || 'image').slice(0, 80),
    };
}

const EMPTY = Object.freeze({ status: 'empty' });

/**
 * A composer's picture, from the moment it is chosen or pasted until the message that
 * carries it is sent.
 *
 * The upload starts at once, so sending is instant; the picture waits on the composer as a
 * chip, and goes with the next message, words or none. The state is plain data for a pure
 * view to draw (views/attach.js):
 *
 *   { status: 'empty' }
 *   { status: 'uploading', name }
 *   { status: 'ready', name, url }
 *   { status: 'error', name, error }   — empties itself after ATTACH_ERROR_MS
 *
 * @param {object}   deps
 * @param {(file: File) => Promise<object>} deps.upload   the uploads endpoint (api.uploadFile)
 * @param {(state: object) => void} [deps.onChange]       repaint whatever shows the chip
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]  injected for tests
 */
export function createAttachmentSlot({ upload, onChange = () => {}, schedule = (fn, ms) => setTimeout(fn, ms) }) {
    let state = EMPTY;
    let claim = null;
    let input = null;
    // Which attach() is current. A picture cleared, sent or replaced while still uploading
    // must not reappear when its upload finishes.
    let generation = 0;

    const set = (next) => { state = next; onChange(state); };

    async function attach(file) {
        if (!file) return;
        const mine = ++generation;
        const name = String(file.name || 'image').slice(0, 80);
        claim = null;
        set({ status: 'uploading', name });
        try {
            const stored = await upload(file);
            if (mine !== generation) return;
            claim = attachmentClaim(stored, name);
            set({ status: 'ready', name, url: stored.url });
        } catch (err) {
            if (mine !== generation) return;
            set({ status: 'error', name, error: err?.message || 'The picture could not be uploaded.' });
            schedule(() => { if (mine === generation && state.status === 'error') set(EMPTY); }, ATTACH_ERROR_MS);
        }
    }

    return {
        attach,

        /** The system's own picker. One hidden input per composer, made on first use. */
        pick() {
            if (!input) {
                input = document.createElement('input');
                input.type = 'file';
                input.accept = ATTACHABLE.join(',');
                input.addEventListener('change', () => {
                    const file = input.files?.[0];
                    input.value = '';
                    attach(file);
                });
            }
            input.click();
        },

        /** For a composer's paste event. True when the paste was a picture and was taken. */
        paste(event) {
            const file = pastedImage(event?.clipboardData);
            if (!file) return false;
            event.preventDefault();
            attach(file);
            return true;
        },

        /** Whether a picture is uploaded and waiting to be sent. */
        get ready() { return state.status === 'ready'; },

        /** Hand the waiting picture to the message being sent, and empty the slot. */
        take() {
            if (state.status !== 'ready') return null;
            const taken = claim;
            claim = null;
            generation += 1;
            set(EMPTY);
            return taken;
        },

        /** Discard whatever is here, uploading or not. */
        clear() {
            generation += 1;
            claim = null;
            if (state !== EMPTY) set(EMPTY);
        },

        get state() { return state; },
    };
}
