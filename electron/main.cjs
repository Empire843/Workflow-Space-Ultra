const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.WSU_APP_PORT || 3210);
const NEXT_START_TIMEOUT_MS = 60_000;

let mainWindow = null;
let nextProcess = null;
let quitting = false;

function resolveAppDir() {
  // In development this is the repo root. In packaged app this is resources/app.
  return app.getAppPath();
}

function streamChildLogs(child) {
  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[next] ${chunk}`);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[next] ${chunk}`);
    });
  }
}

function startNextServer() {
  if (nextProcess) return;

  const appDir = resolveAppDir();
  const nextBin = require.resolve("next/dist/bin/next");
  const nextMode = app.isPackaged ? "start" : "dev";
  const args = [nextBin, nextMode, "-p", String(PORT), "-H", HOST];

  nextProcess = spawn(process.execPath, args, {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(PORT),
      HOSTNAME: HOST,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  streamChildLogs(nextProcess);
  nextProcess.on("exit", (code) => {
    const wasExpected = quitting;
    nextProcess = null;
    if (!wasExpected) {
      dialog.showErrorBox(
        "Workflow Space Ultra",
        `Next.js server exited unexpectedly (code ${code ?? "unknown"}).`
      );
      app.quit();
    }
  });
}

function waitForServerReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(
        {
          host: HOST,
          port: PORT,
          path: "/",
          timeout: 2_000,
        },
        (res) => {
          res.resume();
          resolve();
        }
      );

      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Timed out while waiting for local Next.js server."));
          return;
        }
        setTimeout(probe, 500);
      });

      req.on("timeout", () => {
        req.destroy();
      });
    };

    probe();
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await mainWindow.loadURL(`http://${HOST}:${PORT}`);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  startNextServer();
  await waitForServerReady(NEXT_START_TIMEOUT_MS);
  await createMainWindow();
}

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    dialog.showErrorBox("Failed to start app", err instanceof Error ? err.message : String(err));
    app.quit();
  });
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow().catch((err) => {
      dialog.showErrorBox("Cannot reopen window", err instanceof Error ? err.message : String(err));
    });
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (nextProcess) {
    nextProcess.kill();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
