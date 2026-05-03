/**
 * Oasis Cognition desktop shell — Electron main process.
 *
 * Three windows / surfaces:
 *   1. Main window — the React app (loadFile in prod, loadURL in dev).
 *   2. Quick-prompt window — Cmd+Shift+Space from anywhere on macOS pops
 *      a tiny centered prompt; Enter sends to the gateway, Esc hides.
 *   3. Tray menu — Show / Hide / Quick Prompt / Auto-launch toggle / Quit.
 *
 * Backends are NOT spawned here — `make up` orchestrates those. This shell
 * just talks to localhost ports the React app already uses.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const http = require('http');

const DEV_MODE = process.env.OASIS_DESKTOP_DEV === '1';
const DEV_URL = process.env.OASIS_DESKTOP_DEV_URL || 'http://localhost:3001';
const GATEWAY = process.env.OASIS_GATEWAY_URL || 'http://localhost:8000';
const QUICK_HOTKEY = process.env.OASIS_QUICK_HOTKEY || 'CommandOrControl+Shift+Space';

let mainWindow = null;
let quickWindow = null;
let tray = null;
/** Set on app.quit so the close handler stops hiding the window. */
let quitting = false;

// Single-instance lock — clicking the dock/tray icon while another instance is
// running shouldn't spawn a second window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0f1a',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  if (DEV_MODE) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'web', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the user's browser instead of an in-app popup.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Closing the window should hide it (so the tray icon stays useful)
  // unless the user explicitly chose Quit.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Quick-prompt window ─────────────────────────────────────────────────────

function createQuickWindow() {
  if (quickWindow) return quickWindow;
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const w = 640, h = 440;
  quickWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((sw - w) / 2),
    y: Math.round(sh * 0.18),
    frame: false,
    show: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    vibrancy: 'under-window',
    webPreferences: {
      preload: path.join(__dirname, 'quick-prompt-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  quickWindow.loadFile(path.join(__dirname, 'quick-prompt.html'));
  // Hide on blur so it disappears as soon as the user clicks elsewhere — the
  // hotkey gets it back. Skip the auto-hide while devtools are open so dev
  // sessions aren't constantly stealing focus.
  quickWindow.on('blur', () => {
    if (!quickWindow) return;
    if (!quickWindow.webContents.isDevToolsOpened()) quickWindow.hide();
  });
  quickWindow.on('closed', () => { quickWindow = null; });
  return quickWindow;
}

function showQuickWindow() {
  const w = createQuickWindow();
  if (w.isVisible()) {
    w.hide();
    return;
  }
  // Re-center each time in case the user moved displays.
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const [ww, wh] = w.getSize();
  w.setBounds({ x: Math.round((sw - ww) / 2), y: Math.round(sh * 0.18), width: ww, height: wh });
  w.show();
  w.focus();
  w.webContents.send('oasis:quick:show');
}

function createTray() {
  // Use the system app icon as a template image. macOS auto-tints it for
  // the menu bar so we don't need to ship a custom asset for the MVP.
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromNamedImage('NSImageNameApplicationIcon', [-1, 0, 1]).resize({ width: 18, height: 18 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Oasis Cognition');

  rebuildTrayMenu();
  tray.on('click', () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const loginItem = app.getLoginItemSettings({});
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Oasis',
      click: () => {
        if (!mainWindow) createWindow();
        else { mainWindow.show(); mainWindow.focus(); }
      },
    },
    {
      label: 'Hide',
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: 'Quick Prompt',
      accelerator: QUICK_HOTKEY,
      click: () => showQuickWindow(),
    },
    { type: 'separator' },
    {
      label: 'Launch on login',
      type: 'checkbox',
      checked: !!loginItem.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.handle('oasis:notify', (_evt, { title, body, silent } = {}) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || 'Oasis'), body: String(body || ''), silent: !!silent });
  n.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
  n.show();
  return true;
});

ipcMain.handle('oasis:appInfo', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  packaged: app.isPackaged,
}));

// Quick-prompt: posts to the gateway's /api/v1/interaction and returns the response text.
ipcMain.handle('oasis:quick:ask', async (_evt, { user_message, session_id }) => {
  try {
    const body = JSON.stringify({ user_message, session_id });
    const data = await new Promise((resolve, reject) => {
      const url = new URL(GATEWAY + '/api/v1/interaction');
      const req = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
          try { resolve(JSON.parse(txt)); } catch { resolve({ response: txt }); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    return { ok: true, response: data?.response || '', session_id: data?.session_id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.on('oasis:quick:hide', () => { quickWindow?.hide(); });

ipcMain.on('oasis:quick:escalate', (_evt, { session_id }) => {
  // "Escalate" = move the conversation into the main window so the user can
  // continue with full UI affordances (timeline, diff viewer, etc.).
  quickWindow?.hide();
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
  // The renderer can pick up the session id via a postMessage hook if it
  // wants to switch sessions. For v1 we just bring the window forward —
  // the chat history is already shared via Redis so the user can find it
  // in the History panel.
  if (session_id) mainWindow?.webContents.send('oasis:focus-session', { session_id });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  // Register the global hotkey. If it's already taken (e.g. Spotlight on the
  // user's machine binds the same combo), we fail gracefully — the tray menu
  // entry still works.
  const ok = globalShortcut.register(QUICK_HOTKEY, showQuickWindow);
  if (!ok) {
    console.warn(`Failed to register global shortcut ${QUICK_HOTKEY} — already in use`);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // On macOS, keep the app running in the tray even with no windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // macOS dock-icon click: re-create the window if it was fully closed.
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on('before-quit', () => { quitting = true; });
