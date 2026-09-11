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
            { id: 'security', label: 'Security & Recovery', icon: 'lock' },
            { id: 'sessions', label: 'Sessions & Devices', icon: 'screen' },
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
            { id: 'bug', label: 'Report a Bug', icon: 'doc' },
        ],
    },
    {
        // Rendered only for administrators. The gate is cosmetic — every admin API
        // call checks the session server-side — but a non-admin should never even see
        // the shape of these controls.
        group: 'Admin',
        adminOnly: true,
        items: [
            { id: 'admin-users', label: 'Users', icon: 'weave' },
            { id: 'admin-channels', label: 'Channels', icon: 'speaker' },
            { id: 'admin-sounds', label: 'Sounds', icon: 'speaker' },
            { id: 'admin-bugs', label: 'Bug reports', icon: 'doc' },
            { id: 'admin-server', label: 'Server', icon: 'doc' },
            { id: 'admin-danger', label: 'DO NOT PRESS', icon: 'power', danger: true },
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

/**
 * Picking a picture, and then which part of it is you.
 *
 * The frame is fixed and the picture moves under it, because that is what a hand expects
 * of a crop tool. The circle is the shape the avatar is everywhere else, so what is framed
 * here is exactly what appears in the roster — a square preview would be a promise the
 * rest of the app does not keep.
 */
const avatarCropper = ({ busy = false, error = '' } = {}) => `
  <div class="crop" data-crop hidden>
    <div class="crop-frame" data-crop-frame>
      <img class="crop-image" data-crop-image alt="">
      <div class="crop-ring" aria-hidden="true"></div>
    </div>
    <label class="crop-zoom">
      <span>Zoom</span>
      <input type="range" data-crop-zoom min="100" max="400" value="100"
             aria-label="Zoom the picture">
    </label>
    <p class="crop-hint">Drag the picture to choose what sits in the circle.</p>
    ${error ? `<p class="crop-error">${esc(error)}</p>` : ''}
    <div class="crop-actions">
      <button type="button" class="btn small" data-crop-cancel>Cancel</button>
      <button type="button" class="btn small primary" data-crop-save ${busy ? 'disabled' : ''}>
        ${busy ? 'Saving…' : 'Save picture'}
      </button>
    </div>
  </div>`;

/*
 * There is deliberately no Display Name field here.
 *
 * It existed as a disabled box explaining that the server had no route to change one, which
 * is a control that exists only to say no. The name is already on the card above, where it
 * is a fact rather than an invitation. If changing it ever becomes possible, the field comes
 * back as a working one.
 */
export function profilePanel({ me = {}, prefs = {}, features = [], avatarError = '', soundLibrary = [] } = {}) {
    const joined = joinedOn(me.createdAt);
    const hasSounds = features.includes('module.sounds');
    const canEdit = features.includes('profile');

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

    ${canEdit ? `
    <div class="setting">
      <span class="setting-text">
        <span class="setting-label">Profile picture</span>
        <span class="setting-hint">A PNG, JPEG, GIF or WebP. It is cropped to a circle.</span>
      </span>
      <span class="setting-buttons">
        <button type="button" class="btn small" data-pick-avatar>
          ${me.avatar ? 'Change' : 'Upload'}
        </button>
        ${me.avatar ? '<button type="button" class="btn small danger-btn" data-remove-avatar>Remove</button>' : ''}
      </span>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-avatar-file>
    ${avatarCropper({ error: avatarError })}`
        : notYet('Profile picture', 'This server has no route to attach one to an account.')}

    <!-- Status is deliberately NOT here. It lives behind your own name in the bottom bar,
         because a status three clicks into a preferences dialog is one nobody sets and
         nobody trusts to be current. -->

    ${hasSounds
        ? (soundLibrary.length
            ? soundPicker({ soundLibrary, prefs })
            : notYet('Join and leave sounds', 'No sounds have been uploaded to this server yet.'))
        : notYet('Join and leave sounds', 'The sounds module is switched off on this server.')}

    <p class="panel-lead">Microphone and voice behaviour has moved to Voice &amp; Audio.</p>`;
}

/**
 * How long ago, in the words somebody would use.
 *
 * Deliberately coarse, and deliberately not a clock time: the question this answers is
 * "is this device still in use?", and "3 hours ago" answers it while "14:12" makes the
 * reader do the arithmetic. Beyond a week the date is the more useful answer again.
 *
 * @param {number|null} at    epoch milliseconds, as the server stores last_used_at
 * @param {number}      now   injected so the test is not a race against the clock
 */
export function lastActive(at, now = Date.now()) {
    if (!at || !Number.isFinite(at)) return null;

    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return 'just now';

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

    const days = Math.round(hours / 24);
    if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;

    return joinedOn(new Date(at).toISOString()) ?? null;
}

const sessionRow = (session, now) => {
    const when = [
        joinedOn(session.createdAt) ? `Signed in ${joinedOn(session.createdAt)}` : null,
        lastActive(session.lastUsedAt, now) ? `last active ${lastActive(session.lastUsedAt, now)}` : null,
    ].filter(Boolean).join(' · ');

    return `
    <div class="setting">
      <span class="setting-text">
        <span class="setting-label">${esc(session.device)}${session.current
            ? ' <span class="session-here">This device</span>' : ''}</span>
        <span class="setting-hint">${esc(when)}</span>
      </span>
      ${session.current
        ? ''
        : `<button type="button" class="btn" data-session-signout="${esc(session.id)}">Sign out</button>`}
    </div>`;
};

export function sessionsPanel({
    version = '', features = [], sessions = null, error = null, notice = null, now = Date.now(),
} = {}) {
    const head = `
    <h2 class="panel-title">Sessions &amp; Devices</h2>
    <p class="panel-lead">This installation, and the account's other ones.</p>

    <h3 class="panel-section">This app</h3>
    <div class="setting">
      <span class="setting-text">
        <span class="setting-label">Weave ${esc(version)}</span>
        <span class="setting-hint">The version RUNNING right now. An update that has downloaded
          installs when the app restarts — until then, this number is the truth of what
          you are using.</span>
        <span class="setting-note" id="updateCheckNote"></span>
      </span>
      <button type="button" class="btn" data-check-updates>Check for updates</button>
    </div>`;

    if (!features.includes('account.sessions')) {
        return `${head}
    ${notYet('Signed-in sessions', 'This server is older than the app and cannot list them yet.')}`;
    }

    const list = sessions === null
        ? '<p class="panel-lead">Reading your devices…</p>'
        : sessions.map((s) => sessionRow(s, now)).join('');

    return `${head}

    <h3 class="panel-section">Signed-in sessions</h3>
    <p class="panel-lead">Everywhere this account is signed in. Signing one out ends it
      immediately — that device is returned to the sign-in screen.</p>
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}
    ${notice ? `<div class="form-message ok show">${esc(notice)}</div>` : ''}
    ${list}`;
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

/**
 * Like `choose()`, but with a play/stop preview button next to the select — for
 * picking from a library of audio rather than a list of settings. The button starts
 * as ▶; the controller flips it to ⏹ while that sound is actually playing.
 */
const soundOption = ({ id, label, hint, value, options }) => `
  <div class="setting">
    <label class="setting-text" for="${esc(id)}">
      <span class="setting-label">${esc(label)}</span>
      ${hint ? `<span class="setting-hint">${esc(hint)}</span>` : ''}
    </label>
    <span class="sound-select-row">
      <select id="${esc(id)}" data-setting="${esc(id)}">
        ${options.map(([v, text]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(text)}</option>`).join('')}
      </select>
      <button type="button" class="btn small" data-preview-sound-for="${esc(id)}" aria-label="Preview">▶</button>
    </span>
  </div>`;

const soundPicker = ({ soundLibrary, prefs }) => {
    const options = soundLibrary.map((s) => [s.id, s.name]);
    return `
    ${soundOption({
        id: 'joinSound', label: 'Join sound',
        hint: 'Played to everyone else in the channel when you arrive.',
        value: prefs.joinSound, options,
    })}
    ${soundOption({
        id: 'leaveSound', label: 'Leave sound',
        hint: 'Played to everyone else in the channel when you leave.',
        value: prefs.leaveSound, options,
    })}`;
};

export function voicePanel({ prefs = {}, devices = [], cameras = [], outputs = [], features = [] } = {}) {
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

    ${outputs.length
        ? `<div class="field">
             <label for="audioOutput">Output device</label>
             <select id="audioOutput" data-setting="audioOutput">
               <option value="" ${prefs.audioOutput ? '' : 'selected'}>System default</option>
               ${outputs.map((d) => `<option value="${esc(d.deviceId)}"
                    ${d.deviceId === prefs.audioOutput ? 'selected' : ''}>${esc(d.label || 'Output')}</option>`).join('')}
             </select>
             <span class="setting-note">Where the room's voices play. Point this at your headset, away from anything you capture for a stream, so viewers never hear themselves through your share.</span>
           </div>`
        : notYet('Output device', 'Device names are only readable once microphone access has been granted.')}

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
        <span class="setting-hint">One bar, two facts: the fill is your microphone as the gate hears
          it — after your input gain — and the line is where it opens. Sit quietly, then drag the line
          to just above where the fill settles.</span>
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
        id: 'voiceOptimize',
        label: 'Sound optimisation',
        hint: 'Evens out a loud voice so nobody blasts the room, and cuts the low rumble and hum cheap microphones pick up. Off leaves your voice exactly as your microphone hears it.',
        checked: Boolean(prefs.voiceOptimize),
    })}

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
    ${choose({
        id: 'camFps', label: 'Camera frame rate',
        hint: 'Higher is smoother and costs upload. Most webcams top out at 30.',
        value: String(prefs.camFps ?? 30),
        options: [
            ['15', '15 fps — low light, low upload'],
            ['30', '30 fps — the everyday default'],
            ['60', '60 fps — needs a camera that can'],
        ],
    })}

    <h3 class="panel-section">Screen sharing</h3>

    ${choose({
        id: 'streamPreset', label: 'Stream quality',
        hint: 'Applies from your next share. The frame rate is a target rather than a ceiling: a 70fps game streams at 35 rather than stuttering against a hard 30.',
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
        hint: 'The encoder cannot always keep both. Pick what survives — a game usually wants motion.',
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

/**
 * The text "Copy link" actually copies: the link plus spelled-out instructions, so the
 * invite still works if the auto-fill doesn't. Pure so the wording is testable.
 */
export function inviteMessage({ origin, code }) {
    return [
        `You're invited to Weave!`,
        ``,
        `Visit ${origin}/invite/${code} to download the latest installer — the link fills everything in for you.`,
        ``,
        `If anything doesn't fill in by itself:`,
        `  1. Server — copy ${origin} and paste it into the server connection screen after installing.`,
        `  2. Invite — copy ${code} and paste it in during account creation.`,
    ].join('\n');
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
          everything in. Copying includes step-by-step instructions in case it doesn't.</span>
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

/**
 * Security & Recovery.
 *
 * Two forms rather than the `setting` rows the rest of settings is built from, because
 * neither of these is a preference: a preference is remembered, and a password must not be.
 * Nothing here carries `data-setting`, which is what routes a control through set() and
 * into this device's localStorage — the one mistake in this file that would be a real one.
 *
 * A server without the routes keeps the explanation it always had. A form that can only
 * 404 is worse than being told plainly that the server is older than the app.
 */
export function securityPanel({
    question = null, questions = [], features = [], error = null, notice = null,
} = {}) {
    const head = `
    <h2 class="panel-title">Security &amp; Recovery</h2>
    <p class="panel-lead">Your password, and the question that can recover this account if you
      ever forget it.</p>`;

    if (!features.includes('account.security')) {
        return `${head}
    ${notYet('Changing your password', 'This server is older than the app and has no route for it. '
        + 'The forgotten-password link on the sign-in screen still works.')}`;
    }

    const current = question
        ? `You will be asked: ${question.text}`
        : 'This account has no security question yet. Choosing one is the only way to recover '
          + 'it without an administrator.';

    return `${head}
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}
    ${notice ? `<div class="form-message ok show">${esc(notice)}</div>` : ''}

    <h3 class="panel-section">Password</h3>
    <form class="sec-form" data-change-password novalidate>
      <div class="form-message"></div>

      <div class="field">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password" required
               autocomplete="current-password">
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password" required
               autocomplete="new-password" minlength="10">
        <div class="strength" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="field-help strength-label">At least 10 characters.</div>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="confirmPassword">Re-type new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" required
               autocomplete="new-password">
        <div class="field-help match-label"></div>
        <div class="field-error"></div>
      </div>

      <p class="field-help">Your other devices will be signed out. This one will not.</p>
      <button type="submit" class="btn primary">Change password</button>
    </form>

    <h3 class="panel-section">Security question</h3>
    <form class="sec-form" data-change-question novalidate>
      <div class="form-message"></div>
      <p class="panel-lead">${esc(current)}</p>

      <div class="field">
        <label for="securityQuestion">Question</label>
        <select id="securityQuestion" name="securityQuestion" required>
          ${questions.map((q) => `<option value="${esc(q.id)}"${q.id === question?.id ? ' selected' : ''}>${esc(q.text)}</option>`).join('')}
        </select>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="securityAnswer">Your answer</label>
        <input id="securityAnswer" name="securityAnswer" required autocomplete="off"
               placeholder="Biscuit">
        <div class="field-help">Capitals and spacing don't matter. There is no email reset, so
          this is the only way back in on your own.</div>
        <div class="field-error"></div>
      </div>

      <button type="submit" class="btn">Save question</button>
    </form>`;
}

/** Bytes, in the units somebody reads rather than the ones a computer counts in. */
const sizeOf = (text) => {
    const bytes = new TextEncoder().encode(String(text ?? '')).length;
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Report a Bug.
 *
 * Two rules this screen exists to keep. The redaction happens on this machine, in the main
 * process, before the renderer ever sees the text — so what is shown here IS what would be
 * sent, not a promise about it. And nothing leaves until somebody presses the button: the
 * log is gathered when the screen opens so it can be read, not so it can be uploaded.
 *
 * The report goes to the server this person is signed in to, never to us. Self-hosted
 * software sending diagnostics to its author by default is not a thing anybody asked for,
 * and the person who can act on the report is whoever runs the server.
 */
export function bugPanel({
    features = [], description = '', log = null, logAvailable = false, showLog = false,
    sending = false, sent = false, error = null, serverName = '',
} = {}) {
    const head = `
    <h2 class="panel-title">Report a Bug</h2>
    <p class="panel-lead">Tell ${serverName ? esc(serverName) : 'this server'}'s administrator what
      happened. The report goes to them — never to anyone else.</p>`;

    if (!features.includes('diagnostics.bug-report')) {
        return `${head}
    ${notYet('Reporting a bug', 'This server has no diagnostics module switched on, so there is '
        + 'nowhere for a report to land.')}`;
    }

    if (sent) {
        return `${head}
    <div class="form-message ok show">Thank you — your report has been sent.</div>
    <p class="panel-lead">An administrator will see it alongside what the server was doing at
      the time. Nothing else was sent.</p>
    <button type="button" class="btn" data-bug-again>Report something else</button>`;
    }

    const attached = logAvailable && log
        ? `<p class="field-help">Attached: ${esc(sizeOf(log))} of this app's log, with paths,
             tokens and passwords already removed on this machine.
             <button type="button" class="linkish" data-bug-toggle-log>${showLog ? 'Hide it' : 'Show me exactly what will be sent'}</button></p>
           ${showLog ? `<pre class="bug-log" tabindex="0">${esc(log)}</pre>` : ''}`
        : `<p class="field-help">No log is attached — this build keeps none that it can read.
             Your description is the report.</p>`;

    return `${head}
    ${error ? `<div class="form-message error show">${esc(error)}</div>` : ''}

    <form class="sec-form" data-bug-report novalidate>
      <div class="form-message"></div>

      <div class="field">
        <label for="bugDescription">What happened?</label>
        <textarea id="bugDescription" name="description" rows="7" maxlength="4000"
                  placeholder="What you were doing, what you expected, and what happened instead."
                  required>${esc(description)}</textarea>
        <div class="field-help">What you were doing, what you expected, and what happened
          instead. A time helps, and so does whether anyone else saw it.</div>
        <div class="field-error"></div>
      </div>

      ${attached}

      <button type="submit" class="btn primary" ${sending ? 'disabled' : ''}>
        ${sending ? 'Sending…' : 'Send report'}
      </button>
    </form>`;
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
    notifications: 'Weave does not track unread messages or mentions yet, so there is nothing to notify '
        + 'you about.',
    privacy: 'Blocking someone has to be enforced by the server or it is only cosmetic. That work has '
        + 'not been done.',
};

/* ── the frame ────────────────────────────────────────────────────────────── */

const navItem = (item, current) => `
  <button type="button" class="nav-item${item.id === current ? ' current' : ''}${item.danger ? ' danger' : ''}"
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
          ${SECTIONS.filter((section) => !section.adminOnly || me.isAdmin).map((section) => `
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
