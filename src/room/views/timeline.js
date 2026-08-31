// The middle column: room header, the message timeline, and the composer.
//
// Everything here is a pure function of state. Nothing fetches, nothing schedules, nothing
// touches the DOM — which is what makes the whole column renderable from fixtures before a
// socket exists, and testable afterwards without a browser.

import { esc } from '../../ui/dom.js';
import { icons } from '../icons.js';
import { avatar, displayName, adminBadge } from './parts.js';

/** Bytes, in the units a person would actually say out loud. */
export function fileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Message text, with mentions marked.
 *
 * Escaping happens FIRST and the mention pass runs over the escaped string. That order is
 * the whole safety argument: escaping cannot introduce an `@`, so the second pass can only
 * ever match text that was already inert. Doing it the other way round would mean building
 * markup and then escaping it, which escapes your own tags and loses the plot.
 *
 * Only names the server resolved are marked. Highlighting any bare `@word` would let
 * anyone fake a mention of anyone, including one of you.
 */
export function messageText(text, mentions = []) {
    let out = esc(text ?? '');

    if (mentions.length) {
        const known = new Set(mentions.map((m) => String(m).toLowerCase()));
        out = out.replace(/@([A-Za-z0-9._-]{1,32})/g, (whole, name) =>
            (known.has(name.toLowerCase())
                ? `<span class="mention">@${esc(name)}</span>`
                : whole));
    }

    // Links become links. This runs on already-escaped text, so `&` inside a URL reads
    // `&amp;` here — correct in the href (HTML parses it back) and correct on screen.
    // target=_blank routes through the desktop shell's window-open policy, which opens
    // the system browser and denies everything else.
    out = out.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        const clean = url.replace(/[.,;:!?]+$/, '');
        const tail = url.slice(clean.length);
        const shown = clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
        return `<a class="msg-link" href="${clean}" target="_blank" rel="noreferrer noopener">${shown}</a>${tail}`;
    });
    return out;
}

const reaction = (r) => `
  <button type="button" class="reaction${r.mine ? ' mine' : ''}"
          data-react="${esc(r.emoji)}"
          aria-pressed="${r.mine ? 'true' : 'false'}"
          aria-label="${esc(r.emoji)}, ${esc(r.count)}${r.mine ? ', including you' : ''}">
    <span aria-hidden="true">${esc(r.emoji)}</span>${esc(r.count)}
  </button>`;

/**
 * The row exists when there are reactions to show OR reacting is possible — the add
 * button is how the FIRST reaction happens, so it cannot hide behind list.length. It
 * stays visually quiet until the message is hovered (CSS), like every messenger.
 */
const reactions = (list = [], canReact = false) => ((list.length || canReact) ? `
  <div class="reactions">
    ${list.map(reaction).join('')}
    ${canReact ? `
    <button type="button" class="reaction add" data-add-reaction
            aria-label="Add a reaction">${icons.emoji}</button>` : ''}
  </div>` : '');

/**
 * A link preview.
 *
 * Every field is fetched by the server from a third-party page, which makes it the least
 * trustworthy string in the whole timeline. It is also never a link here — the preview is
 * a description of a destination, and the message text above it carries the actual link.
 */
const linkPreview = (p) => (p ? `
  <a class="link-preview" href="${esc(p.url ?? '#')}" target="_blank" rel="noreferrer noopener">
    ${p.image ? `<img class="preview-thumb" src="${esc(p.image)}" alt="" loading="lazy">`
        : `<span class="preview-icon">${icons.doc}</span>`}
    <span class="preview-body">
      <span class="preview-site">${esc(p.site ?? '')}</span>
      <span class="preview-title">${esc(p.title ?? '')}</span>
      <span class="preview-desc">${esc(p.description ?? '')}</span>
    </span>
  </a>` : '');

/**
 * A recognised video link: a click-to-play card, never an auto-loaded iframe. The
 * controller swaps in the provider's official embed player on click; until then the
 * message costs the room nothing.
 */
const videoEmbed = (m) => {
    if (!m.embed) return '';
    // Once playing, the iframe is part of the VIEW — a repaint of the list re-renders
    // it rather than silently killing the video mid-watch.
    if (m.embedPlaying) {
        return `
  <div class="video-embed playing">
    <iframe src="${esc(m.embed.embedUrl)}" allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            referrerpolicy="no-referrer" title="Embedded ${esc(m.embed.label)} video"></iframe>
  </div>`;
    }
    return `
  <div class="video-embed" data-embed-play="${esc(m.id)}"
       role="button" tabindex="0" aria-label="Play ${esc(m.embed.label)} video">
    ${m.preview?.image ? `<img class="embed-thumb" src="${esc(m.preview.image)}" alt="" loading="lazy">` : ''}
    <span class="embed-veil"></span>
    <span class="embed-play">${icons.play ?? '▶'}</span>
    <span class="embed-provider">${esc(m.embed.label)}</span>
  </div>`;
};

