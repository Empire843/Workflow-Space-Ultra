const { app } = require('electron');

let bootstrap;
let license;

if (app.isPackaged) {
  // Load v8 bytecode dependencies in production
  require('bytenode');
  bootstrap = require('./bootstrap.jsc');
  const integrity = require('./integrity.jsc');
  license = require('./license.jsc');

  if (!integrity.checkIntegrity()) {
    console.error('Integrity check failed. App modified. Exiting.');
    app.quit();
    process.exit(1);
  }
} else {
  // Load raw Javascript files in development
  bootstrap = require('./bootstrap.js');
  license = require('./license.js');
}

app.whenReady().then(async () => {
  console.log(`[electron] isPackaged=${app.isPackaged}`);

  const licensed = await license.verifyLicense();
  if (!licensed) {
    const activated = await license.showLicenseDialog();
    if (!activated) {
      app.quit();
      return;
    }
  }

  await bootstrap.startApp();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (bootstrap && bootstrap.killServer) {
    bootstrap.killServer();
  }
});
