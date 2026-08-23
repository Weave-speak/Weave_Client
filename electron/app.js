// The desktop shell.
//
// This process has the powers the renderer deliberately does not: the filesystem, the OS
// credential store, the updater. Everything it exposes goes through a narrow, typed bridge
// in preload.js — the renderer never sees `ipcRenderer`, let alone `require`.
//
// The security posture, and why each part of it matters:
//
//   contextIsolation  the preload's globals live in a separate world, so a script on the
//                     page cannot reach in and rewrite our bridge functions
//   sandbox           the renderer runs in an OS sandbox with no Node at all
//   nodeIntegration   off, obviously, but stated rather than assumed
//   navigation locked the window may only ever show our own renderer; anything else opens
//                     in the user's real browser, where it belongs
//
// That last one is not paranoia. This app takes a server address from the user and renders
// what that server sends back. Treating the window as a general-purpose browser would mean
// a hostile server could navigate it somewhere and inherit whatever the page can do.

import { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme } from 'electron';
// Both of these are CommonJS. A named import from CJS depends on Node's module lexer
// spotting the export in compiled output, which is not something to rely on in a process
// whose only failure mode is a dialog that says "Error". Default-import and destructure.
import electronUpdater from 'electron-updater';
// The bare "electron-log" entry has a `browser` condition and can resolve to the renderer
// build. The main process wants the main build, explicitly.
import log from 'electron-log/main';

const { autoUpdater } = electronUpdater;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/* ── logging ──────────────────────────────────────────────────────────────── */

log.initialize();
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.errorHandler.startCatching({ showDialog: false });

/**
 * The updater gets its own log file.
 *
 * When an update fails, the user needs to send us the reason — and a general application
 * log is both larger than necessary and more likely to contain something they would rather
 * not share. A separate file keeps "send diagnostics" to exactly the relevant lines.
 */
const updaterLog = log.create({ logId: 'updater' });
updaterLog.transports.file.fileName = 'updater.log';
updaterLog.transports.file.maxSize = 2 * 1024 * 1024;
autoUpdater.logger = updaterLog;

/* ── the window ───────────────────────────────────────────────────────────── */

let win = null;

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 620,
        minHeight: 480,
        show: false,
        backgroundColor: '#08070f',      // matches --bg-void, so there is no white flash
        titleBarStyle: 'hidden',
        // Native window controls drawn over our own title bar. Custom buttons would have to
        // reimplement snap layouts, high contrast and the accessibility tree, and would get
        // all three subtly wrong.
        titleBarOverlay: { color: '#08070f', symbolColor: '#9691b0', height: 46 },
        webPreferences: {
            preload: join(here, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            // Voice keeps running when the window is not in front. Chromium otherwise
            // throttles timers in a background window, which stalls audio metering and
            // makes people sound like they have dropped out when they have not.
            backgroundThrottling: false,
        },
    });

    // Shown only once it has something to paint.
    win.once('ready-to-show', () => win.show());

    // "The window is blank" is otherwise an unfalsifiable bug report. These two lines turn
    // it into a log entry that says which file failed and why.
    win.webContents.on('did-finish-load', () =>
        log.info({ evt: 'renderer.loaded', url: win.webContents.getURL() }, 'Renderer loaded'));
    win.webContents.on('did-fail-load', (_e, code, description, url) =>
        log.error({ evt: 'renderer.failed', code, description, url }, 'Renderer failed to load'));
    win.webContents.on('render-process-gone', (_e, details) =>
        log.error({ evt: 'renderer.gone', ...details }, 'Renderer process gone'));

    // The window shows our renderer and nothing else, ever.
    win.webContents.on('will-navigate', (event, url) => {
        const target = new URL(url);
        const allowed = isDev
            ? target.origin === 'http://localhost:5173'
            : target.protocol === 'file:';
        if (!allowed) {
            event.preventDefault();
            log.warn({ url }, 'Blocked in-window navigation');
        }
    });

    // A link to somewhere else opens in the user's own browser, with their extensions,
    // their sessions and their history — not inside our privileged window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Nothing here needs a camera-less permission like geolocation or MIDI. Media is
    // requested explicitly by the app itself and allowed; everything else is refused.
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'media' || permission === 'display-capture');
    });

    if (isDev) {
        win.loadURL('http://localhost:5173');
    } else {
        // Inside the asar this file is at /electron/main.js and the renderer at
        // /dist-electron/renderer/, so the path is relative to the archive root rather than
        // to a build output directory that only exists on the machine that built it.
        win.loadFile(join(here, '..', 'dist-electron', 'renderer', 'index.html'));
    }

    win.on('closed', () => { win = null; });
}

/* ── tokens ───────────────────────────────────────────────────────────────── */

/**
 * Session tokens, encrypted at rest by the OS.
 *
 * `safeStorage` binds the ciphertext to this OS user account, so copying the file to
 * another machine yields nothing. This is the whole reason "stay signed in" is a desktop
 * feature: in a browser the only safe place for a token is memory, because anything in
 * localStorage is readable by any script that reaches the page.
 *
 * Tokens are keyed per server. A client that can reach several servers must never carry
 * one server's credentials to another.
 */
const tokenFile = () => join(app.getPath('userData'), 'tokens.dat');

async function readTokens() {
    try {
        const blob = await readFile(tokenFile());
        if (!safeStorage.isEncryptionAvailable()) return {};
        return JSON.parse(safeStorage.decryptString(blob));
    } catch {
        // Missing, corrupt, or written by a different OS user. All three mean "no tokens",
        // and all three are recovered from by signing in again.
        return {};
    }
}

