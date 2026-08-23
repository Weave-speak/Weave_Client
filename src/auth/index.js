// The authentication flow.
//
// Five screens and the moves between them: sign in, register, three-step password reset,
// and (desktop only) server management.
//
// The one rule that shapes the reset flow: step one always advances, even for a username
// with no account. The server returns a plausible question for an unknown name on purpose,
// so that this endpoint cannot be used to discover who has an account on an invite-only
// server. The client must not undo that by checking whether the account exists first, or
// by wording step two as though it has been confirmed.

import * as views from './views.js';
import { createApi, ApiError } from '../lib/api.js';
import { discover, OUTCOME, CLIENT_PROTOCOL } from '../server/discover.js';
import { displayAddress } from '../server/address.js';
import { platform } from '../platform/index.js';
import {
    listServers, activeServer, setActive, rememberServer, forgetServer, getServer,
} from '../server/store.js';
import {
    $, $$, on, html, safe, clearErrors, setFieldError, setFormMessage, setBusy, passwordStrength,
} from '../ui/dom.js';

export function createAuth({ mount, onSignedIn }) {
    // Carried between reset steps in memory only. It contains an answer to a security
    // question, so it must never reach storage or a URL.
    let reset = null;
    let cachedQuestions = null;

    const server = () => activeServer();
    const apiFor = (origin) => createApi({ origin });

    function render(markup) {
        mount.innerHTML = '';
        mount.append(html(markup));
        wire();
    }

    /* ── routing ─────────────────────────────────────────────────────────── */

    async function show(route) {
        // A desktop app with no server cannot sign in to anything, so it opens on the
        // server screen instead of a login form that could not possibly work.
        if (platform.canChooseServer && !server() && route !== 'servers') {
            return show('servers');
        }

        switch (route) {
            case 'register': {
                const info = server();
                render(views.register({
                    questions: await questions(),
                    instanceName: info?.lastSeen?.name ?? null,
                }));
                break;
            }
            case 'forgot':
                reset = null;
                render(views.forgotUsername());
                break;
            case 'servers':
                render(views.servers({
                    list: listServers(),
                    activeId: server()?.id ?? null,
                    firstRun: listServers().length === 0,
                    servedElsewhere: platform.target === 'browser',
                }));
                break;
            case 'signin':
            default: {
                const current = server();
                render(views.signIn({
                    servers: listServers(),
                    activeId: current?.id ?? null,
                    instanceName: current?.lastSeen?.name ?? null,
                }));
                break;
            }
        }
    }

    async function questions() {
        if (cachedQuestions) return cachedQuestions;
        try {
            const { questions: list } = await apiFor(server().origin).securityQuestions();
            cachedQuestions = list;
        } catch {
            // Registration is still possible without the list only if the server is
            // unreachable, in which case the form will fail anyway — so an empty list here
            // is honest rather than a fallback that pretends.
            cachedQuestions = [];
        }
        return cachedQuestions;
    }

    /* ── wiring ──────────────────────────────────────────────────────────── */

    function wire() {
        $$('[data-nav]', mount).forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                show(link.getAttribute('href').replace('#/', ''));
            });
        });

        on(mount, '[data-open-servers]', 'click', () => show('servers'));

        const picker = $('.server-pick', mount);
        if (picker) {
            picker.addEventListener('change', () => {
                setActive(picker.value);
                show('signin');
            });
        }

        wireStrength();
        wireSignIn();
        wireRegister();
        wireForgot();
        wireServers();
    }

    function wireStrength() {
        const input = $('input[name="password"][autocomplete="new-password"], input[name="newPassword"]', mount);
        const meter = $('.strength', mount);
        const label = $('.strength-label', mount);
        if (!input || !meter) return;

        input.addEventListener('input', () => {
            const { score, label: text } = passwordStrength(input.value);
            $$('i', meter).forEach((bar, i) => bar.classList.toggle('on', i < score));
            meter.dataset.score = String(score);
            if (label) label.textContent = input.value ? text : 'At least 10 characters.';
        });
    }

    /* ── sign in ─────────────────────────────────────────────────────────── */

    function wireSignIn() {
        const form = $('#signInForm', mount);
        if (!form) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearErrors(form);

            const button = $('button[type="submit"]', form);
            const username = form.username.value.trim();
            const password = form.password.value;
            const autoJoin = form.autoJoin.checked;

            if (!username || !password) {
                setFormMessage(form, 'Enter your username and password.');
                return;
            }

            setBusy(button, true, 'Signing in…');
            try {
                const target = server();
                const api = apiFor(target.origin);
                const result = await api.login(username, password);
                api.setToken(result.token);
                // Scoped to this server: a client that can reach several must never carry one
                // server's credentials to another.
                await platform.tokens.set(target.id, result.token).catch(() => {});
                onSignedIn({ api, user: result.user, token: result.token, server: target, autoJoin });
            } catch (err) {
                setBusy(button, false);
                if (err instanceof ApiError && err.field) {
                    setFieldError(form, err.field, err.message);
                } else {
                    setFormMessage(form, err.message);
                }
            }
        });
    }

    /* ── register ────────────────────────────────────────────────────────── */

    function wireRegister() {
        const form = $('#registerForm', mount);
        if (!form) return;

        // Invite codes get pasted in every shape. Reformat as they type rather than
        // rejecting what they pasted.
        const code = form.inviteCode;
        code.addEventListener('input', () => {
            const clean = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
            const grouped = clean.match(/.{1,4}/g)?.join('-') ?? '';
            if (grouped !== code.value) {
                const atEnd = code.selectionStart === code.value.length;
                code.value = grouped;
                if (atEnd) code.setSelectionRange(grouped.length, grouped.length);
            }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearErrors(form);
            const button = $('button[type="submit"]', form);

            const payload = {
                inviteCode: form.inviteCode.value.trim(),
                username: form.username.value.trim(),
                displayName: form.displayName.value.trim() || undefined,
                password: form.password.value,
                securityQuestion: form.securityQuestion.value,
                securityAnswer: form.securityAnswer.value.trim(),
            };

            for (const [field, label] of [
                ['inviteCode', 'Enter your invite code.'],
                ['username', 'Choose a username.'],
                ['password', 'Choose a password.'],
                ['securityQuestion', 'Pick a security question.'],
                ['securityAnswer', 'Answer your security question.'],
            ]) {
                if (!payload[field]) { setFieldError(form, field === 'securityQuestion' ? 'securityQuestion' : field, label); return; }
            }

            setBusy(button, true, 'Creating account…');
            try {
                const target = server();
                const api = apiFor(target.origin);
                const result = await api.register(payload);
                api.setToken(result.token);
                // Scoped to this server: a client that can reach several must never carry one
                // server's credentials to another.
                await platform.tokens.set(target.id, result.token).catch(() => {});
                onSignedIn({ api, user: result.user, token: result.token, server: target, autoJoin: true });
            } catch (err) {
                setBusy(button, false);
                if (err instanceof ApiError && err.field && setFieldError(form, err.field, err.message)) return;
                setFormMessage(form, err.message);
            }
        });
    }

    /* ── forgot password ─────────────────────────────────────────────────── */

    function wireForgot() {
        const form = $('#forgotForm', mount);
        if (!form) return;

        const step = form.dataset.step;
        const button = $('button[type="submit"]', form);

        if (step === 'reset') wireMatch(form, button);

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearErrors(form);

            if (step === 'username') {
                const username = form.username.value.trim();
                if (!username) { setFieldError(form, 'username', 'Enter your username.'); return; }

                setBusy(button, true, 'Checking…');
                try {
                    const { question } = await apiFor(server().origin).recoveryQuestion(username);
                    // Always advances. A username with no account gets a question too —
                    // that is the server refusing to reveal who has an account, and the
                    // client must not leak it back by behaving differently here.
                    reset = { username, question };
                    render(views.forgotAnswer({ question, username }));
                } catch (err) {
                    setBusy(button, false);
                    setFormMessage(form, err.message);
                }
                return;
            }

            if (step === 'answer') {
                const answer = form.answer.value.trim();
                if (!answer) { setFieldError(form, 'answer', 'Enter your answer.'); return; }

                // Not verified here: the server checks the answer and the new password in
                // one call, so there is nothing to check against yet. Carrying the answer
                // forward keeps it to a single round trip and avoids a half-authenticated
                // state that would need its own token.
                reset = { ...reset, answer };
                render(views.forgotReset({
                    username: form.username.value,
                    questionId: form.questionId.value,
                    answer,
                }));
                return;
            }

            const newPassword = form.newPassword.value;
            const confirm = form.confirmPassword.value;

            if (newPassword.length < 10) {
                setFieldError(form, 'newPassword', 'Use at least 10 characters.');
                return;
            }
            if (newPassword !== confirm) {
                setFieldError(form, 'confirmPassword', "These don't match.");
                return;
            }

            setBusy(button, true, 'Updating…');
            try {
                await apiFor(server().origin).recover({
                    username: form.username.value,
                    questionId: form.questionId.value,
                    answer: form.answer.value,
                    newPassword,
                });
                reset = null;
                await show('signin');
                const signInForm = $('#signInForm', mount);
                setFormMessage(signInForm, 'Password updated. Sign in with your new password.', 'ok');
                if (signInForm) signInForm.username.focus();
            } catch (err) {
                setBusy(button, false);
                // A wrong answer only surfaces here, because that is the only call that
                // checks it. Send them back to the question rather than stranding them on
                // a password form that will keep failing.
                if (err instanceof ApiError && err.status === 401) {
                    const { username, question } = reset;
                    render(views.forgotAnswer({ question, username }));
                    setFormMessage($('#forgotForm', mount), 'That answer is not correct.');
                    return;
                }
                setFormMessage(form, err.message);
            }
        });
    }

    /** Live match indicator, and the submit button follows it. */
    function wireMatch(form, button) {
        const a = form.newPassword;
        const b = form.confirmPassword;
        const label = $('.match-label', form);

        const check = () => {
            const long = a.value.length >= 10;
            const same = a.value === b.value;
            const filled = b.value.length > 0;

            if (!filled) {
                label.textContent = '';
                label.className = 'field-help match-label';
            } else if (same) {
                label.textContent = '✓ Passwords match';
                label.className = 'field-help match-label ok';
            } else {
                label.textContent = "✗ Passwords don't match yet";
                label.className = 'field-help match-label bad';
            }
            button.disabled = !(long && same && filled);
        };

        a.addEventListener('input', check);
        b.addEventListener('input', check);
        check();
    }

    /* ── servers ─────────────────────────────────────────────────────────── */

    function wireServers() {
        const form = $('#serversForm', mount);
        if (!form) return;

        $$('[data-use]', form).forEach((btn) => btn.addEventListener('click', () => {
            setActive(btn.dataset.use);
            show('signin');
        }));

        $$('[data-forget]', form).forEach((btn) => btn.addEventListener('click', () => {
            const target = getServer(btn.dataset.forget);
            if (!target) return;
            if (!confirm(`Forget "${target.label}"? Saved settings for it are removed too.`)) return;
            forgetServer(target.id);
            show('servers');
        }));

        const result = $('.server-result', form);
        const button = $('button[type="submit"]', form);

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearErrors(form);
            result.hidden = true;

            const address = form.address.value.trim();
            if (!address) { setFieldError(form, 'address', 'Enter a server address.'); return; }

            setBusy(button, true, 'Checking…');
            const found = await discover(address);
            setBusy(button, false);

            if (found.outcome !== OUTCOME.OK) {
                result.hidden = false;
                result.className = 'server-result bad';
                result.innerHTML = safe`<strong>${found.message}</strong>`
                    + (found.detail ? safe`<span>${found.detail}</span>` : '');
                return;
            }

            // Only remembered once it has answered as a Weave server we can talk to. A list
            // full of addresses that never worked is worse than an empty one.
            const record = rememberServer(found);
            result.hidden = false;
            result.className = 'server-result ok';
            // Every value below is chosen by the server we have only just met. It names
            // itself, and a name is content, never structure.
            result.innerHTML =
                safe`<strong>${found.info.instance.name}</strong>`
                + safe`<span>version ${found.info.version} · `
                + `${found.info.instance.registration === 'invite_only' ? 'invite only' : 'open registration'}</span>`;

            cachedQuestions = null;
            setTimeout(() => show('signin'), 700);
            return record;
        });
    }

    return { show };
}

export { CLIENT_PROTOCOL, displayAddress };
