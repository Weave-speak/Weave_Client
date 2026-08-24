// The settings panels.
//
// Pure functions of state, like every other view here. The interesting decision is what to
// do about the controls the server cannot yet support.
//
// A disabled toggle with no explanation is the worst of the options: it looks broken, and
// the person who meets it cannot tell whether the feature is missing, their account lacks
// permission, or something failed. So every control that cannot work says WHY in one line,
// and the ones that need a server change say so plainly rather than pretending to be busy.
//
// The alternative — hiding them — would be worse here, because the design has been agreed
// and the gaps are the roadmap. Showing them is how the shape of the thing stays visible.

import { esc } from '../ui/dom.js';
import { icons } from '../room/icons.js';
import { avatar } from '../room/views/parts.js';

/** Nav, in the design's groups. `needs` names a server feature the section depends on. */
export const SECTIONS = [
    {
        group: 'Account',
        items: [
            { id: 'profile', label: 'My Profile', icon: 'weave' },
            { id: 'security', label: 'Security & Recovery', icon: 'lock', placeholder: true },
            { id: 'sessions', label: 'Sessions & Devices', icon: 'screen', placeholder: true },
        ],
    },
    {
        group: 'App',
        items: [
            { id: 'voice', label: 'Voice & Audio', icon: 'mic' },
            { id: 'notifications', label: 'Notifications', icon: 'speaker', placeholder: true },
            { id: 'appearance', label: 'Appearance', icon: 'image' },
        ],
    },
    {
        group: 'Crew',
        items: [
            { id: 'invites', label: 'Invites', icon: 'plus' },
            { id: 'privacy', label: 'Privacy & Blocking', icon: 'lock', placeholder: true },
            { id: 'bug', label: 'Report a Bug', icon: 'doc', placeholder: true },
        ],
    },
];

const allItems = () => SECTIONS.flatMap((s) => s.items);
export const sectionById = (id) => allItems().find((i) => i.id === id) ?? allItems()[0];

/* ── pieces ───────────────────────────────────────────────────────────────── */

const toggle = ({ id, label, hint, checked, disabled = false, note = '' }) => `
  <div class="setting${disabled ? ' is-disabled' : ''}">
    <label class="setting-text" for="${esc(id)}">
      <span class="setting-label">${esc(label)}</span>
      ${hint ? `<span class="setting-hint">${esc(hint)}</span>` : ''}
      ${note ? `<span class="setting-note">${esc(note)}</span>` : ''}
    </label>
    <input class="switch" type="checkbox" id="${esc(id)}" data-setting="${esc(id)}"
           ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
  </div>`;

/**
 * A control that cannot work yet, and why.
 *
 * The reason is the whole point. "Needs a server update" is actionable — it tells the
 * person nothing is wrong with their account and nothing is wrong with their machine.
 */
const notYet = (what, why) => `
  <div class="not-yet">
    <span class="not-yet-what">${esc(what)}</span>
    <span class="not-yet-why">${esc(why)}</span>
  </div>`;

const field = ({ id, label, value, hint, disabled = false }) => `
  <div class="field">
    <label for="${esc(id)}">${esc(label)}</label>
    <input id="${esc(id)}" name="${esc(id)}" value="${esc(value ?? '')}" ${disabled ? 'disabled' : ''}>
    ${hint ? `<div class="field-help">${esc(hint)}</div>` : ''}
  </div>`;

/**
 * A date a person would recognise, or nothing at all if the server did not send one.
 *
 * SQLite's datetime('now') produces "2026-08-23 14:01:59" — UTC, but with a space instead
 * of a T and no zone marker at all. Handed to `new Date` that is parsed as LOCAL time, so
 * an account created at 23:30 UTC shows the wrong day to anyone west of London. Normalising
 * it to ISO with an explicit Z is the whole fix.
 */
