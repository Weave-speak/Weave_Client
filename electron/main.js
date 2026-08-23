// Bootstrap.
//
// This file does one thing before the application exists: make sure that if starting up
// fails, somebody can find out why.
//
// It is separate from app.js because ES module imports are hoisted. Anything that throws
// while the module graph is being evaluated — a bad import, a package that resolved to its
// browser build, a native module compiled for the wrong Electron — happens BEFORE the first
// line of a normal main file runs, so no handler installed there can catch it. On Windows,
// where Electron is a GUI subsystem binary with no attached console, the result is a window
// titled "Error" and absolutely nothing else. That is not a bug report anyone can act on.
//
// So: install the handlers, then load the app dynamically. A dynamic import is evaluated
// when it is called rather than hoisted, which is the whole point.

import { app, dialog } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Where a startup crash goes.
 *
 * The temp directory, deliberately: `app.getPath('userData')` may not be resolvable yet,
 * and a crash log that cannot be written is worth nothing. Once the app is up, electron-log
 * takes over and writes somewhere more sensible.
 */
function crashLogPath() {
    try {
        const dir = join(tmpdir(), 'weave');
        mkdirSync(dir, { recursive: true });
        return join(dir, 'startup-crash.log');
    } catch {
        return join(tmpdir(), 'weave-startup-crash.log');
    }
}

function recordCrash(stage, err) {
    const detail = err?.stack ?? String(err);
    const line = `[${new Date().toISOString()}] ${stage}: ${detail}\n`;
    try {
        appendFileSync(crashLogPath(), line);
    } catch {
        // Nothing further to try. The dialog below is the last resort.
    }
    return detail;
}

process.on('uncaughtException', (err) => {
    const detail = recordCrash('uncaughtException', err);
    // A dialog only once the app can show one. Before then the log is all there is.
    if (app.isReady()) {
        dialog.showErrorBox('Weave could not start', `${detail}\n\nLogged to ${crashLogPath()}`);
    }
    app.exit(1);
});

process.on('unhandledRejection', (reason) => {
    recordCrash('unhandledRejection', reason);
});

try {
    await import('./app.js');
} catch (err) {
    const detail = recordCrash('startup', err);
    await app.whenReady().catch(() => {});
    dialog.showErrorBox('Weave could not start', `${detail}\n\nLogged to ${crashLogPath()}`);
    app.exit(1);
}
