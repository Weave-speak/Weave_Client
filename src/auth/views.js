// Markup for the authentication screens.
//
// Kept separate from the behaviour so the shapes can be read at a glance. Every view is a
// pure function of state — nothing here touches the network or the store.

import { esc } from '../ui/dom.js';
import { platform } from '../platform/index.js';
import { displayAddress } from '../server/address.js';

const mark = `
  <span class="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 14c2.5 0 2.5-4 5-4s2.5 4 5 4 2.5-4 5-4 2.5 4 3 4"/>
    </svg>
  </span>`;

/** The gear only exists where a server can actually be chosen. */
const gear = () => (platform.canChooseServer ? `
  <button type="button" class="icon-btn card-gear" data-open-servers
          title="Servers" aria-label="Manage servers">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2"/>
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>
    </svg>
  </button>` : '');

/** Shown above the fields, but only when there is genuinely a choice to make. */
function serverPicker(servers, activeId) {
    if (!platform.canChooseServer || servers.length < 2) return '';
    return `
    <div class="field">
      <label for="serverPick">Server</label>
      <select id="serverPick" name="server" class="server-pick">
        ${servers.map((s) => `
          <option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>
            ${esc(s.label)} · ${esc(displayAddress(s.origin))}
          </option>`).join('')}
      </select>
    </div>`;
}

export function signIn({ servers = [], activeId = null, instanceName = null } = {}) {
    return `
    <form class="card auth-card" id="signInForm" novalidate>
      ${gear()}
      <div class="card-lead">
        ${mark}
        <span class="wordmark">Weave</span>
      </div>
      <h1>Welcome back</h1>
      <p class="lead-sub">${instanceName ? `Signing in to ${esc(instanceName)}.` : 'Voice for small crews. Hop in.'}</p>

      <div class="form-message"></div>
      ${serverPicker(servers, activeId)}

      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" autocapitalize="none"
               spellcheck="false" required placeholder="ghostbyte">
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <div class="field-error"></div>
      </div>

      ${platform.credentials.available ? `
      <label class="check-row">
        <input type="checkbox" name="remember">
        <span>Remember me next time <em>(saved to this Windows account only)</em></span>
      </label>` : ''}

      <label class="check-row">
        <input type="checkbox" name="autoJoin" checked>
        <span>Drop me straight in <em>— joins a room for you</em></span>
      </label>

      <button class="btn primary wide" type="submit">
        Sign In <span aria-hidden="true">→</span>
      </button>

      <p class="card-links">
        <a href="#/register" data-nav>Register</a>
        <span class="dot">·</span>
        <a href="#/forgot" data-nav>Forgot Password</a>
      </p>

      <p class="card-foot">Self-hosted · Your crew, your rules</p>
    </form>`;
}

export function register({ questions = [], instanceName = null } = {}) {
    return `
    <form class="card auth-card wide-card" id="registerForm" novalidate>
      <h1>Thread yourself in</h1>
      <p class="lead-sub">
        ${esc(instanceName ?? 'Weave')} is invite-only. One code, one account.
      </p>

      <div class="form-message"></div>

      <div class="field">
        <label for="inviteCode">Invite Code</label>
        <input id="inviteCode" name="inviteCode" class="code-input" required
               autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">
        <div class="field-error"></div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="regUsername">Username</label>
          <input id="regUsername" name="username" required autocomplete="username"
                 autocapitalize="none" spellcheck="false" placeholder="ghostbyte">
          <div class="field-help">Letters, digits, dots, hyphens. No spaces.</div>
          <div class="field-error"></div>
        </div>
        <div class="field">
          <label for="displayName">Display Name <span class="optional">(optional)</span></label>
          <input id="displayName" name="displayName" autocomplete="nickname" placeholder="Ghostbyte">
          <div class="field-help">What everyone else sees.</div>
          <div class="field-error"></div>
        </div>
      </div>

      <div class="field">
        <label for="regPassword">Password</label>
        <input id="regPassword" name="password" type="password" required
               autocomplete="new-password" minlength="10">
        <div class="strength" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="field-help strength-label">At least 10 characters.</div>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="question">Security Question</label>
        <select id="question" name="securityQuestion" required>
          <option value="" disabled selected>Choose a question…</option>
          ${questions.map((q) => `<option value="${esc(q.id)}">${esc(q.text)}</option>`).join('')}
        </select>
        <div class="field-help">
          You will be asked this if you ever forget your password. There is no email reset.
        </div>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="answer">Your Answer</label>
        <input id="answer" name="securityAnswer" required autocomplete="off" placeholder="Biscuit">
        <div class="field-help">Capitals and spacing don't matter.</div>
        <div class="field-error"></div>
      </div>

      <button class="btn primary wide" type="submit">Complete</button>
      <p class="card-links"><a href="#/signin" data-nav>← Back to Sign In</a></p>
    </form>`;
}

