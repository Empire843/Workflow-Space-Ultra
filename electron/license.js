const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, dialog, BrowserWindow, ipcMain } = require('electron');

const LICENSE_API_URL = 'http://127.0.0.1:8787'; // Dev worker URL
const LICENSE_FILE = path.join(app.getPath('userData'), 'license.json');

function getMachineId() {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const cpuCores = cpus.length;
  const totalMem = os.totalmem();
  const hostname = os.hostname();
  
  const networkInterfaces = os.networkInterfaces();
  let macAddress = '00:00:00:00:00:00';
  for (const name of Object.keys(networkInterfaces)) {
    const iface = networkInterfaces[name].find(details => !details.internal && details.mac && details.mac !== '00:00:00:00:00:00');
    if (iface) {
      macAddress = iface.mac;
      break;
    }
  }

  const rawId = `${cpuModel}-${cpuCores}-${totalMem}-${hostname}-${macAddress}`;
  return crypto.createHash('sha256').update(rawId).digest('hex');
}

async function verifyLicense() {
  console.log(`[License] Checking license... Machine ID: ${getMachineId()}`);

  if (!fs.existsSync(LICENSE_FILE)) {
    return false;
  }

  try {
    const licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    const { token, expiresAt } = licenseData;

    // Check offline expiry (7 days)
    const now = new Date().getTime();
    const expiry = new Date(expiresAt).getTime();
    
    if (now > expiry) {
      console.log(`[License] Token cached expired.`);
      return false; 
    }

    // Optionally try to renew quietly in background if we have internet.
    // For simplicity, we just use the cache. Wait... if they have internet,
    // we should really verify and renew. 
    try {
      const res = await fetch(`${LICENSE_API_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, machineId: getMachineId() })
      });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && body.token) {
           fs.writeFileSync(LICENSE_FILE, JSON.stringify({
             token: body.token,
             expiresAt: body.expiresAt
           }));
        } else {
           // Invalid remote token
           return false;
        }
      }
    } catch (err) {
      // Offline, ignore error and allow running since cache is valid
      console.log(`[License] Offline mode, using valid cached token.`);
    }

    return true;
  } catch (err) {
    console.error(`[License] Error reading license file:`, err);
    return false;
  }
}

function showLicenseDialog() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 450,
      height: 400,
      title: "Activate Workflow Space Ultra",
      resizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    win.loadFile(path.join(__dirname, 'license.html'));

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('set-machine-id', getMachineId());
    });

    const submitListener = async (event, key) => {
      try {
        const res = await fetch(`${LICENSE_API_URL}/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
             licenseKey: key,
             machineId: getMachineId(),
             appVersion: app.getVersion()
          })
        });

        const body = await res.json();
        if (res.ok && body.ok) {
          // Success
          fs.writeFileSync(LICENSE_FILE, JSON.stringify({
            token: body.token,
            expiresAt: body.expiresAt
          }));
          event.sender.send('activation-result', true);
        } else {
          event.sender.send('activation-result', false, body.error || 'Invalid license key.');
        }
      } catch (err) {
        console.error(err);
        event.sender.send('activation-result', false, 'Mất kết nối tới server. Vui lòng thử lại sau.');
      }
    };

    const successListener = () => {
      resolve(true); // Activated
      try {
         ipcMain.removeListener('submit-license', submitListener);
         ipcMain.removeListener('license-success', successListener);
      } catch (e) {}
      win.close();
    };

    ipcMain.on('submit-license', submitListener);
    ipcMain.on('license-success', successListener);

    win.on('closed', () => {
      try {
        ipcMain.removeListener('submit-license', submitListener);
        ipcMain.removeListener('license-success', successListener);
      } catch (e) {}
      resolve(false); // Closed without success
    });
  });
}

module.exports = {
  getMachineId,
  verifyLicense,
  showLicenseDialog
};
