// The update bar.
//
// Pinned to the bottom of the window while an update downloads, with the login screen fully
// usable above it. Updating is something the app does *while* you get on with signing in,
// not a wall you wait behind — a progress dialog on launch is the thing people close their
// laptop over.
//
// Two details that decide whether the bar reads as working or as stuck:
//
//   The renderer usually mounts AFTER the check has already started, because the main
//   process begins at launch. So the bar asks for the current state on mount instead of
//   waiting for an event that has already been and gone.
//
//   Differential updates copy unchanged blocks from the installed version and emit no
//   progress at all while they do. A percentage frozen at 43% for twenty seconds looks
//   broken; an indeterminate shimmer looks busy. So after a short silence the bar stops
//   claiming to know how far along it is.

import { esc } from '../ui/dom.js';
import { platform } from '../platform/index.js';

/** How long a download may go quiet before the bar stops claiming a percentage. */
const STALL_MS = 2500;

const BYTES = ['B', 'KB', 'MB', 'GB'];
function rate(bytesPerSecond) {
    let value = Number(bytesPerSecond) || 0;
    let unit = 0;
    while (value >= 1024 && unit < BYTES.length - 1) { value /= 1024; unit += 1; }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTES[unit]}/s`;
}

/** What the bar says, for each thing the updater can be doing. */
export function describe(update = {}) {
    switch (update.status) {
        case 'checking':
            return { show: true, text: 'Checking for updates…', indeterminate: true };
        case 'downloading':
            return {
                show: true,
                text: update.version ? `Downloading Weave ${update.version}` : 'Downloading update',
                percent: update.percent ?? 0,
                detail: update.bytesPerSecond ? rate(update.bytesPerSecond) : '',
            };
        case 'ready':
            return {
                show: true,
                text: update.version ? `Weave ${update.version} is ready` : 'Update ready',
                percent: 100,
                action: 'restart',
            };
        case 'failed':
            return {
                show: true,
                text: 'Update failed. You can keep using this version.',
                failed: true,
                action: 'diagnose',
            };
        // 'current', 'idle', 'skipped' and 'unsupported' all mean there is nothing to say,
        // and a bar that announces "you are up to date" on every launch is noise.
        default:
            return { show: false };
    }
}

/**
 * The bar's markup, as a pure function of what it is showing.
 *
 * Separate from the component for the same reason every other view in this codebase is:
 * markup built from values belongs in one place where the escaping is visible, rather than
 * inline at an `innerHTML` assignment where it is easy to add one more hole and forget.
 */
export function barMarkup(view, { stalled = false } = {}) {
    const indeterminate = Boolean(view.indeterminate || (stalled && view.percent != null && !view.failed));
    const percent = Math.max(0, Math.min(100, Math.round(view.percent ?? 0)));

    const detail = view.detail && !indeterminate
        ? `<span class="update-detail">${esc(view.detail)}</span>` : '';
    const readout = !indeterminate && view.percent != null && !view.failed
        ? `<span class="update-detail">${esc(percent)}%</span>` : '';
    const action = view.action === 'restart'
        ? '<button type="button" class="update-action" data-restart>Restart now</button>'
        : view.action === 'diagnose'
            ? '<button type="button" class="update-action" data-diagnose>Send diagnostics</button>'
            : '';

    return `
      <div class="update-track">
        <div class="update-fill${indeterminate ? ' indeterminate' : ''}"
             style="width: ${indeterminate ? 100 : percent}%"></div>
      </div>
      <div class="update-row">
        <span class="update-text">${esc(view.text)}</span>
        ${detail}${readout}${action}
      </div>`;
}

export function createUpdateBanner({ mount = document.body, onSendDiagnostics = null } = {}) {
    const el = document.createElement('div');
    el.className = 'update-bar';
    el.hidden = true;
    el.setAttribute('role', 'status');
    mount.append(el);

    let last = { status: 'idle' };
    let stallTimer = null;
    let stalled = false;

    function render() {
        const view = describe(last);
        el.hidden = !view.show;
        if (!view.show) { el.innerHTML = ''; return; }

        el.className = `update-bar${view.failed ? ' failed' : ''}`;
        el.innerHTML = barMarkup(view, { stalled });

        // Progress bars are announced constantly by screen readers unless told otherwise;
        // the text line is the part worth hearing.
        el.querySelector('.update-track')?.setAttribute('aria-hidden', 'true');
    }

    /** A download that has gone quiet is not a download that has stopped. */
    function noteActivity() {
        stalled = false;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { stalled = true; render(); }, STALL_MS);
    }

    function apply(update) {
        last = update ?? { status: 'idle' };
        if (last.status === 'downloading') noteActivity();
        else if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; stalled = false; }
        render();
    }

    el.addEventListener('click', async (event) => {
        if (event.target.closest('[data-restart]')) {
            await platform.updates.install();
        }
        if (event.target.closest('[data-diagnose]')) {
            const button = event.target.closest('[data-diagnose]');
            button.disabled = true;
            button.textContent = 'Sending…';
            const report = await platform.diagnostics.read();
            const ok = await onSendDiagnostics?.(report);
            button.textContent = ok ? 'Sent' : 'Could not send';
        }
    });

    // The check begins at launch, so by the time this mounts it may already be finished.
    platform.updates.state().then(apply).catch(() => {});
    const unsubscribe = platform.updates.onChange(apply);

    return {
        element: el,
        get state() { return last; },
        destroy() {
            unsubscribe?.();
            if (stallTimer) clearTimeout(stallTimer);
            el.remove();
        },
    };
}
