/**
 * Renderer-side bridge. Anything exposed here is callable from the React
 * app as `window.oasis.*`. Keep the surface tiny — broader IPC is a foot-gun
 * for a thin web-shell. Add new APIs only when there's no web equivalent.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oasis', {
  /** Native macOS notification. Falls back to {@link Notification} in the renderer if unavailable. */
  notify: (opts) => ipcRenderer.invoke('oasis:notify', opts || {}),
  /** Build/runtime info for diagnostics + UI version stamp. */
  appInfo: () => ipcRenderer.invoke('oasis:appInfo'),
  /** Marker the renderer can check to detect "running in Electron desktop shell". */
  isDesktop: true,
});