/** Step one: who are you. */
/**
 * Shown when a sign-in comes back `resetRequired`: an administrator reset this account's
 * password. The old password already proved the account — this card asks only for the
 * new one, and says WHY it is being asked, because being bounced here unexplained reads
 * as a hack.
 */
export function chooseNewPassword({ username = '', instanceName = null } = {}) {
    return `
    <form class="card auth-card" id="resetRequiredForm" novalidate>
      <div class="card-lead">
        ${mark}
        <span class="wordmark">Weave</span>
      </div>
      <h1>Choose a new password</h1>
      <p class="lead-sub">An administrator${instanceName ? ` of ${esc(instanceName)}` : ''} reset the password
        for <strong>${esc(username)}</strong>. Pick a new one to finish signing in — your old password
        no longer opens anything.</p>

      <div class="form-message"></div>

      <div class="field">
        <label for="newPassword">New password</label>
        <input id="newPassword" name="password" type="password" autocomplete="new-password"
               required minlength="10" autofocus>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="newPassword2">Repeat it</label>
        <input id="newPassword2" name="confirm" type="password" autocomplete="new-password" required>
        <div class="field-error"></div>
      </div>

      <button class="btn primary wide" type="submit">
        Set password &amp; sign in <span aria-hidden="true">→</span>
      </button>

      <p class="card-links">
        <a href="#/signin" data-nav>← Back to sign in</a>
      </p>
    </form>`;
}

export function forgotUsername() {
    return `
    <form class="card auth-card" id="forgotForm" novalidate data-step="username">
      <h1>Forgot your password?</h1>
      <p class="lead-sub">Enter your username and we'll ask your security question.</p>

      <div class="form-message"></div>
      <div class="steps"><i class="on"></i><i></i><i></i></div>

      <div class="field">
        <label for="forgotUser">Username</label>
        <input id="forgotUser" name="username" required autocomplete="username"
               autocapitalize="none" spellcheck="false">
        <div class="field-error"></div>
      </div>

      <button class="btn primary wide" type="submit">Continue</button>
      <p class="card-links"><a href="#/signin" data-nav>← Back to Sign In</a></p>
    </form>`;
}

/** Step two: prove it. */
export function forgotAnswer({ question, username }) {
    return `
    <form class="card auth-card" id="forgotForm" novalidate data-step="answer">
      <h1>${esc(question.text)}</h1>
      <p class="lead-sub">Answer the question you chose when you created your account.</p>

      <div class="form-message"></div>
      <div class="steps"><i class="on"></i><i class="on"></i><i></i></div>

      <input type="hidden" name="username" value="${esc(username)}">
      <input type="hidden" name="questionId" value="${esc(question.id)}">

      <div class="field">
        <label for="forgotAnswer">Your answer</label>
        <input id="forgotAnswer" name="answer" required autocomplete="off" autofocus>
        <div class="field-help">Capitals and spacing don't matter.</div>
        <div class="field-error"></div>
      </div>

      <button class="btn primary wide" type="submit">Continue</button>
      <p class="card-links">
        <a href="#/forgot" data-nav>← Use a different username</a>
      </p>
    </form>`;
}

