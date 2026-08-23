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
    if (!mentions.length) return out;

    const known = new Set(mentions.map((m) => String(m).toLowerCase()));
    out = out.replace(/@([A-Za-z0-9._-]{1,32})/g, (whole, name) =>
        (known.has(name.toLowerCase())
            ? `<span class="mention">@${esc(name)}</span>`
            : whole));
    return out;
}

const reaction = (r) => `
  <button type="button" class="reaction${r.mine ? ' mine' : ''}"
          data-react="${esc(r.emoji)}"
          aria-pressed="${r.mine ? 'true' : 'false'}"
          aria-label="${esc(r.emoji)}, ${esc(r.count)}${r.mine ? ', including you' : ''}">
    <span aria-hidden="true">${esc(r.emoji)}</span>${esc(r.count)}
  </button>`;

const reactions = (list = []) => (list.length ? `
  <div class="reactions">
    ${list.map(reaction).join('')}
    <button type="button" class="reaction add" data-add-reaction
            aria-label="Add a reaction">${icons.emoji}</button>
  </div>` : '');

/**
 * A link preview.
 *
 * Every field is fetched by the server from a third-party page, which makes it the least
 * trustworthy string in the whole timeline. It is also never a link here — the preview is
 * a description of a destination, and the message text above it carries the actual link.
 */
const linkPreview = (p) => (p ? `
  <div class="link-preview">
    <span class="preview-icon">${icons.doc}</span>
    <span class="preview-body">
      <span class="preview-site">${esc(p.site ?? '')}</span>
      <span class="preview-title">${esc(p.title ?? '')}</span>
      <span class="preview-desc">${esc(p.description ?? '')}</span>
    </span>
  </div>` : '');

/**
 * An attachment.
 *
 * The filename shown is the one the uploader chose, which is why it is escaped and why it
 * is never used to decide what the file IS — that comes from the server's own content type.
 */
const attachment = (a) => (a ? `
  <div class="attachment">
    <span class="preview-icon">${String(a.mime ?? '').startsWith('image/') ? icons.image : icons.doc}</span>
    <span class="attach-body">
      <span class="attach-name">${esc(a.name ?? 'file')}</span>
      <span class="attach-meta">${esc((a.mime ?? '').split('/').pop().toUpperCase())} · ${esc(fileSize(a.size))}</span>
    </span>
    <button type="button" class="composer-btn" data-download="${esc(a.id ?? '')}"
            aria-label="Download ${esc(a.name ?? 'file')}">${icons.download}</button>
  </div>` : '');

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
        ${linkPreview(m.preview)}
        ${attachment(m.attachment)}
        ${reactions(m.reactions)}
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

export function timeline({ room = {}, items = [], typing = [] } = {}) {
    return `
    <main class="room">
      <canvas class="room-bg" id="roomBg" aria-hidden="true"></canvas>

      <header class="room-head">
        ${room.private ? icons.lock : icons.speaker}
        <h1>${esc(room.name ?? 'Room')}</h1>
        ${room.topic ? `<span class="room-topic">${esc(room.topic)}</span>` : ''}
        <span class="room-head-spacer"></span>
        <button type="button" class="icon-btn" data-toggle-members
                title="Members" aria-label="Show or hide the member list">${icons.dots}</button>
      </header>

      <div class="timeline" id="timeline" tabindex="0" aria-label="Messages">
        <div class="timeline-inner">
          <ol class="msg-list">
            ${items.map((m) => (RENDERERS[m.kind] ?? message)(m)).join('')}
          </ol>
          <div class="typing" aria-live="polite">${typingLine(typing)}</div>
        </div>
      </div>

      <div class="composer-wrap">
        <form class="composer" id="composer">
          <button type="button" class="composer-btn" data-attach
                  title="Attach a file" aria-label="Attach a file">${icons.plus}</button>
          <textarea class="composer-input" id="composerInput" rows="1"
                    placeholder="Message ${esc(room.name ?? 'the room')}…"
                    aria-label="Write a message"></textarea>
          <button type="button" class="composer-btn" data-gif
                  title="GIF" aria-label="Insert a GIF">GIF</button>
          <button type="button" class="composer-btn" data-emoji
                  title="Emoji" aria-label="Insert an emoji">${icons.emoji}</button>
          <button type="submit" class="composer-btn send" aria-label="Send">${icons.send}</button>
        </form>
      </div>
    </main>`;
}
