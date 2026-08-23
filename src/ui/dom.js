// Small DOM helpers.
//
// No framework. The screens here are forms, and a form is the one thing plain DOM has
// always been good at — the whole auth surface is a few hundred lines this way, with no
// build step beyond bundling and nothing to learn before changing it.

/** Escape anything interpolated into markup. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Build an element from markup. Only ever called with markup we wrote. */
export function html(markup) {
    const template = document.createElement('template');
    template.innerHTML = markup.trim();
    return template.content.firstElementChild;
}

export function on(root, selector, event, handler) {
    const el = typeof selector === 'string' ? $(selector, root) : selector;
    if (el) el.addEventListener(event, handler);
    return el;
}

/**
 * Put a message under a field and mark it wrong.
 *
 * Server-side validation errors carry the field they belong to, so a rejected password
 * can point at the password box rather than appearing as a banner the user has to map
 * back to an input themselves.
 */
export function setFieldError(form, field, message) {
    const input = $(`[name="${field}"]`, form);
    if (!input) return false;

    input.classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');

    const slot = input.closest('.field')?.querySelector('.field-error');
    if (slot) slot.textContent = message;

    input.focus();
    return true;
}

export function clearErrors(form) {
    $$('.invalid', form).forEach((el) => {
        el.classList.remove('invalid');
        el.removeAttribute('aria-invalid');
    });
    $$('.field-error', form).forEach((el) => { el.textContent = ''; });
    const banner = $('.form-message', form);
    if (banner) { banner.textContent = ''; banner.className = 'form-message'; }
}

export function setFormMessage(form, message, kind = 'error') {
    const banner = $('.form-message', form);
    if (!banner) return;
    banner.textContent = message;
    banner.className = `form-message ${kind}${message ? ' show' : ''}`;
}

/** Disable a submit button and say what is happening, so a slow network is not silence. */
export function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
        button.dataset.idleLabel ??= button.textContent;
        button.disabled = true;
        button.classList.add('busy');
        if (busyLabel) button.textContent = busyLabel;
    } else {
        button.disabled = false;
        button.classList.remove('busy');
        if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    }
}

/**
 * How strong a password looks.
 *
 * Deliberately about length and variety rather than a dictionary check: the server's only
 * hard rule is ten characters, and a meter that disagrees with the server would be worse
 * than no meter. This encourages, it does not gate.
 */
export function passwordStrength(password) {
    const value = String(password ?? '');
    if (!value) return { score: 0, label: '' };

    let score = 0;
    if (value.length >= 10) score += 1;
    if (value.length >= 14) score += 1;
    if (value.length >= 20) score += 1;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    if (classes >= 3) score += 1;

    return {
        score: Math.min(4, score),
        label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][Math.min(4, score)],
    };
}