/** Step three: a new password, typed twice. */
export function forgotReset({ username, questionId, answer }) {
    return `
    <form class="card auth-card" id="forgotForm" novalidate data-step="reset">
      <h1>Choose a new password</h1>
      <p class="lead-sub">Almost done. Pick something you'll remember.</p>

      <div class="form-message"></div>
      <div class="steps"><i class="on"></i><i class="on"></i><i class="on"></i></div>

      <input type="hidden" name="username" value="${esc(username)}">
      <input type="hidden" name="questionId" value="${esc(questionId)}">
      <input type="hidden" name="answer" value="${esc(answer)}">

      <div class="field">
        <label for="newPassword">New Password</label>
        <input id="newPassword" name="newPassword" type="password" required
               autocomplete="new-password" minlength="10">
        <div class="strength" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="field-help strength-label">At least 10 characters.</div>
        <div class="field-error"></div>
      </div>

      <div class="field">
        <label for="confirmPassword">Re-type New Password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" required
               autocomplete="new-password">
        <div class="field-help match-label"></div>
        <div class="field-error"></div>
      </div>

      <button class="btn primary wide" type="submit" disabled>Update Password</button>
      <p class="card-links"><a href="#/signin" data-nav>← Back to Sign In</a></p>
    </form>`;
}

/**
 * The first thing a blank app shows, and the gear panel afterwards.
 *
 * Usually desktop only. The browser build reaches it in one case: the page was not served
 * by a Weave server, so there is no origin to inherit and the app has to ask.
 */
export function servers({ list = [], activeId = null, firstRun = false, servedElsewhere = false } = {}) {
    // Saying WHY turns a surprising screen into an explained one. Without this line, a
    // browser user who expected to land on a login form just sees the wrong screen.
    const lead = !firstRun
        ? 'Add another server, or switch between the ones you use.'
        : servedElsewhere
            ? 'This page wasn\'t served by a Weave server, so it can\'t sign you in on its own. '
              + 'Enter the address of the server you want to use.'
            : 'Weave doesn\'t run in the cloud. Point this app at the server your crew uses.';

    return `
    <form class="card auth-card" id="serversForm" novalidate>
      <h1>${firstRun ? 'Connect to a server' : 'Servers'}</h1>
      <p class="lead-sub">${esc(lead)}</p>

      <div class="form-message"></div>

      ${list.length ? `
        <ul class="server-list">
          ${list.map((s) => `
            <li class="server-row ${s.id === activeId ? 'active' : ''}" data-server="${esc(s.id)}">
              <button type="button" class="server-pick-btn" data-use="${esc(s.id)}">
                <span class="server-name">${esc(s.label)}</span>
                <span class="server-origin">${esc(displayAddress(s.origin))}</span>
              </button>
              <button type="button" class="icon-btn danger" data-forget="${esc(s.id)}"
                      title="Forget this server" aria-label="Forget ${esc(s.label)}">✕</button>
            </li>`).join('')}
        </ul>` : ''}

      <div class="field">
        <label for="serverAddress">${list.length ? 'Add another server' : 'Server address'}</label>
        <input id="serverAddress" name="address" required autocomplete="off" spellcheck="false"
               autocapitalize="none" placeholder="weave.example.com">
        <div class="field-help">
          A hostname, or host:port. You can paste a full link if you have one.
        </div>
        <div class="field-error"></div>
      </div>

      <div class="server-result" hidden></div>

      <button class="btn primary wide" type="submit">Connect</button>
      ${list.length ? '<p class="card-links"><a href="#/signin" data-nav>← Back to Sign In</a></p>' : ''}
    </form>`;
}
