// The Admin section of settings: pure views, like everything else here.
//
// These panels render whatever the admin API returned — members with live presence,
// channels, the server's own vitals, a log tail — and the one screen that must be hard
// to use by design: the wipe. Buttons carry data- attributes; the controller wires them.

import { esc } from '../ui/dom.js';
import { avatar } from '../room/views/parts.js';

/* ── shared bits ─────────────────────────────────────────────────────────── */

const banner = (error, notice) => `
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}
    ${notice ? `<div class="form-message ok show">${esc(notice)}</div>` : ''}`;

const loading = (what) => `<p class="panel-lead">Loading ${esc(what)}…</p>`;

/**
 * Destructive buttons arm on the first click and fire on the second, so a slip of the
 * mouse costs nothing. The controller flips `data-armed`; the view just states it.
 */
const armable = (attrs, label, armedLabel, { armed = false, danger = true } = {}) => `
    <button type="button" class="btn small ${danger ? 'danger-btn' : ''} ${armed ? 'armed' : ''}"
            ${attrs} ${armed ? 'data-armed' : ''}>
      ${esc(armed ? armedLabel : label)}
    </button>`;

/* ── Users ───────────────────────────────────────────────────────────────── */

export function adminUsersPanel({ members = null, error = null, notice = null, editingId = null, armedKey = null } = {}) {
    return `
    <h2 class="panel-title">User management</h2>
    <p class="panel-lead">
      Everyone with an account here. Adding someone new is done with an
      <button type="button" class="link-btn" data-goto-invites>invite</button> — accounts are never created by hand.
    </p>
    ${banner(error, notice)}
    ${members === null ? loading('members') : `
    <div class="admin-table" role="table" aria-label="Members">
      ${members.map((m) => userRow(m, { editing: editingId === m.id, armedKey })).join('')
        || '<p class="panel-lead">Nobody yet.</p>'}
    </div>`}`;
}

function userRow(m, { editing, armedKey }) {
    const armed = (action) => armedKey === `${action}:${m.id}`;
    return `
    <div class="adm-row" role="row" data-user-row="${esc(m.id)}">
      <span class="adm-who">
        ${avatar({ ...m, presence: m.offline ? 'offline' : 'online' })}
        <span class="adm-names">
          ${editing ? `
          <span class="adm-edit">
            <input data-rename-input value="${esc(m.displayName ?? m.username)}"
                   maxlength="40" aria-label="Display name">
            <button type="button" class="btn small primary" data-admin-rename-save="${esc(m.id)}">Save</button>
            <button type="button" class="btn small" data-admin-rename-cancel>Cancel</button>
          </span>` : `
          <span class="adm-display">${esc(m.displayName ?? m.username)}</span>
          <span class="adm-username">@${esc(m.username)}${m.invitedBy ? ` · invited by ${esc(m.invitedBy)}` : ' · founder'}</span>`}
        </span>
      </span>
      <span class="adm-flags">
        ${m.isAdmin ? '<span class="badge admin">Admin</span>' : ''}
        ${m.isTester ? '<span class="badge tester">Tester</span>' : ''}
        ${m.banned ? '<span class="badge banned">Banned</span>' : ''}
        ${m.mustReset ? '<span class="badge reset">Reset pending</span>' : ''}
      </span>
      <span class="adm-actions">
        ${editing ? '' : `
        <button type="button" class="btn small" data-admin-edit="${esc(m.id)}">Rename</button>
        ${m.isAdmin
        ? armable(`data-admin-demote="${esc(m.id)}"`, 'Remove admin', 'Remove admin?', { armed: armed('demote') })
        : `<button type="button" class="btn small" data-admin-promote="${esc(m.id)}">Make admin</button>`}
        <button type="button" class="btn small" data-admin-tester="${esc(m.id)}" data-tester-next="${m.isTester ? '0' : '1'}">${m.isTester ? 'Remove tester' : 'Make tester'}</button>
        ${armable(`data-admin-reset="${esc(m.id)}"`, 'Reset password', 'Kick to login now?', { armed: armed('reset') })}
        ${m.banned
        ? `<button type="button" class="btn small" data-admin-unban="${esc(m.id)}">Unban</button>`
        : armable(`data-admin-ban="${esc(m.id)}"`, 'Ban', 'Ban — sure?', { armed: armed('ban') })}
        ${armable(`data-admin-remove="${esc(m.id)}"`, 'Remove', 'Erase account?', { armed: armed('remove') })}`}
      </span>
    </div>`;
}

