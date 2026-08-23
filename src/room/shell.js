// The application shell.
//
// Four columns and a title bar, composed from the column views. A pure function of state,
// like everything under views/ — which is what lets the whole layout be rendered from
// fixtures before a socket exists, and asserted on afterwards without a browser.

import { esc } from '../ui/dom.js';
import { icons } from './icons.js';
import { rail } from './views/rail.js';
import { sidebar } from './views/sidebar.js';
import { timeline } from './views/timeline.js';
import { members } from './views/members.js';

/**
 * The connection readout.
 *
 * Deliberately specific. "Connected" alone is the kind of status that is technically true
 * while somebody's audio is breaking up; the round-trip time and the codec are what turn
 * "it feels bad" into something reportable.
 */
export function connection({ state = 'connecting', rttMs = null, codec = null, bitrateKbps = null } = {}) {
    const words = {
        live: 'Connected',
        connecting: 'Connecting…',
        degraded: 'Unstable',
        lost: 'Reconnecting…',
    };

    const parts = [];
    if (state === 'live' && rttMs != null) parts.push(`${Math.round(rttMs)} ms`);
    if (state === 'live' && codec) parts.push(bitrateKbps ? `${esc(codec)} ${esc(bitrateKbps)} kb/s` : esc(codec));

    return `
    <span class="conn-pill" data-state="${esc(state)}" role="status">
      <span class="conn-dot" aria-hidden="true"></span>
      <span>${esc(words[state] ?? words.connecting)}</span>
      ${parts.map((p) => `<span class="conn-sep" aria-hidden="true">·</span><span>${p}</span>`).join('')}
    </span>`;
}

export function shell(state = {}) {
    const room = state.room ?? {};
    return `
    <div class="app-shell">
      <header class="titlebar">
        <span class="app-chip" aria-hidden="true">${icons.weave}</span>
        ${connection(state.connection)}
        <span class="titlebar-spacer"></span>
        <button type="button" class="icon-btn" data-open-settings
                title="Settings" aria-label="Settings">${icons.gear}</button>
      </header>

      <div class="app-body">
        ${rail({ dms: state.dms, inRoom: !state.dmOpen })}
        ${sidebar({ server: state.server, rooms: state.rooms, me: state.me })}
        ${timeline({ room, items: state.items, typing: state.typing, voice: state.voice })}
        ${members({ people: state.people, roomId: room.id })}
      </div>
    </div>`;
}
