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

import { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme, protocol, net, desktopCapturer, powerMonitor } from 'electron';
import crypto from 'node:crypto';
// Both of these are CommonJS. A named import from CJS depends on Node's module lexer
// spotting the export in compiled output, which is not something to rely on in a process
// whose only failure mode is a dialog that says "Error". Default-import and destructure.
import electronUpdater from 'electron-updater';
// The bare "electron-log" entry has a `browser` condition and can resolve to the renderer
// build. The main process wants the main build, explicitly.
import log from 'electron-log/main';

const { autoUpdater } = electronUpdater;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/* ── serving the renderer ─────────────────────────────────────────────────── */

/**
 * The app is served from weave://app/ rather than from file://.
 *
 * This is not cosmetic. A file:// page has an OPAQUE origin, and Chromium refuses storage
 * to opaque origins — localStorage throws SecurityError on every call. Our storage helper
 * catches and returns a fallback, by design, so the failure is completely silent: the app
 * appears to work, and simply forgets your servers and your settings every time it closes.
 *
 * A registered scheme that is `standard` and `secure` gets a real origin, so storage works,
 * and it brings the rest of a secure context with it. It also removes file:// path handling
 * from the equation entirely, which is one fewer way to read something we did not intend to
 * serve.
 *
 * This registration MUST happen before the app is ready, which is why it sits at module
 * scope rather than inside whenReady.
 */
const SCHEME = 'weave';

protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const rendererRoot = join(here, '..', 'dist-electron', 'renderer');

