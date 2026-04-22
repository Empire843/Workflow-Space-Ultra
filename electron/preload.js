const { contextBridge } = require("electron");

// Expose a minimal API to the renderer (web page).
// Add more methods here as needed.
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
});