/**
 * An attachment.
 *
 * The filename shown is the one the uploader chose, which is why it is escaped and why it
 * is never used to decide what the file IS — that comes from the server's own content type.
 */
const attachment = (a) => {
    if (!a) return '';
    if (String(a.mime ?? '').startsWith('image/')) {
        // Uploads are auth-gated, so a bare <img src> would 401: the controller fetches
        // the bytes with the bearer and fills data-auth-src elements with blob URLs.
        return `
  <figure class="attach-image-wrap">
    <img class="attach-image" data-auth-src="${esc(a.url ?? '')}" data-lightbox
         alt="${esc(a.name ?? 'image')}" title="${esc(a.name ?? '')}">
  </figure>`;
    }
    return `
  <div class="attachment">
    <span class="preview-icon">${icons.doc}</span>
    <span class="attach-body">
      <span class="attach-name">${esc(a.name ?? 'file')}</span>
      <span class="attach-meta">${esc((a.mime ?? '').split('/').pop().toUpperCase())} · ${esc(fileSize(a.size ?? a.bytes))}</span>
    </span>
    <button type="button" class="composer-btn" data-download="${esc(a.id ?? '')}"
            aria-label="Download ${esc(a.name ?? 'file')}">${icons.download}</button>
  </div>`;
};

function message(m) {
    const classes = ['msg', m.mentionsMe ? 'mentions-me' : ''].filter(Boolean).join(' ');
    return `
    <li class="${classes}" data-message="${esc(m.id)}">
      ${avatar(m.author, { size: 'lg', presence: false })}
      <div>
        <div class="msg-head">
          <span class="msg-author">${displayName(m.author)}</span>
          ${adminBadge(m.author)}
          <span class="msg-time">${esc(m.at)}</span>
        </div>
        <div class="msg-body">${messageText(m.text, m.mentions)}</div>
        ${videoEmbed(m)}
        ${m.embed ? '' : linkPreview(m.preview)}
        ${attachment(m.attachment)}
        ${reactions(m.reactions, m.canReact)}
      </div>
    </li>`;
}

/**
 * A system event.
 *
 * Rendered in the timeline rather than as a toast, because "X was moved to AFK" is part of
 * what happened in this room and reads as nonsense out of sequence.
 */
const systemEvent = (m) => `
  <li class="msg-system" data-message="${esc(m.id)}">
    ${icons[m.icon] ?? icons.afk}
    <span class="sys-text"><span class="sys-who">${esc(m.who ?? '')}</span> ${esc(m.text)}</span>
    <span class="msg-time">${esc(m.at)}</span>
  </li>`;

const daySeparator = (m) => `<li class="day-sep" role="separator">${esc(m.label)}</li>`;

const RENDERERS = { message, system: systemEvent, day: daySeparator };

/**
 * The messages, and nothing else.
 *
 * Exported so an arriving message replaces only this. Re-rendering the whole column would
 * take the composer with it, and losing a half-typed message because somebody else said
 * something is the kind of bug people never forgive.
 */
export const messageList = (items = []) =>
    items.map((m) => (RENDERERS[m.kind] ?? message)(m)).join('');

/** Who is typing, in the phrasing a person would use. */
export function typingLine(names = []) {
    if (!names.length) return '';
    const list = names.map((n) => esc(n));
    const who = list.length === 1 ? list[0]
        : list.length === 2 ? `${list[0]} and ${list[1]}`
            : list.length === 3 ? `${list[0]}, ${list[1]} and ${list[2]}`
                : `${list[0]}, ${list[1]} and ${list.length - 2} others`;
    const verb = list.length === 1 ? 'is' : 'are';
    return `
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>${who} ${verb} typing…</span>`;
}

/** The wall-clock time an expiry lands at, in whatever the reader's locale calls it. */
const clockOf = (until) => new Date(until)
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * What voice is doing, when that is worth saying.
 *
 * Silent while it works. A status line that reports success on every launch is noise, and
 * noise is what teaches people not to read the place real problems appear.
 */