function serveRenderer() {
    protocol.handle(SCHEME, async (request) => {
        const { pathname } = new URL(request.url);
        const target = normalize(join(rendererRoot, decodeURIComponent(pathname)));

        // Nothing outside the renderer directory is servable, whatever the URL claims.
        // Without this, "weave://app/../../../../secrets" is a file read.
        if (!target.startsWith(normalize(rendererRoot))) {
            log.warn({ evt: 'protocol.escape', url: request.url }, 'Blocked a path escaping the renderer root');
            return new Response('Not found', { status: 404 });
        }

        try {
            return await net.fetch(pathToFileURL(target).toString());
        } catch (err) {
            log.error({ evt: 'protocol.miss', target, err }, 'Renderer asset could not be served');
            return new Response('Not found', { status: 404 });
        }
    });
}

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
    win.once('ready-to-show', () => {
        // Launch filling the screen. maximize() before show() means one paint at the
        // final size instead of a small window visibly snapping open.
        win.maximize();
        win.show();
    });

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
            : target.protocol === `${SCHEME}:`;
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

    // Screen sharing: Chromium asks the embedder which surface to capture, and with no
    // handler the request simply fails. The renderer shows OUR picker (thumbnails from
    // desktopCapturer), answers with a source id, and 'loopback' brings the system audio
    // Windows can capture. No answer within a minute reads as a cancel — a hung picker
    // must not leave a pending capture request forever.
    win.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
        let done = false;
        // Declining is the awkward half of this API. Electron has no "no thanks" value: a
        // result without a video source raises `TypeError: Video was requested, but no video
        // stream was provided` out of the native binding -- and because that lands in an IPC
        // listener or a timer rather than in the try below, it reached the top and killed the
        // app. Verified against Electron 43: the throw is cosmetic. The request IS completed,
        // and the renderer's getDisplayMedia() rejects with AbortError, which is exactly what
        // a cancel should look like. So swallow it, and let a genuine failure be logged.
        const finish = (result) => {
            if (done) return;
            done = true;
            try {
                callback(result);
            } catch (err) {
                if (result?.video) {
                    log.error({ evt: 'share.callback_failed', err: String(err) }, 'Capture callback rejected a real source');
                } else {
                    log.info({ evt: 'share.declined' }, 'Screen share cancelled');
                }
            }
        };
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 320, height: 180 },
                fetchWindowIcons: false,
            });
            const nonce = crypto.randomUUID();
            const timer = setTimeout(() => { ipcMain.removeAllListeners(`weave:share-answer:${nonce}`); finish({}); }, 60_000);
            ipcMain.once(`weave:share-answer:${nonce}`, (_event, answer) => {
                clearTimeout(timer);
                const source = sources.find((entry) => entry.id === answer?.id);
                if (!source) return finish({});
                finish({ video: source, ...(answer.audio ? { audio: 'loopback' } : {}) });
            });
            win.webContents.send('weave:share-pick', {
                nonce,
                sources: sources.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    kind: entry.id.startsWith('screen') ? 'screen' : 'window',
                    thumb: entry.thumbnail.toDataURL(),
                })),
            });
        } catch (err) {
            log.warn({ evt: 'share.sources_failed', err: String(err) }, 'Could not enumerate capture sources');
            finish({});
        }
    }, { useSystemPicker: false });

    // Media is requested explicitly by the app itself and allowed. Writing to the
    // clipboard is what the invite "Copy" button does — denying it made that button
    // silently dead on desktop while working in a browser. Reading the clipboard stays
    // refused, along with geolocation, MIDI and everything else nothing here uses.
    const GRANTED = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(GRANTED.has(permission));
    });

    if (isDev) {
        win.loadURL('http://localhost:5173');
    } else {
        win.loadURL(`${SCHEME}://app/index.html`);
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
const secretFile = (name) => join(app.getPath('userData'), name);

/**
 * Read an encrypted store.
 *
 * Tokens and saved credentials live in separate files on purpose. They have different
 * lifetimes and different consequences: a token expires and can be revoked server-side,
 * whereas a saved password opens the account until it is changed. Signing out should be
 * able to drop one without touching the other.
 */
async function readSecrets(name) {
    try {
        const blob = await readFile(secretFile(name));
        if (!safeStorage.isEncryptionAvailable()) return {};
        return JSON.parse(safeStorage.decryptString(blob));
    } catch {
        // Missing, corrupt, or written by a different OS user. All three mean "nothing
        // saved", and all three are recovered from by signing in again.
        return {};
    }
}

async function writeSecrets(name, map) {
    if (!safeStorage.isEncryptionAvailable()) {
        // Refusing is the right answer. Writing a plaintext password to disk because the OS
        // keyring is unavailable would silently downgrade the guarantee the user was given
        // when they ticked the box.
        log.warn({ evt: 'secrets.unavailable', store: name }, 'OS encryption unavailable; not persisting');
        return false;
    }
    await mkdir(dirname(secretFile(name)), { recursive: true });
    await writeFile(secretFile(name), safeStorage.encryptString(JSON.stringify(map)), { mode: 0o600 });
    return true;
}

const readTokens = () => readSecrets('tokens.dat');
const writeTokens = (map) => writeSecrets('tokens.dat', map);

/* ── updates ──────────────────────────────────────────────────────────────── */

const toRenderer = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

let updateState = { status: 'idle' };

/** Bytes actually pulled over the wire this update, for the differential check below. */
let transferred = 0;
let expectedFullSize = null;

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

    // We ship a single self-contained installer, not the two-part web installer. Saying so
    // silences a warning on every check and locks in the behaviour before the default
    // flips in a later release.
    autoUpdater.disableWebInstaller = true;

    // Differential download stays ON. It is what makes an update a megabyte instead of a
    // hundred: the updater fetches only the blocks that changed, using HTTP range requests
    // against the previous installer cached at
    // %LOCALAPPDATA%/<updaterCacheDirName>/installer.exe. There is no baseline to diff
    // against on the first update after a fresh install, so that one is always full.
    autoUpdater.disableDifferentialDownload = false;

    autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => setUpdateState({ status: 'current' }));

    autoUpdater.on('update-available', (info) => {
        transferred = 0;
        expectedFullSize = null;
        setUpdateState({ status: 'downloading', version: info?.version ?? null, percent: 0 });
    });

    autoUpdater.on('download-progress', (p) => {
        transferred = p?.transferred ?? transferred;
        if (p?.total) expectedFullSize = p.total;
        setUpdateState({
            status: 'downloading',
            version: updateState.version ?? null,
            percent: Math.round(p?.percent ?? 0),
            bytesPerSecond: Math.round(p?.bytesPerSecond ?? 0),
            transferred,
            total: p?.total ?? 0,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        // Whether the delta actually worked is otherwise a matter of faith. This line turns
        // it into a number: a differential update transfers a fraction of the installer,
        // a full one transfers all of it.
        const full = info?.files?.[0]?.size ?? expectedFullSize;
        updaterLog.info('Update downloaded', {
            version: info?.version ?? null,
            transferredBytes: transferred,
            fullInstallerBytes: full ?? null,
            differential: full ? transferred < full * 0.9 : null,
            savedPercent: full ? Number((100 - (transferred / full) * 100).toFixed(1)) : null,
        });
        setUpdateState({ status: 'ready', version: info?.version ?? null });
    });

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

    /**
     * Saved sign-in details, for the "Remember me" box.
     *
     * A stored password is a reusable credential — it opens the account until it is changed,
     * and unlike a session it cannot be revoked from the server. So it goes in the OS
     * credential store, encrypted with a key bound to this Windows account, rather than in
     * a file anything can read. Copying it to another machine yields nothing.
     *
     * Keyed per server, like everything else: one server's credentials must never be
     * offered to another.
     */
    ipcMain.handle('weave:credentials.get', async (_e, serverId) =>
        (await readSecrets('credentials.dat'))[serverId] ?? null);

    ipcMain.handle('weave:credentials.set', async (_e, serverId, username, password) => {
        const map = await readSecrets('credentials.dat');
        map[serverId] = { username: String(username), password: String(password) };
        return writeSecrets('credentials.dat', map);
    });

    ipcMain.handle('weave:credentials.clear', async (_e, serverId) => {
        const map = await readSecrets('credentials.dat');
        delete map[serverId];
        return writeSecrets('credentials.dat', map);
    });

    /**
     * Seconds since the last keyboard or mouse input, ANYWHERE on this machine.
     *
     * This is the signal the away feature always wanted and could never have from a
     * browser. It counts input to every application, which is the point: somebody writing
     * code in another window is at their desk, and the old measure — silence on their
     * microphone — called that person absent.
     *
     * Synchronous on purpose. It is read once per heartbeat, it is a single OS call, and
     * making it a promise would mean the ping either waits for it or races it.
     */
    ipcMain.on('weave:power.idleSeconds', (event) => {
        try {
            event.returnValue = powerMonitor.getSystemIdleTime();
        } catch {
            // Not every platform implements it. Saying "I cannot tell you" is correct and
            // leaves the server on its older signal, where reporting 0 would pin this
            // person permanently active.
            event.returnValue = null;
        }
    });

    ipcMain.handle('weave:update.state', () => updateState);

    ipcMain.handle('weave:update.checkNow', () => {
        // The same sequence launch runs: listeners are already registered, so every
        // outcome flows to the banner exactly as a boot-time check would.
        return autoUpdater.checkForUpdates()
            .then((r) => ({ started: true, version: r?.updateInfo?.version ?? null }))
            .catch((err) => {
                updaterLog.error('Manual update check threw', err);
                return { started: false, message: String(err?.message ?? err) };
            });
    });

    ipcMain.handle('weave:update.install', () => {
        if (updateState.status !== 'ready') return false;
        // Both arguments matter, and the bare call gets both wrong.
        //
        //   isSilent = true         no NSIS progress window flashing up. The default is
        //                           false, which shows one - and the update is already
        //                           downloaded and verified, so there is nothing for that
        //                           window to tell anyone.
        //   isForceRunAfter = true  come back afterwards. Without it the app quits, installs
        //                           and stays quit, which reads as a crash.
        //
        // The quit-time path (autoInstallOnAppQuit) is silent already; this is the path
        // taken when somebody presses Restart now.
        autoUpdater.quitAndInstall(true, true);
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

    // ── weave:// deep links ──────────────────────────────────────────────────
    // The invite page's "Open in Weave" button. Registration is per-user (HKCU), so it
    // needs no elevation and no signing. In dev the running binary is electron.exe with
    // an argument, which needs the explicit form.
    if (app.isPackaged) {
        app.setAsDefaultProtocolClient('weave');
    } else if (process.argv[1]) {
        app.setAsDefaultProtocolClient('weave', process.execPath, [resolve(process.argv[1])]);
    }

    const deepLinkIn = (argv) => argv.find((a) => typeof a === 'string' && a.startsWith('weave://')) ?? null;
    let pendingDeepLink = deepLinkIn(process.argv);

    const forwardDeepLink = (url) => {
        if (!url || !win) return;
        // The renderer validates the URL itself; this just delivers the string.
        win.webContents.send('weave:deep-link', url);
        if (win.isMinimized()) win.restore();
        win.focus();
    };

    // One instance owns the protocol: a second launch (the OS opening a link while the
    // app runs) hands its argv to the first and exits.
    const primaryInstance = app.requestSingleInstanceLock();
    if (!primaryInstance) app.quit();
    app.on('second-instance', (_event, argv) => {
        forwardDeepLink(deepLinkIn(argv));
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });

    if (primaryInstance) app.whenReady().then(() => {
        log.info({ evt: 'app.start', version: app.getVersion(), packaged: app.isPackaged },
            `Weave ${app.getVersion()} starting`);
        registerBridge();
        serveRenderer();
        createWindow();
        startUpdateCheck();

        // A cold start FROM the link: the renderer is not listening yet, so the URL
        // waits for the page to finish loading rather than being fired into the void.
        if (pendingDeepLink) {
            const url = pendingDeepLink;
            pendingDeepLink = null;
            win?.webContents.once('did-finish-load', () => forwardDeepLink(url));
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
