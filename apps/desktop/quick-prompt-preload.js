/**
 * Preload for the quick-prompt window only. Exposes a tighter API than the
 * main app's preload — this surface is intentionally small (ask / hide /
 * escalate / onShow) so the floating prompt stays a thin client.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oasisQuick', {
  ask: (payload) => ipcRenderer.invoke('oasis:quick:ask', payload),
  hide: () => ipcRenderer.send('oasis:quick:hide'),
  escalate: (payload) => ipcRenderer.send('oasis:quick:escalate', payload),
  onShow: (cb) => ipcRenderer.on('oasis:quick:show', cb),
});