export function joinedOn(value) {
    if (!value) return null;
    const text = String(value);
    const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text;

    const when = new Date(normalised);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ── panels ───────────────────────────────────────────────────────────────── */

export function profilePanel({ me = {}, features = [] } = {}) {
    const joined = joinedOn(me.createdAt);
    const hasPersonas = features.includes('module.personas');

    return `
    <h2 class="panel-title">My Profile</h2>
    <p class="panel-lead">Your display name and picture are what the crew sees.</p>

    <div class="profile-card">
      <div class="profile-banner" aria-hidden="true"></div>
      <div class="profile-identity">
        ${avatar(me, { size: 'lg', presence: false })}
        <div>
          <div class="profile-name">
            ${esc(me.displayName ?? me.username ?? '')}
            ${me.isAdmin ? '<span class="badge admin">Admin</span>' : ''}
          </div>
          <div class="profile-meta">
            ${esc(me.username ? `@${me.username}` : '')}${joined ? ` · joined ${esc(joined)}` : ''}
          </div>
        </div>
      </div>
    </div>

    ${field({
        id: 'displayName',
        label: 'Display Name',
        value: me.displayName ?? '',
        hint: 'Editing this needs a server update — the server has no route to change it yet.',
        disabled: true,
    })}

    ${notYet('Profile picture', 'Uploads work, but nothing on the server can attach one to an account yet.')}
    ${notYet('Status', 'The server has no status field. Presence is shown instead.')}

    ${hasPersonas
        ? notYet('Join and leave sounds', 'Sound library not loaded yet.')
        : notYet('Join and leave sounds', 'The personas module is switched off on this server.')}

    <p class="panel-lead">Microphone and voice behaviour has moved to Voice &amp; Audio.</p>

    <h3 class="panel-section">Application</h3>
    <div class="setting">
      <span class="setting-text">
        <span class="setting-label">Updates</span>
        <span class="setting-hint">Runs the same check the app performs at launch. The bar at the
          bottom of the window reports what it finds and offers the restart.</span>
        <span class="setting-note" id="updateCheckNote"></span>
      </span>
      <button type="button" class="btn" data-check-updates>Check for updates</button>
    </div>`;
}

const choose = ({ id, label, hint, value, options }) => `
  <div class="setting">
    <label class="setting-text" for="${esc(id)}">
      <span class="setting-label">${esc(label)}</span>
      ${hint ? `<span class="setting-hint">${esc(hint)}</span>` : ''}
    </label>
    <select id="${esc(id)}" data-setting="${esc(id)}">
      ${options.map(([v, text]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(text)}</option>`).join('')}
    </select>
  </div>`;

export function voicePanel({ prefs = {}, devices = [], cameras = [], features = [] } = {}) {
    const hasAfk = features.includes('module.afk');
    return `
    <h2 class="panel-title">Voice &amp; Audio</h2>
    <p class="panel-lead">Everything about your microphone and what you hear. Per device.</p>

    <h3 class="panel-section">Microphone</h3>

    ${devices.length
        ? `<div class="field">
             <label for="micDevice">Input device</label>
             <select id="micDevice" data-setting="micDevice">
               ${devices.map((d) => `<option value="${esc(d.deviceId)}"
                    ${d.deviceId === prefs.micDevice ? 'selected' : ''}>${esc(d.label || 'Microphone')}</option>`).join('')}
             </select>
             <span class="setting-note" id="activeMic">Checking which device is live…</span>
           </div>`
        : notYet('Input device', 'Device names are only readable once microphone access has been granted.')}

    ${toggle({
        id: 'pushToTalk',
        label: 'Push to talk',
        hint: 'Hold a key to speak instead of an open microphone. The mute button hands over to the key while this is on.',
        checked: Boolean(prefs.pushToTalk),
    })}

    <div class="setting${prefs.pushToTalk ? '' : ' is-disabled'}">
      <label class="setting-text" for="pttKey">
        <span class="setting-label">Push-to-talk key</span>
        <span class="setting-hint">Click, then press the key you want.</span>
      </label>
      <button type="button" class="key-capture" id="pttKey" data-capture-key
              ${prefs.pushToTalk ? '' : 'disabled'}>${esc(prefs.pushToTalkKey ?? 'Space')}</button>
    </div>

    <h3 class="panel-section">Processing</h3>

    <div class="setting">
      <label class="setting-text" for="micGain">
        <span class="setting-label">Input gain
          <span class="slider-value" data-value-for="micGain">${esc(prefs.micGain ?? 100)}%</span>
          <button type="button" class="reset-link" data-reset-gain
                  ${Number(prefs.micGain ?? 100) === 100 ? 'hidden' : ''}>reset</button></span>
        <span class="setting-hint">Your loudness before anything else. 100 is untouched; above it boosts a quiet microphone.</span>
      </label>
      <input class="setting-range" type="range" id="micGain" data-setting="micGain"
             min="0" max="200" value="${esc(prefs.micGain ?? 100)}">
    </div>

    ${toggle({
        id: 'noiseGate',
        label: 'Noise gate',
        hint: 'Transmit only when you are actually speaking. Watch the meter: the gate opens when the bar crosses the line.',
        checked: Boolean(prefs.noiseGate),
    })}

    <div class="setting gate-setting${prefs.noiseGate ? '' : ' is-disabled'}">
      <div class="setting-text">
        <span class="setting-label">Sensitivity
          <span class="slider-value" data-value-for="gateSensitivity">${esc(prefs.gateSensitivity ?? 64)}</span></span>
        <span class="setting-hint">One bar, two facts: the fill is your microphone, the line is the gate.
          Drag the line to sit just above where the fill rests while you are silent.</span>
        <span class="mic-meter is-control">
          <i class="mic-meter-fill" id="micMeterFill"></i>
          <i class="mic-meter-mark" id="micThreshMark" style="left: ${esc(prefs.gateSensitivity ?? 64)}%"></i>
          <input class="meter-range" type="range" id="gateSensitivity" data-setting="gateSensitivity"
                 min="0" max="100" value="${esc(prefs.gateSensitivity ?? 64)}"
                 aria-label="Gate sensitivity" ${prefs.noiseGate ? '' : 'disabled'}>
        </span>
        <span class="setting-note" id="gateState">The meter runs while you are in a voice room.</span>
      </div>
    </div>

    ${toggle({
        id: 'noiseSuppression',
        label: 'Noise suppression',
        hint: 'Removes keyboard clatter and fan hum before it reaches the server.',
        checked: prefs.noiseSuppression !== false,
    })}

    ${toggle({
        id: 'echoCancellation',
        label: 'Echo cancellation',
        hint: 'Stops your speakers being picked up by your microphone.',
        checked: prefs.echoCancellation !== false,
    })}

    ${toggle({
        id: 'autoGainControl',
        label: 'Automatic gain',
        hint: 'Evens out how loud you are. Turn this off if you use your own mixer.',
        checked: prefs.autoGainControl !== false,
    })}

    <h3 class="panel-section">Camera</h3>

    ${cameras.length
        ? choose({
            id: 'camDevice', label: 'Camera',
            value: prefs.camDevice ?? cameras[0]?.deviceId,
            options: cameras.map((c) => [c.deviceId, c.label || 'Camera']),
        })
        : notYet('Camera selection', 'Device names are readable once a camera has been used.')}
    ${choose({
        id: 'camRes', label: 'Camera quality',
        value: prefs.camRes ?? '720',
        options: [['720', '720p — kind to upload'], ['1080', '1080p — sharper, heavier']],
    })}

    <h3 class="panel-section">Screen sharing</h3>

    ${choose({
        id: 'streamPreset', label: 'Stream quality',
        hint: 'Applies from your next share.',
        value: prefs.streamPreset ?? '1080p30',
        options: [
            ['720p30', '720p · 30fps — kind to every connection'],
            ['1080p30', '1080p · 30fps — the everyday default'],
            ['1080p60', '1080p · 60fps — games'],
            ['source', 'Source — your screen exactly as it is'],
        ],
    })}
    ${choose({
        id: 'streamPrefer', label: 'When the connection tightens',
        hint: 'The encoder cannot always keep both. Pick what survives.',
        value: prefs.streamPrefer ?? 'detail',
        options: [['detail', 'Keep text readable'], ['motion', 'Keep motion smooth']],
    })}

    <h3 class="panel-section">Presence</h3>

    ${hasAfk
        ? toggle({
            id: 'afkExempt',
            label: 'Exempt me from being moved when idle',
            hint: 'Weave normally moves you to the away room after a stretch of silence.',
            checked: Boolean(prefs.afkExempt),
        })
        : notYet('AFK exemption', 'The away module is switched off on this server.')}