async function writeTokens(map) {
    if (!safeStorage.isEncryptionAvailable()) {
        // Refusing is the right answer. Writing plaintext tokens to disk because the OS
        // keyring is unavailable would silently downgrade the guarantee the user was given.
        log.warn('OS encryption unavailable; not persisting tokens');
        return false;
    }
    await mkdir(dirname(tokenFile()), { recursive: true });
    await writeFile(tokenFile(), safeStorage.encryptString(JSON.stringify(map)), { mode: 0o600 });
    return true;
}

/* ── updates ──────────────────────────────────────────────────────────────── */

const toRenderer = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

let updateState = { status: 'idle' };

function setUpdateState(next) {
    updateState = next;
    toRenderer('weave:update', next);
}

/**
 * Check for an update at launch, while the login screen is already usable.
 *
 * The listeners are registered BEFORE the check, and that ordering is load-bearing:
 * autoDownload is on by default, so the download begins inside `checkForUpdates()` and a
 * listener attached afterwards receives none of its progress events.
 *
 * Only the payload crosses the bridge. Forwarding an Electron event object would drag its
 * `sender` along with it, which is a live handle to the very thing we are isolating.
 */
function startUpdateCheck() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Every release is a pre-release while the client is still being built. Without this
    // the updater ignores all of them and the app never moves off the version it shipped
    // with — which looks exactly like a broken updater and is much harder to diagnose.
    autoUpdater.allowPrerelease = true;

    autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => setUpdateState({ status: 'current' }));

    autoUpdater.on('update-available', (info) =>
        setUpdateState({ status: 'downloading', version: info?.version ?? null, percent: 0 }));

    autoUpdater.on('download-progress', (p) => setUpdateState({
        status: 'downloading',
        version: updateState.version ?? null,
        percent: Math.round(p?.percent ?? 0),
        bytesPerSecond: Math.round(p?.bytesPerSecond ?? 0),
        transferred: p?.transferred ?? 0,
        total: p?.total ?? 0,
    }));

    autoUpdater.on('update-downloaded', (info) =>
        setUpdateState({ status: 'ready', version: info?.version ?? null }));

    autoUpdater.on('error', (err) => {
        // An update that fails must never stop the app starting. The user still signs in;
        // they just do it on the version they already have.
        updaterLog.error('Update failed', err);
        setUpdateState({
            status: 'failed',
            message: String(err?.message ?? err),
            logPath: updaterLog.transports.file.getFile()?.path ?? null,
        });
    });

    if (isDev) {
        setUpdateState({ status: 'skipped', reason: 'development build' });
        return;
    }
    autoUpdater.checkForUpdates().catch((err) => updaterLog.error('Update check threw', err));
}

/* ── bridge ───────────────────────────────────────────────────────────────── */

function registerBridge() {
    ipcMain.handle('weave:tokens.get', async (_e, serverId) => (await readTokens())[serverId] ?? null);

    ipcMain.handle('weave:tokens.set', async (_e, serverId, token) => {
        const map = await readTokens();
        map[serverId] = token;
        return writeTokens(map);
    });

    ipcMain.handle('weave:tokens.clear', async (_e, serverId) => {
        const map = await readTokens();
        delete map[serverId];
        return writeTokens(map);
    });

    ipcMain.handle('weave:update.state', () => updateState);

    ipcMain.handle('weave:update.install', () => {
        if (updateState.status !== 'ready') return false;
        autoUpdater.quitAndInstall();
        return true;
    });

    /** The updater log, for the "send diagnostics" action. Read here, sent by the renderer
     *  to whichever server the user is configured against — never to us. */
    ipcMain.handle('weave:diagnostics.read', async () => {
        const file = updaterLog.transports.file.getFile();
        if (!file?.path) return null;
        try {
            const text = await readFile(file.path, 'utf8');
            return { path: file.path, text: redact(text) };
        } catch (err) {
            log.warn('Could not read the updater log', err);
            return null;
        }
    });

    ipcMain.handle('weave:app.info', () => ({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        packaged: app.isPackaged,
        logDir: dirname(log.transports.file.getFile()?.path ?? ''),
    }));

    ipcMain.handle('weave:app.openLogFolder', () => {
        const file = log.transports.file.getFile();
        if (file?.path) shell.showItemInFolder(file.path);
    });

    ipcMain.on('weave:log', (_e, level, message, meta) => {
        const fn = log[level] ?? log.info;
        fn.call(log, message, meta ?? '');
    });
}

/**
 * Strip anything that should not leave the machine.
 *
 * A diagnostics bundle is only useful if people are willing to send it, and they are only
 * willing if it does not carry their name or their credentials. Applied in the main process
 * so the renderer never handles the unredacted text at all.
 */
export function redact(text) {
    return String(text)
        // Bearer tokens and anything that looks like one.
        .replace(/\b(token|authorization|bearer|password|secret)["'\s:=]+\S+/gi, '$1=[redacted]')
        // Windows and POSIX home directories, which carry the account name.
        .replace(/[A-Za-z]:\\Users\\[^\\/\r\n"']+/g, 'C:\\Users\\[user]')
        .replace(/\/(?:home|Users)\/[^/\r\n"']+/g, '/home/[user]');
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

// A second launch focuses the window that already exists rather than opening another one
// pointed at the same token store.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    nativeTheme.themeSource = 'dark';

    app.whenReady().then(() => {
        log.info({ evt: 'app.start', version: app.getVersion(), packaged: app.isPackaged },
            `Weave ${app.getVersion()} starting`);
        registerBridge();
        createWindow();
        startUpdateCheck();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
