// Entry point.
//
// For now this is the authentication surface plus a placeholder for the room. The room
// itself is the next piece of work: the previous client's 13,700 lines get brought across
// as modules behind the same platform adapter used here.

import { createAuth } from './auth/index.js';
import { platform, VERSION } from './platform/index.js';
import { activeServer } from './server/store.js';
import { displayAddress } from './server/address.js';
import { $, html, safe } from './ui/dom.js';

const app = $('#app');

function shell() {
    return `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark small" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 14c2.5 0 2.5-4 5-4s2.5 4 5 4 2.5-4 5-4 2.5 4 3 4"/>
            </svg>
          </span>
          Weave
        </div>
        <div class="topbar-spacer"></div>
        <span class="server-pill none" id="serverPill">no server</span>
      </header>
      <main class="stage" id="stage"></main>
    </div>`;
}

/**
 * Point the topbar at whatever server is current.
 *
 * Deliberately a function rather than part of `shell()`: the shell is rendered once at
 * boot, which on a first run is before any server exists. Baking the value in there left
 * it reading "no server" permanently, even after one had been added and signed into.
 */
function refreshServerPill() {
    const pill = $('#serverPill');
    if (!pill) return;

    const server = activeServer();
    pill.textContent = server ? displayAddress(server.origin) : 'no server';
    pill.classList.toggle('none', !server);
    pill.title = server ? `${server.label} · ${server.origin}` : 'No server selected yet';
}

function boot() {
    app.innerHTML = '';
    app.append(html(shell()));

    const auth = createAuth({
        mount: $('#stage'),
        onSignedIn({ user, server }) {
            // The room is the next piece. Landing here proves the whole chain works:
            // address -> discovery -> protocol negotiation -> login -> token.
            // A display name is chosen by a person and relayed by a server. Both are
            // outside our control, so both are content rather than markup.
            $('#stage').innerHTML = safe`
              <div class="card auth-card">
                <h1>Signed in</h1>
                <p class="lead-sub">
                  Welcome, ${user.displayName ?? user.username}.
                  You're connected to ${server?.lastSeen?.name ?? 'this server'}.
                </p>
                <p class="card-foot">
                  The room is the next piece of work. Client ${VERSION} · ${platform.target}
                </p>
              </div>`;
            refreshServerPill();
        },
    });

    const route = () => location.hash.replace('#/', '') || 'signin';
    const show = () => { auth.show(route()); refreshServerPill(); };

    show();
    window.addEventListener('hashchange', show);
    // Adding or switching a server does not change the hash, so navigation alone is not a
    // sufficient signal — the store says when it happened.
    window.addEventListener('weave:server-changed', refreshServerPill);
}

boot();