/* ── Channels ────────────────────────────────────────────────────────────── */

export function adminChannelsPanel({ channels = null, error = null, notice = null, editingId = null, armedKey = null, busy = false } = {}) {
    return `
    <h2 class="panel-title">Channel management</h2>
    <p class="panel-lead">The server's rooms. Private huddles manage themselves and are not listed here.</p>
    ${banner(error, notice)}
    ${channels === null ? loading('channels') : `
    <div class="admin-table" role="table" aria-label="Channels">
      ${channels.filter((c) => !c.private).map((c) => channelRow(c, { editing: editingId === c.id, armedKey })).join('')
        || '<p class="panel-lead">No channels yet.</p>'}
    </div>

    <form class="adm-create" data-admin-create-channel>
      <input name="name" placeholder="New channel name" maxlength="40" required>
      <select name="kind" aria-label="Channel type">
        <option value="both">Voice + text</option>
        <option value="voice">Voice only</option>
        <option value="text">Text only</option>
      </select>
      <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${busy ? 'Creating…' : 'Create'}</button>
    </form>`}`;
}

function channelRow(c, { editing, armedKey }) {
    const armed = (action) => armedKey === `${action}:${c.id}`;
    const kind = c.allowVoice && c.allowText ? 'voice + text' : c.allowVoice ? 'voice' : 'text';
    return `
    <div class="adm-row" role="row" data-channel-row="${esc(c.id)}">
      <span class="adm-who">
        <span class="adm-names">
          ${editing ? `
          <span class="adm-edit">
            <input data-chan-rename-input value="${esc(c.name)}" maxlength="40"
                   aria-label="Channel name">
            <input data-chan-topic-input value="${esc(c.topic ?? '')}" maxlength="120"
                   placeholder="Topic — one line under the name" aria-label="Channel topic">
            <button type="button" class="btn small primary" data-chan-rename-save="${esc(c.id)}">Save</button>
            <button type="button" class="btn small" data-chan-rename-cancel>Cancel</button>
          </span>` : `
          <span class="adm-display">${esc(c.name)}</span>
          <span class="adm-username">${esc(kind)}${c.isDefault ? ' · landing room' : ''}${c.topic ? ` · ${esc(c.topic)}` : ''}</span>`}
        </span>
      </span>
      <span class="adm-actions">
        ${editing ? '' : `
        <button type="button" class="btn small" data-chan-edit="${esc(c.id)}">Rename</button>
        ${c.allowText
        ? armable(`data-chan-clear="${esc(c.id)}"`, 'Clear text', 'Delete all messages?', { armed: armed('clear') })
        : ''}
        ${armable(`data-chan-delete="${esc(c.id)}"`, 'Delete', 'Delete channel?', { armed: armed('delete') })}`}
      </span>
    </div>`;
}

/* ── Server ──────────────────────────────────────────────────────────────── */

