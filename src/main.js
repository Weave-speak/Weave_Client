// Entry point.
//
// For now this is the authentication surface plus a placeholder for the room. The room
// itself is the next piece of work: the previous client's 13,700 lines get brought across
// as modules behind the same platform adapter used here.

// The stylesheet is imported here rather than linked from the HTML so that it travels
// through the module graph: vite then hashes it into the build and hot-reloads it in
// development. A bare <link> to a source .css is served as a JS module by the dev
// server and silently applies no rules at all.
import './styles.css';

import { createAuth } from './auth/index.js';
import { platform, VERSION, noteOriginIsWeave } from './platform/index.js';
import { activeServer } from './server/store.js';
import { discover, OUTCOME } from './server/discover.js';
import { createUpdateBanner } from './updates/banner.js';
import { createLink } from './net/link.js';
import { createRoom } from './room/index.js';
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

/**
 * Find out whether the page we are running in was served by a Weave server.
 *
 * Only the browser build needs to ask. A desktop app ships blank and always chooses.
 *
 * The answer decides whether server management exists at all: served BY Weave means the
 * origin is the server and there is nothing to choose, while served by anything else means
 * the app must ask, because a login form aimed at a server that cannot answer is a dead end
 * with no way out of it.
 */
async function locateServer() {
    if (platform.target !== 'browser') return;

    const origin = platform.defaultOrigin();
    const found = await discover(origin);
    noteOriginIsWeave(found.outcome === OUTCOME.OK);
}

/**
 * Send an update failure to the server the user is configured against.
 *
 * Deliberately to THEIR server, not to us. This is self-hosted software: the person who
 * can act on a broken update is whoever runs the server, and shipping diagnostics to a
 * third party by default is not a thing a self-hosted app should do.
 *
 * Returns false rather than throwing — the caller is a button, and a rejected promise
 * there just becomes an unhandled rejection nobody sees.
 */
async function sendDiagnostics(report) {
    const server = activeServer();
    if (!server || !report?.text) return false;
    try {
        // Attributed when possible, anonymous when not. A signed-in report carries the
        // stored token so the server can name the account; the endpoint accepts either,
        // because an updater that broke before sign-in still deserves to be heard.
        const token = await platform.tokens.get(server.id).catch(() => null);
        const response = await fetch(`${server.origin}/api/diagnostics`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            credentials: 'omit',
            body: JSON.stringify({
                kind: 'update-failure',
                client: { version: VERSION, target: platform.target },
                log: report.text,
            }),
        });
        return response.ok;
    } catch {
        // The most likely reason an update failed is that the network is unavailable, which
        // is also the most likely reason this cannot be sent. The log is still on disk.
        return false;
    }
}

/**
 * Hand the window over to the room.
 *
 * The auth surface and the room do not share a frame: one is a card on a quiet field, the
 * other is four columns edge to edge. So the room replaces the app element outright rather
 * than mounting inside the auth shell.
 */
function enterRoom({ api, user, token, server }) {
    const link = createLink({ origin: server.origin, token });

    app.innerHTML = '';
    const room = createRoom({
        mount: app,
        api,
        link,
        user,
        server,
        // What this server actually has switched on, learned during discovery. The settings
        // screen uses it so a section for a disabled module says so rather than 404ing.
        features: server?.lastSeen?.features ?? [],
        onSignedOut() {
            room.destroy();
            boot();
        },
    });

    room.start().catch((err) => {
        // Failing to build the room must not leave a blank window with no way out of it.
        app.innerHTML = safe`
          <div class="app"><main class="stage">
            <div class="card auth-card">
              <h1>Could not open the room</h1>
              <p class="lead-sub">${err?.message ?? 'Something went wrong.'}</p>
              <p class="card-foot">Client ${VERSION} · ${platform.target}</p>
            </div>
          </main></div>`;
    });

    link.connect();
}

async function boot() {
    app.innerHTML = '';
    app.append(html(shell()));

    // Mounted before anything else, so an update that started at launch is already visible
    // while the server probe runs. It reports nothing when there is nothing to report.
    createUpdateBanner({ onSendDiagnostics: sendDiagnostics });

    // Rendered before the probe so a slow or unreachable origin shows something rather than
    // an empty window.
    $('#stage').innerHTML = '<p class="boot-note">Looking for a server…</p>';
    await locateServer();

    const auth = createAuth({
        mount: $('#stage'),
        onSignedIn({ api, user, token, server }) {
            enterRoom({ api, user, token, server });
        },
    });

    const route = () => location.hash.replace('#/', '') || 'signin';
    const show = async () => { await auth.show(route()); refreshServerPill(); };

    await show();
    window.addEventListener('hashchange', show);
    // Adding or switching a server does not change the hash, so navigation alone is not a
    // sufficient signal — the store says when it happened.
    window.addEventListener('weave:server-changed', refreshServerPill);
}

boot();
