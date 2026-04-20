const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("wsuDesktop", {
  platform: process.platform,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
});