export function voiceNotice(status = {}) {
    // Ahead of the switch, because it is true regardless of what voice is otherwise doing
    // and it is the only one of these the person cannot act on. Somebody whose microphone
    // has been paused by somebody else is owed the reason before they go looking for a
    // fault in their own hardware.
    if (status.forceMuted) {
        return {
            show: true,
            tone: 'bad',
            text: status.forceMutedUntil
                ? `An administrator muted you until ${clockOf(status.forceMutedUntil)}.`
                : 'An administrator muted you. Only an administrator can lift it.',
        };
    }

    switch (status.state) {
        case 'no-mic':
            return { show: true, tone: 'warn', text: status.message ?? 'Microphone unavailable.' };
        case 'unavailable':
            return { show: true, tone: 'quiet', text: status.message ?? 'Voice is off in this room.' };
        case 'recovering':
            return {
                show: true,
                tone: 'warn',
                text: `Reconnecting voice… (${status.attempt} of ${status.of})`,
            };
        case 'failed':
            return {
                show: true,
                tone: 'bad',
                text: status.message ?? 'Voice could not be re-established.',
            };
        case 'consume-failed':
            return {
                show: true,
                tone: 'warn',
                text: status.message ?? 'Some audio in this room is not arriving — still retrying.',
            };
        case 'blocked':
            return {
                show: true,
                tone: 'warn',
                text: 'Click anywhere to let sound play.',
            };
        default:
            return { show: false };
    }
}

export const voiceNoticeMarkup = (status) => {
    const view = voiceNotice(status);
    if (!view.show) return '';
    return `<div class="voice-notice ${esc(view.tone)}">${esc(view.text)}</div>`;
};

/** The glyph for what kind of place this is. Painted at mount and on every view change. */
export const roomGlyph = (room = {}) => (room.private ? icons.lock
    : room.kind === 'dm' ? icons.chat
        : room.kind === 'text' ? '<span class="room-hash" aria-hidden="true">#</span>'
            : icons.speaker);

/**
 * A room with no messages yet, saying so.
 *
 * Without this a fresh room is an unexplained black void — indistinguishable from a room
 * that failed to load. The one sentence is the difference.
 */
export const emptyState = (room = {}) => (room.id ? `
  <div class="timeline-empty">
    <span class="empty-mark" aria-hidden="true">${icons.weave}</span>
    <p class="empty-title">This is the start of ${esc(room.name ?? 'the room')}</p>
    <p class="empty-sub">Say something, or just be here — the strands move when you do.</p>
  </div>` : `
  <div class="timeline-empty">
    <span class="empty-mark" aria-hidden="true">${icons.weave}</span>
    <p class="empty-title">You're not in a room</p>
    <p class="empty-sub">Pick one on the left to talk — or just read; every text channel is open to you.</p>
  </div>`);

export function timeline({ room = {}, items = [], typing = [], voice = {} } = {}) {
    return `
    <main class="room">
      <canvas class="room-bg" id="roomBg" aria-hidden="true"></canvas>

      <header class="room-head" id="roomHead">
        <button type="button" class="icon-btn drawer-toggle" data-open-drawer
                title="Rooms" aria-label="Show the room list">${icons.menu}</button>
        <span id="roomIcon" class="room-icon">${roomGlyph(room)}</span>
        <h1>${esc(room.name ?? 'Room')}</h1>
        <span class="room-topic" id="roomTopic" ${room.topic ? '' : 'hidden'}>${esc(room.topic ?? '')}</span>
        <span class="room-head-spacer"></span>
        <button type="button" class="icon-btn" id="dmCallBtn" data-dm-call hidden
                title="Start a private call" aria-label="Start a private call">${icons.phone}</button>
        <button type="button" class="icon-btn danger-btn" id="dmHangupBtn" data-dm-hangup hidden
                title="End the call" aria-label="End the call">${icons.phoneOff}</button>
        <button type="button" class="icon-btn" id="addMemberBtn" data-add-member
                ${room.private && room.member ? '' : 'hidden'}
                title="Add people to this room" aria-label="Add people to this private room">${icons.plus}</button>
      </header>

      <div id="stageSlot"></div>

      <div class="timeline" id="timeline" tabindex="0" aria-label="Messages">
        <div class="timeline-inner">
          <ol class="msg-list" id="msgList">${messageList(items)}</ol>
          ${items.length ? '' : emptyState(room)}
          <div class="typing" aria-live="polite">${typingLine(typing)}</div>
        </div>
      </div>

      <div class="voice-notice-slot" id="voiceNotice">${voiceNoticeMarkup(voice)}</div>

      <div class="composer-wrap">
        <form class="composer" id="composer">
          <button type="button" class="composer-btn" data-attach
                  title="Attach a file" aria-label="Attach a file">${icons.plus}</button>
          <textarea class="composer-input" id="composerInput" rows="1"
                    placeholder="Message ${esc(room.name ?? 'the room')}…"
                    aria-label="Write a message"></textarea>
          <button type="button" class="composer-btn" data-emoji
                  title="Emoji" aria-label="Insert an emoji">${icons.emoji}</button>
          <button type="submit" class="composer-btn send" aria-label="Send">${icons.send}</button>
        </form>
      </div>
    </main>`;
}
