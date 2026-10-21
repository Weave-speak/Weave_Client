// The Admin section of settings: pure views, like everything else here.
//
// These panels render whatever the admin API returned — members with live presence,
// channels, the server's own vitals, a log tail — and the one screen that must be hard
// to use by design: the wipe. Buttons carry data- attributes; the controller wires them.

import { esc } from '../ui/dom.js';
import { avatar } from '../room/views/parts.js';
import { DISPLAY_NAME_MAX } from './panels.js';

/* ── shared bits ─────────────────────────────────────────────────────────── */

const banner = (error, notice) => `
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}
    ${notice ? `<div class="form-message ok show">${esc(notice)}</div>` : ''}`;

const loading = (what) => `<p class="panel-lead">Loading ${esc(what)}…</p>`;

const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

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
                   maxlength="${DISPLAY_NAME_MAX}" aria-label="Display name">
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

/* ── Bug reports ─────────────────────────────────────────────────────────── */

/** A moment, in the words somebody would use to say when it was. */
const receivedAtText = (value) => {
    if (!value) return 'Unknown time';
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return String(value);
    return when.toLocaleString(undefined, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
};

/** Log entries as they were written, whether they parsed as JSON or not. */
const asLines = (entries) => entries
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .join('\n');

/**
 * Bug reports, as an administrator reads them.
 *
 * The store is a folder of JSON files on the server — one report read whole by one person,
 * which is a file rather than a query. This is a window onto it: a list to scan, and one
 * report opened in full when a line looks like the one.
 *
 * A report deliberately carries both sides of the moment: what the reporter said, the tail
 * of their app log with paths and tokens already removed on their own machine, the server's
 * load at the instant it arrived, and the server's log around the same time. Reading one
 * file should answer the question without correlating two by timestamp.
 */
export function adminBugsPanel({
    reports = null, total = 0, open = null, error = null, notice = null, armedKey = null,
} = {}) {
    if (open) {
        return `
    ${banner(error, notice)}
    <button type="button" class="btn small" data-bug-close>← All reports</button>
    <h3 class="panel-section">${esc(receivedAtText(open.receivedAt))}</h3>
    <p class="panel-lead">
      ${esc(open.from?.username ?? 'Anonymous')}${open.client?.version
        ? ` · Weave ${esc(open.client.version)}${open.client.target ? ` (${esc(open.client.target)})` : ''}`
        : ''} · ${esc(open.kind ?? 'report')}
    </p>

    ${open.description ? `
    <h4 class="panel-section">What they said</h4>
    <p class="bug-said">${esc(open.description)}</p>` : ''}

    ${open.server ? `
    <h4 class="panel-section">The server, at that moment</h4>
    <pre class="bug-log">${esc(JSON.stringify(open.server, null, 2))}</pre>` : ''}

    ${open.log ? `
    <h4 class="panel-section">Their log</h4>
    <pre class="bug-log">${esc(open.log)}</pre>` : ''}

    ${Array.isArray(open.serverLog) && open.serverLog.length ? `
    <h4 class="panel-section">The server's log</h4>
    <pre class="bug-log">${esc(asLines(open.serverLog))}</pre>` : ''}

    ${open.raw ? `
    <h4 class="panel-section">The file, as it is on disk</h4>
    <pre class="bug-log">${esc(open.raw)}</pre>` : ''}`;
    }

    return `
    ${banner(error, notice)}
    ${reports === null ? loading('reports') : `
    <p class="panel-lead">${total === 0
        ? 'Nothing has been reported. Reports appear here as they arrive, and are deleted automatically once they age out.'
        : `${total} report${total === 1 ? '' : 's'}, newest first.`}</p>
    <div class="admin-table" role="table" aria-label="Bug reports">
      ${reports.map((r) => `
      <div class="adm-row" role="row">
        <span class="adm-names">
          <span class="adm-display">${r.description
            ? esc(r.description)
            : '<span class="adm-username">No description</span>'}</span>
          <span class="adm-username">${esc(receivedAtText(r.receivedAt))} ·
            ${esc(r.from ?? 'Anonymous')} · ${esc(r.kind ?? 'report')}</span>
        </span>
        <span class="adm-actions">
          <button type="button" class="btn small" data-bug-open="${esc(r.name)}">Read</button>
          ${armable(`data-bug-delete="${esc(r.name)}"`, 'Delete', 'Delete for good?',
        { armed: armedKey === `bug:${r.name}` })}
        </span>
      </div>`).join('')}
    </div>`}`;
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

/* ── Sounds ──────────────────────────────────────────────────────────────── */

/**
 * `people` and `birthday` are null while loading and `false` from a server too old to have
 * the routes, which is said in a line rather than offered as controls that would only 404.
 */
export function adminSoundsPanel({
    sounds = null, defaults = { joinSound: null, leaveSound: null },
    error = null, notice = null, armedKey = null, uploadBusy = false,
    people = null, birthday = null,
} = {}) {
    return `
    <h2 class="panel-title">Join &amp; leave sounds</h2>
    <p class="panel-lead">The server's sound library. Anyone can pick from these in their own profile.</p>
    ${banner(error, notice)}
    ${sounds === null ? loading('sounds') : `
    <div class="admin-table" role="table" aria-label="Sounds">
      ${sounds.map((s) => soundRow(s, { defaults, armedKey })).join('')
        || '<p class="panel-lead">No sounds uploaded yet.</p>'}
    </div>`}

    <div class="adm-create">
      <input type="file" accept="audio/ogg,audio/mpeg,audio/wav,.ogg,.mp3,.wav" multiple hidden data-sound-file>
      <button type="button" class="btn primary" data-add-sound ${uploadBusy ? 'disabled' : ''}>
        ${uploadBusy ? 'Uploading…' : 'Add sounds'}
      </button>
      <span class="setting-hint">OGG, MP3 or WAV. Up to 2&nbsp;MB each.</span>
    </div>

    ${sounds === null ? '' : birthdaySection({ sounds, people, birthday })}
    ${sounds === null ? '' : peopleSection({ sounds, people })}`;
}

const soundOptions = (sounds, selected, emptyLabel) => `
    <option value="" ${selected ? '' : 'selected'}>${esc(emptyLabel)}</option>
    ${sounds.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;

const tooOld = (what) => `<p class="panel-lead">This server is older than the app and cannot ${esc(what)} yet.</p>`;

/**
 * The birthday, as the web app had it: a person and a sound, heard by their room a few
 * seconds after they arrive. Both or neither — the server refuses half of one.
 */
function birthdaySection({ sounds, people, birthday }) {
    const body = people === false || birthday === false ? tooOld('play a birthday sound')
        : people === null || birthday === null ? loading('the birthday')
            : !sounds.length ? '<p class="panel-lead">Add a sound first.</p>'
                : `
    <form class="adm-create" data-birthday-form>
      <select name="userId" aria-label="Birthday person">
        <option value="" ${birthday.userId ? '' : 'selected'}>Nobody</option>
        ${people.map((p) => `<option value="${esc(p.id)}" ${p.id === birthday.userId ? 'selected' : ''}>${esc(p.displayName ?? p.username)}</option>`).join('')}
      </select>
      <select name="soundId" aria-label="Birthday sound">${soundOptions(sounds, birthday.soundId, 'No sound')}</select>
      <button type="submit" class="btn primary">Save</button>
      ${birthday.userId ? '<button type="button" class="btn" data-birthday-clear>Clear</button>' : ''}
    </form>`;
    return `
    <h3 class="panel-section">Birthday</h3>
    <p class="panel-lead">Their room hears this a few seconds after they arrive — once each time they sign in,
      including them. Clear it when the day is over.</p>
    ${body}`;
}

/**
 * Choosing for somebody, as the web app's Configurations screen did. It is the very choice
 * they can make in their own profile, so whichever of them chose last is what plays.
 */
function peopleSection({ sounds, people }) {
    const body = people === false ? tooOld('choose sounds for people')
        : people === null ? loading('people')
            : `
    <div class="admin-table" role="table" aria-label="Each person's sounds">
      ${people.map((p) => `
      <div class="adm-row" role="row" data-person-sounds="${esc(p.id)}">
        <span class="adm-names">
          <span class="adm-display">${esc(p.displayName ?? p.username)}</span>
          <span class="adm-username">@${esc(p.username)}</span>
        </span>
        <span class="adm-actions">
          <select data-person-sound="join" aria-label="${esc(p.username)}'s join sound">${soundOptions(sounds, p.joinSound, 'Default join')}</select>
          <select data-person-sound="leave" aria-label="${esc(p.username)}'s leave sound">${soundOptions(sounds, p.leaveSound, 'Default leave')}</select>
        </span>
      </div>`).join('')}
    </div>`;
    return `
    <h3 class="panel-section">Each person's sounds</h3>
    <p class="panel-lead">Choose for somebody. It is the same choice they can make in their own profile, so
      whoever chose last is what plays.</p>
    ${body}`;
}

/* ── Moderation ──────────────────────────────────────────────────────────── */

const clockOf = (ms) => new Date(ms).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** What one restriction is, in a sentence. */
export function restrictionText(r) {
    if (r.action === 'kick') return r.expiresAt ? `Kicked — can come back at ${clockOf(r.expiresAt)}` : 'Kicked';
    return r.expiresAt ? `Server-muted until ${clockOf(r.expiresAt)}` : 'Server-muted until lifted';
}

/**
 * Every restriction in force, wherever the person is — or whether they are online at all.
 * Before this an administrator could only see or lift a mute by finding the person in a
 * room and right-clicking them.
 */
export function adminModerationPanel({ restrictions = null, error = null, notice = null } = {}) {
    return `
    <h2 class="panel-title">Moderation</h2>
    <p class="panel-lead">Server mutes and kicks in force right now. Muting and kicking are done by right-clicking
      somebody in a room; lifting a mute can be done from here, whether or not they are online.</p>
    ${banner(error, notice)}
    ${restrictions === null ? loading('restrictions')
        : restrictions === false ? tooOld('list who is restricted')
            : `
    <div class="admin-table" role="table" aria-label="Restrictions in force">
      ${restrictions.map((r) => `
      <div class="adm-row" role="row">
        <span class="adm-names">
          <span class="adm-display">${esc(r.displayName ?? r.username)}</span>
          <span class="adm-username">${esc(restrictionText(r))}${r.byUsername ? ` · by @${esc(r.byUsername)}` : ''}</span>
        </span>
        <span class="adm-actions">
          ${r.action === 'mute'
        ? `<button type="button" class="btn small" data-lift-mute="${esc(r.userId)}">Lift</button>` : ''}
        </span>
      </div>`).join('') || '<p class="panel-lead">Nobody is muted or kicked.</p>'}
    </div>`}`;
}

/* ── Invites ─────────────────────────────────────────────────────────────── */

/** An invite's expiry, in words. Expired ones are said to be, not hidden: they explain a failed sign-up. */
export function inviteExpiry(expiresAt, now = Date.now()) {
    if (!expiresAt) return 'never expires';
    if (expiresAt <= now) return 'expired';
    return `expires ${clockOf(expiresAt)}`;
}

export function adminInvitesPanel({ invites = null, error = null, notice = null, armedKey = null, now = Date.now() } = {}) {
    return `
    <h2 class="panel-title">Invites</h2>
    <p class="panel-lead">Every invite code on the server, whoever made it. Revoking one stops it working at once;
      anyone who already joined with it keeps their account.</p>
    ${banner(error, notice)}
    ${invites === null ? loading('invites') : `
    <div class="admin-table" role="table" aria-label="Invites">
      ${invites.map((i) => {
        const used = i.maxUses ? `${i.uses ?? 0} of ${i.maxUses} used` : `${i.uses ?? 0} used`;
        return `
      <div class="adm-row" role="row">
        <span class="adm-names">
          <span class="adm-display"><code class="invite-code">${esc(i.code)}</code></span>
          <span class="adm-username">${esc(used)} · ${esc(inviteExpiry(i.expiresAt, now))}${i.createdByName ? ` · by @${esc(i.createdByName)}` : ''}${i.note ? ` · ${esc(i.note)}` : ''}</span>
        </span>
        <span class="adm-actions">
          ${armable(`data-invite-revoke="${esc(i.code)}"`, 'Revoke', 'Revoke — sure?', { armed: armedKey === `invite:${i.code}` })}
        </span>
      </div>`;
    }).join('') || '<p class="panel-lead">No invites yet. Make one from Crew → Invites.</p>'}
    </div>`}`;
}

/* ── Server settings ─────────────────────────────────────────────────────── */

/**
 * Settings with a better home elsewhere: ids nobody should type, chosen from a list on the
 * Sounds screen. Shown there, so they are left out here rather than offered twice.
 */
export const SETTINGS_SHOWN_ELSEWHERE = new Set([
    'sounds.defaultJoinSound', 'sounds.defaultLeaveSound', 'sounds.birthdayUserId', 'sounds.birthdaySound',
]);

function settingControl(item) {
    const id = `srv-${item.key.replace(/[^\w-]/g, '-')}`;
    const attrs = `id="${esc(id)}" data-server-setting="${esc(item.key)}" data-setting-type="${esc(item.type)}"`;
    let control;
    if (item.type === 'boolean') {
        control = `<input class="switch" type="checkbox" ${attrs} ${item.value ? 'checked' : ''}>`;
    } else if (item.type === 'number') {
        control = `<input class="adm-number" type="number" ${attrs} value="${esc(item.value)}"
            ${item.min !== undefined && item.min !== null ? `min="${esc(item.min)}"` : ''}
            ${item.max !== undefined && item.max !== null ? `max="${esc(item.max)}"` : ''}>`;
    } else if (item.type === 'enum') {
        control = `<select ${attrs}>${(item.values ?? []).map((v) =>
            `<option value="${esc(v)}" ${v === item.value ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    } else {
        control = `<input type="text" ${attrs} value="${esc(item.value ?? '')}">`;
    }
    return `
    <div class="setting">
      <label class="setting-text" for="${esc(id)}">
        <span class="setting-label">${esc(item.label)}</span>
        ${item.help ? `<span class="setting-hint">${esc(item.help)}</span>` : ''}
      </label>
      ${control}
    </div>`;
}

/**
 * The server's own settings and its modules, rendered from what the server says it has.
 *
 * Modules declare their settings with a type and a label so that no module ships UI; the
 * web console has always drawn a form from that, and this is the same form in the app. The
 * web app's AFK timeout lives here now, as the away module's "idle minutes".
 */
export function adminSettingsPanel({ groups = null, modules = null, error = null, notice = null } = {}) {
    const nameOf = (owner) => (owner === 'core' ? 'Server' : modules?.find((m) => m.id === owner)?.name ?? owner);
    const visible = (groups ?? [])
        .map((g) => ({ ...g, items: g.items.filter((i) => !SETTINGS_SHOWN_ELSEWHERE.has(i.key)) }))
        .filter((g) => g.items.length);
    return `
    <h2 class="panel-title">Server settings</h2>
    <p class="panel-lead">Changes apply on the server at once. A module switched on or off reaches each person's
      app the next time they connect.</p>
    ${banner(error, notice)}

    <h3 class="panel-section">Modules</h3>
    ${modules === null ? loading('modules') : `
    <div class="admin-table" role="table" aria-label="Modules">
      ${modules.map((m) => `
      <div class="adm-row" role="row">
        <label class="adm-names" for="mod-${esc(m.id)}">
          <span class="adm-display">${esc(m.name ?? m.id)}</span>
          <span class="adm-username">${esc(m.description ?? '')}</span>
        </label>
        <input class="switch" type="checkbox" id="mod-${esc(m.id)}" data-module-toggle="${esc(m.id)}"
               ${m.enabled ? 'checked' : ''} aria-label="${esc(m.name ?? m.id)}">
      </div>`).join('')}
    </div>`}

    ${groups === null ? loading('settings') : visible.map((g) => `
    <h3 class="panel-section">${esc(nameOf(g.owner))}</h3>
    ${g.items.map(settingControl).join('')}`).join('')}`;
}

function soundRow(s, { defaults, armedKey }) {
    const armed = armedKey === `delete-sound:${s.id}`;
    const isJoinDefault = defaults.joinSound === s.id;
    const isLeaveDefault = defaults.leaveSound === s.id;
    return `
    <div class="adm-row" role="row" data-sound-row="${esc(s.id)}">
      <span class="adm-who">
        <span class="adm-names">
          <span class="adm-display">${esc(s.name)}</span>
          <span class="adm-username">${esc(fmtBytes(s.bytes))}</span>
        </span>
      </span>
      <span class="adm-flags">
        ${isJoinDefault ? '<span class="badge default">Join default</span>' : ''}
        ${isLeaveDefault ? '<span class="badge default">Leave default</span>' : ''}
      </span>
      <span class="adm-actions">
        <button type="button" class="btn small" data-preview-sound="${esc(s.id)}" aria-label="Preview">▶</button>
        ${isJoinDefault ? '' : `<button type="button" class="btn small" data-set-default="${esc(s.id)}" data-which="join">Set as join default</button>`}
        ${isLeaveDefault ? '' : `<button type="button" class="btn small" data-set-default="${esc(s.id)}" data-which="leave">Set as leave default</button>`}
        ${armable(`data-delete-sound="${esc(s.id)}"`, 'Delete', 'Delete sound?', { armed })}
      </span>
    </div>`;
}

/* ── Server ──────────────────────────────────────────────────────────────── */

const fmtUptime = (s) => {
    if (!Number.isFinite(s)) return '—';
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export function adminServerPanel({ overview = null, logs = null, audit = null, consoleUrl = null, error = null } = {}) {
    return `
    <h2 class="panel-title">Server logs &amp; status</h2>
    ${banner(error, null)}
    ${consoleUrl ? `
    <p class="panel-lead">The raw database, first-run setup and module manager live in the server's own web console —
      <a class="msg-link" href="${esc(consoleUrl)}" target="_blank" rel="noreferrer noopener">open it in your browser</a>.</p>` : ''}
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
    (logs.entries ?? []).slice(-200).map(logLine).join('\n') || 'The log is empty.'}</pre>`}

    ${audit ? `
    <h3 class="settings-sub">Who did what</h3>
    <div class="admin-table" role="table" aria-label="Audit log">
      ${audit.map((a) => `
      <div class="adm-row" role="row">
        <span class="adm-names">
          <span class="adm-display">${esc(auditAction(a.action))}${a.target ? ` · ${esc(a.target)}` : ''}</span>
          <span class="adm-username">${esc(a.at ?? '')}${a.actor ? ` · by @${esc(a.actor)}` : ''}${a.detail ? ` · ${esc(a.detail)}` : ''}</span>
        </span>
      </div>`).join('') || '<p class="panel-lead">Nothing recorded yet.</p>'}
    </div>` : ''}`;
}

/** ADMIN_SERVER_MUTED → "Server muted". The codes are for grep; people read words. */
export const auditAction = (code) => {
    const words = String(code ?? '').replace(/^ADMIN_/, '').toLowerCase().replace(/_/g, ' ');
    return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
};

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
