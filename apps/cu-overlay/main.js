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
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -20, y: -20 }, // hide traffic lights off-screen
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Pass config via query params in the URL
  const htmlPath = path.join(__dirname, "index.html");
  const fileUrl = `file://${htmlPath}?port=${DEV_AGENT_PORT}&gateway=${GATEWAY_PORT}&session=${SESSION_ID}`;
  mainWindow.loadURL(fileUrl);

  // Debug: open devtools to check WS connection
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
