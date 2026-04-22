const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3000;
let mainWindow;
let serverProcess;

function waitForServer(url, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const http = require("http");
      http
        .get(url, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 400) resolve();
          else if (Date.now() - start > timeout) reject(new Error("Server start timeout"));
          else setTimeout(check, 300);
        })
        .on("error", () => {
          if (Date.now() - start > timeout) reject(new Error("Server start timeout"));
          else setTimeout(check, 300);
        });
    };
    check();
  });
}

function startServer() {
  if (app.isPackaged) {
    const nextCli = require.resolve("next/dist/bin/next");
    console.log("[electron] Production mode – starting next from:", nextCli);

    serverProcess = spawn(process.execPath, [nextCli, "start", "-p", String(PORT)], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } else {
    const appRoot = path.join(__dirname, "..");
    const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");
    console.log("[electron] Dev mode – starting next dev from:", nextBin);

    serverProcess = spawn(process.execPath, [nextBin, "dev", "-p", String(PORT)], {
      cwd: appRoot,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  }

  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[next] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[next] ${d}`));
  serverProcess.on("error", (err) => console.error("Failed to start server:", err));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Workflow Space Ultra",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Tắt dev tools in production & chặn phím tắt
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (app.isPackaged && input.key === 'F12') event.preventDefault();
    if (app.isPackaged && input.control && input.shift && input.key === 'I') event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function killServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
}

async function startApp() {
  startServer();

  console.log("⏳ Waiting for Next.js server…");
  try {
    await waitForServer(`http://localhost:${PORT}`);
  } catch {
    console.error("❌ Server failed to start");
    app.quit();
    return;
  }
  console.log("✅ Server ready");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

module.exports = { startApp, killServer };