`;
}

export function appearancePanel({ prefs = {} } = {}) {
    return `
    <h2 class="panel-title">Appearance</h2>
    <p class="panel-lead">How Weave looks on this device.</p>

    ${toggle({
        id: 'staticBackground',
        label: 'Still background',
        hint: 'Stops the weaving strands behind the conversation from moving.',
        checked: Boolean(prefs.staticBackground),
        note: 'Also follows your system "reduce motion" setting.',
    })}

    ${notYet('Themes', 'Weave has one palette at the moment. A light theme is a later piece of work.')}`;
}

export function invitesPanel({ invite = null, busy = false, error = null, origin = null } = {}) {
    const link = invite && origin ? `${origin}/invite/${invite.code}` : null;
    return `
    <h2 class="panel-title">Invites</h2>
    <p class="panel-lead">
      Weave is invite-only. Anyone already here can bring somebody in.
    </p>

    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}

    ${invite ? `
      <div class="invite-result">
        ${link ? `
        <span class="invite-label">Send them this link — it offers the download and fills
          everything in</span>
        <code class="invite-link">${esc(link)}</code>
        <button type="button" class="btn primary" data-copy-link>Copy link</button>
        <span class="invite-label">Or, for someone who already has Weave, just the code</span>` : `
        <span class="invite-label">Give them this code</span>`}
        <code class="invite-code">${esc(invite.code)}</code>
        <span class="invite-meta">
          ${esc(invite.maxUses === 1 ? 'Single use' : `${invite.maxUses} uses`)}${
    invite.expiresAt ? ` · expires ${esc(joinedOn(invite.expiresAt) ?? 'soon')}` : ' · never expires'}
        </span>
        <button type="button" class="btn" data-copy-invite>Copy code</button>
      </div>` : ''}

    <button type="button" class="btn primary" data-create-invite ${busy ? 'disabled' : ''}>
      ${busy ? 'Creating…' : 'Create an invite'}
    </button>

    ${notYet('Your existing invites', 'Listing and revoking your own codes needs a server update.')}`;
}

export function placeholderPanel({ label = '', reason = '' } = {}) {
    return `
    <h2 class="panel-title">${esc(label)}</h2>
    <p class="panel-lead">${esc(reason)}</p>
    <div class="not-yet standalone">
      <span class="not-yet-what">Not built yet</span>
      <span class="not-yet-why">This screen is in the design and is recorded as outstanding work.</span>
    </div>`;
}

export const PLACEHOLDER_REASONS = {
    security: 'Changing your password or security question from inside the app needs a server update — '
        + 'today the only route is the forgotten-password flow on the sign-in screen.',
    sessions: 'Listing and signing out other devices needs a server update. Sessions are stored, but '
        + 'there is no way for the app to ask for yours.',
    notifications: 'Weave does not track unread messages or mentions yet, so there is nothing to notify '
        + 'you about.',
    privacy: 'Blocking someone has to be enforced by the server or it is only cosmetic. That work has '
        + 'not been done.',
    bug: 'The app can already gather a redacted diagnostic log; the server has nowhere to send it yet.',
};

/* ── the frame ────────────────────────────────────────────────────────────── */

const navItem = (item, current) => `
  <button type="button" class="nav-item${item.id === current ? ' current' : ''}"
          data-panel="${esc(item.id)}" ${item.id === current ? 'aria-current="page"' : ''}>
    ${icons[item.icon] ?? icons.weave}
    <span>${esc(item.label)}</span>
    ${item.placeholder ? '<span class="nav-flag" title="Not built yet">•</span>' : ''}
  </button>`;

export function settingsFrame({ me = {}, current = 'profile', body = '', serverName = '' } = {}) {
    return `
    <div class="settings">
      <header class="settings-crumb">
        <span class="crumb">Weave</span>
        <span class="crumb-sep">›</span>
        <span class="crumb">${esc(me.displayName ?? me.username ?? '')}</span>
        <span class="crumb-sep">›</span>
        <span class="crumb current">${esc(sectionById(current).label)}</span>
        <span class="crumb-spacer"></span>
        <span class="crumb-hint">Esc to close</span>
        <button type="button" class="icon-btn" data-close-settings aria-label="Close settings">✕</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings">
          ${SECTIONS.map((section) => `
            <h3 class="nav-group">${esc(section.group)}</h3>
            ${section.items.map((item) => navItem(item, current)).join('')}
          `).join('')}

          <span class="nav-spacer"></span>
          <button type="button" class="nav-item danger" data-sign-out>
            ${icons.power}<span>Sign out${serverName ? ` of ${esc(serverName)}` : ''}</span>
          </button>
        </nav>

        <section class="settings-panel" id="settingsPanel" tabindex="-1">${body}</section>
      </div>
    </div>`;
}