const fmtUptime = (s) => {
    if (!Number.isFinite(s)) return '—';
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

export function adminServerPanel({ overview = null, logs = null, error = null } = {}) {
    return `
    <h2 class="panel-title">Server logs &amp; status</h2>
    ${banner(error, null)}
    ${overview === null ? loading('status') : `
    <div class="adm-stats">
      ${stat('Uptime', fmtUptime(overview.uptimeSeconds))}
      ${stat('Connected now', String(overview.connections?.peers ?? 0))}
      ${stat('Accounts', String(overview.counts?.users ?? 0))}
      ${stat('Messages', String(overview.counts?.chat_messages ?? 0))}
      ${stat('Database', `${fmtBytes(overview.database?.bytes ?? 0)}${overview.database?.healthy ? '' : ' · UNHEALTHY'}`)}
      ${stat('Memory', `${overview.memoryMb} MB`)}
      ${stat('Media', `${esc(overview.media?.announcedAddress ?? '?')} (${esc(overview.media?.announcedSource ?? '?')})`)}
      ${stat('Modules', (overview.modules ?? []).filter((m) => m.enabled).map((m) => m.id).join(', ') || 'none')}
    </div>`}

    <div class="adm-log-head">
      <h3 class="settings-sub">Recent log</h3>
      <button type="button" class="btn small" data-admin-refresh-logs>Refresh</button>
    </div>
    ${logs === null ? loading('log tail') : `
    <pre class="adm-log" aria-label="Server log tail">${
    (logs.entries ?? []).slice(-200).map(logLine).join('\n') || 'The log is empty.'}</pre>`}`;
}

const stat = (label, value) => `
    <div class="adm-stat"><span class="adm-stat-label">${esc(label)}</span>
    <span class="adm-stat-value">${esc(value)}</span></div>`;

const LEVELS = { 10: 'trc', 20: 'dbg', 30: 'inf', 40: 'WRN', 50: 'ERR', 60: 'FTL' };
function logLine(entry) {
    const t = entry.time ? new Date(entry.time).toISOString().slice(11, 19) : '--:--:--';
    const lvl = LEVELS[entry.level] ?? '   ';
    return esc(`${t} ${lvl} ${entry.msg ?? entry.evt ?? ''}`);
}

/* ── The button ──────────────────────────────────────────────────────────── */

/** The server's name, backwards — the "small puzzle". Typing it forward proves reading, not clicking. */
export const reversedName = (name) => [...String(name ?? '')].reverse().join('');

export function adminDangerPanel({ stage = 'idle', serverName = '', typed = '', error = null, busy = false } = {}) {
    const solved = typed === serverName && serverName !== '';
    return `
    <h2 class="panel-title">Danger</h2>
    <p class="panel-lead">There is exactly one thing on this page, and you should not press it.</p>
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}

    ${stage === 'idle' ? `
    <div class="doom-zone">
      <button type="button" class="doom-btn" data-doom-arm>DO NOT PRESS</button>
      <span class="doom-hint">Wipes every table on the server — accounts, messages, channels, invites,
      settings. Yours too. The server itself survives, empty, back at first-run setup.</span>
    </div>` : ''}

    ${stage === 'confirm' ? `
    <div class="doom-zone armed">
      <h3 class="doom-title">This destroys everything.</h3>
      <p class="doom-copy">Every account including your own, every message, every channel, every invite.
      Everyone is disconnected. There is no undo, no backup, no grace period.</p>
      <div class="adm-actions">
        <button type="button" class="btn" data-doom-cancel autofocus>Take me back</button>
        <button type="button" class="btn danger-btn" data-doom-continue>I understand — continue</button>
      </div>
    </div>` : ''}

    ${stage === 'puzzle' ? `
    <div class="doom-zone armed">
      <h3 class="doom-title">Prove you mean it.</h3>
      <p class="doom-copy">This server's name is shown below <strong>backwards</strong>.
      Type it forwards to unlock the button.</p>
      <code class="doom-riddle">${esc(reversedName(serverName))}</code>
      <input data-doom-answer placeholder="Type the server's name" autocomplete="off"
             spellcheck="false" value="${esc(typed)}" autofocus>
      <div class="adm-actions">
        <button type="button" class="btn" data-doom-cancel>Take me back</button>
        <button type="button" class="btn danger-btn" data-doom-fire ${solved && !busy ? '' : 'disabled'}>
          ${busy ? 'Destroying…' : 'Destroy everything'}
        </button>
      </div>
    </div>` : ''}

    ${stage === 'done' ? `
    <div class="doom-zone">
      <h3 class="doom-title">It is done.</h3>
      <p class="doom-copy">The server wiped itself and closed every connection.
      It is back at first-run setup, waiting for a new administrator.</p>
    </div>` : ''}`;
}
