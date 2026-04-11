/**
 * Oasis CU Overlay — Electron main process.
 *
 * Creates a frameless, always-on-top, transparent window that shows
 * live computer-use session progress. Connects to the dev-agent via
 * WebSocket for real-time updates.
 *
 * Usage:
 *   electron main.js [--session=cu-xxx] [--port=8008] [--gateway=8000]
 */

const { app, BrowserWindow, screen } = require("electron");
const path = require("path");

// Parse CLI args
const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--(\w+)=(.+)$/);
  if (m) args[m[1]] = m[2];
}

const DEV_AGENT_PORT = args.port || "8008";
const GATEWAY_PORT = args.gateway || "8000";
const SESSION_ID = args.session || "";

let mainWindow = null;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 320,
    height: 480,
    minWidth: 280,
    minHeight: 300,
    x: screenW - 340,
    y: 60,
    alwaysOnTop: true,
    frame: false,
    transparent: false, // Solid window — transparent windows don't repaint on macOS when unfocused
    resizable: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#1a1a2e", // Dark background matching the overlay CSS
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -20, y: -20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // Load from localhost to avoid file:// CORS issues with fetch
  // Try dev-agent served version first, fall back to file://
  const httpUrl = `http://localhost:${DEV_AGENT_PORT}/cu-overlay?gateway=${GATEWAY_PORT}&session=${SESSION_ID}`;
  const fileUrl = `file://${path.join(__dirname, "index.html")}?port=${DEV_AGENT_PORT}&gateway=${GATEWAY_PORT}&session=${SESSION_ID}`;

  mainWindow.loadURL(httpUrl).catch(() => {
    // Dev-agent doesn't serve the overlay — fall back to file://
    mainWindow.loadURL(fileUrl);
  });

  // Force always-on-top at the floating panel level (above normal windows)
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert always-on-top and force repaint every 1.5s.
  // With transparent:false, macOS repaints reliably. setOpacity toggle is a
  // belt-and-suspenders measure to ensure the content updates are visible.
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, "floating");
      // Force Chromium to repaint by poking the webContents
      try {
        mainWindow.webContents.invalidate();
      } catch { /* older Electron */ }
    }
  }, 1500);

  // Debug: open devtools to check connection
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
