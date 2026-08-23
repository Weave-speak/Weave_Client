// Modal dialogs.
//
// Built on the native <dialog> element rather than a div with a high z-index, because
// showModal() gives four things for free that are tedious and easy to get subtly wrong by
// hand: Escape closes it, focus is trapped inside it, everything behind it becomes inert to
// both pointer and screen reader, and it renders in the top layer so no stacking context
// anywhere in the app can accidentally cover it.
//
// The hand-rolled version of this is one of the most commonly broken components on the web.
// A keyboard user tabs straight out of the dialog and into a page they cannot see.

import { $ } from './dom.js';

export function createModal({ className = '', label = 'Dialog', onClose = null } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = `modal ${className}`.trim();
    dialog.setAttribute('aria-label', label);

    let opener = null;
    let closed = false;

    // Clicking the backdrop closes it. The check matters: events from children bubble up to
    // the dialog, so testing the target is what distinguishes the backdrop from the content.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    dialog.addEventListener('close', () => {
        closed = true;
        onClose?.();
        // Focus goes back where it came from. Without this it lands on <body>, and a
        // keyboard user has to tab from the top of the app to get back to what they were
        // doing — which is exactly the moment people give up on keyboard navigation.
        try { opener?.focus(); } catch { /* the opener may be gone */ }
        dialog.remove();
    });

    return {
        element: dialog,

        open({ from = null, content = '' } = {}) {
            opener = from ?? document.activeElement;
            dialog.innerHTML = content;
            document.body.append(dialog);
            dialog.showModal();

            // Focus the first thing worth focusing rather than whatever happens to be
            // first in the DOM, which is usually a close button.
            const target = $('[autofocus]', dialog) ?? $('[data-initial-focus]', dialog);
            target?.focus();
            return dialog;
        },

        setContent(markup) { dialog.innerHTML = markup; },
        close() { if (!closed) dialog.close(); },
        get isOpen() { return dialog.open; },
    };
}
