import { spawn, type ChildProcess, execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CHROME_EXE_PATH_ENV, WINDOW_MODE, type WindowMode } from "../config";

/**
 * Port of the Python tool: chrome_process_manager.py + grok_chrome_manager.py
 * - Spawn Chrome with a CDP port + user-data-dir
 * - Offscreen window in place of headless (less likely to be detected)
 * - Kill by PID or by user-data-dir (on Windows via PowerShell)
 * - Dynamic port picking if the chosen one is taken
 */

const isWin = process.platform === "win32";

function findChromeExe(): string {
  if (CHROME_EXE_PATH_ENV && existsSync(CHROME_EXE_PATH_ENV)) return CHROME_EXE_PATH_ENV;

  if (isWin) {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const c of candidates) {
      if (c && existsSync(c)) return c;
    }
  } else if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } else {
    for (const cmd of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
      try {
        const out = execSync(`which ${cmd}`).toString().trim();
        if (out && existsSync(out)) return out;
      } catch {
        // continue
      }
    }
  }
  throw new Error(
    "Không tìm thấy Chrome. Set CHROME_EXE_PATH trong .env hoặc cài Google Chrome."
  );
}

async function isCdpReady(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function pickFreePort(host: string, startPort: number, tries = 50): Promise<number> {
  for (let p = startPort; p < startPort + tries; p++) {
    if (await isCdpReady(host, p)) continue;
    if (await canBind(host, p)) return p;
  }
  throw new Error(`Không tìm được port CDP trống từ ${startPort}`);
}

export async function waitCdp(host: string, port: number, timeoutSeconds = 30): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await isCdpReady(host, port)) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

/**
 * Run a PS script via execFileSync to avoid every cmd.exe quoting issue.
 * Returns the stdout text; throws on failure.
 */
function runPowerShell(script: string, opts?: { silent?: boolean }): string {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", opts?.silent ? "ignore" : "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  return out.toString();
}

/**
 * Linux: scan `/proc/<pid>/cmdline` for a Chrome process whose --user-data-dir
 * matches `target`, then return its --remote-debugging-port (if any).
 * Returns null if not found.
 */
function findRunningCdpPortForUserDataLinux(target: string): number | null {
  try {
    const entries = readdirSync("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let cmdline: string;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
      } catch {
        continue;
      }
      if (!cmdline) continue;
      // /proc cmdline uses NUL bytes between args
      const args = cmdline.split("\0").filter(Boolean);
      if (args.length === 0) continue;
      const exe = args[0].toLowerCase();
      if (!exe.includes("chrome") && !exe.includes("chromium")) continue;
      const uddArg = args.find((a) => a.startsWith("--user-data-dir="));
      if (!uddArg) continue;
      const udd = path.resolve(uddArg.slice("--user-data-dir=".length));
      if (udd !== target) continue;
      const portArg = args.find((a) => a.startsWith("--remote-debugging-port="));
      if (!portArg) continue;
      const portNum = Number(portArg.slice("--remote-debugging-port=".length));
      if (Number.isFinite(portNum) && portNum > 0) return portNum;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * macOS: use `ps -ww -eo args` to list process command lines and parse the same way.
 */
function findRunningCdpPortForUserDataMac(target: string): number | null {
  try {
    const out = execSync("ps -ww -eo args", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const line of out.split(/\r?\n/)) {
      const low = line.toLowerCase();
      if (!low.includes("chrome") && !low.includes("chromium")) continue;
      const mUdd = /--user-data-dir=("([^"]+)"|(\S+))/.exec(line);
      const udd = (mUdd?.[2] || mUdd?.[3] || "").trim();
      if (!udd) continue;
      if (path.resolve(udd) !== target) continue;
      const m = /--remote-debugging-port=(\d+)/.exec(line);
      if (m) return Number(m[1]);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Find the CDP port of a Chrome process using the given user-data-dir.
 * Cross-platform: Windows (WMI), Linux (/proc), macOS (ps).
 * Used to reuse a running Chrome instead of spawning a new one.
 */
export function findRunningCdpPortForUserData(userDataDir: string): number | null {
  if (!isWin) {
    const target = path.resolve(userDataDir);
    if (process.platform === "darwin") return findRunningCdpPortForUserDataMac(target);
    return findRunningCdpPortForUserDataLinux(target);
  }
  const target = path.resolve(userDataDir).toLowerCase().replace(/\//g, "\\");
  try {
    // Use Where-Object + single quotes to avoid nested double-quote issues.
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' } | " +
      "Select-Object -ExpandProperty CommandLine";
    const out = runPowerShell(script, { silent: true });
    const lines = out.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      const low = raw.toLowerCase().replace(/\//g, "\\");
      if (!low.includes("--remote-debugging-port=")) continue;
      if (!low.includes("--user-data-dir=")) continue;
      // Match user-data-dir: extract the value then normalize (strip quotes)
      const mUdd = /--user-data-dir=("([^"]+)"|([^\s"]+))/.exec(low);
      const udd = (mUdd?.[2] || mUdd?.[3] || "").replace(/\//g, "\\").toLowerCase();
      if (!udd) continue;
      if (udd !== target && !udd.startsWith(target)) continue;
      const m = /--remote-debugging-port=(\d+)/.exec(low);
      if (m) return Number(m[1]);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Fallback: scan common CDP ports (9222-9280); if any CDP is ready,
 * assume some Chrome is open — try to connect and check whether the URL
 * belongs to Flow/Grok.
 */
export async function probeExistingCdpPort(
  host: string,
  startPort: number,
  endPort: number,
  matchUrl?: string
): Promise<number | null> {
  for (let p = startPort; p <= endPort; p++) {
    if (!(await isCdpReady(host, p, 500))) continue;
    if (!matchUrl) return p;
    try {
      const res = await fetch(`http://${host}:${p}/json`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const targets = (await res.json()) as Array<{ url?: string; type?: string }>;
      if (targets.some((t) => t.type === "page" && (t.url || "").includes(matchUrl))) return p;
    } catch {
      // continue
    }
  }
  return null;
}

export function killChromeForUserData(userDataDir: string) {
  if (!isWin) {
    try {
      execSync(`pkill -f "--user-data-dir=${userDataDir}"`, { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }
  const target = path.resolve(userDataDir);
  const escaped = target.replace(/'/g, "''");
  const script = [
    `$target = '${escaped}'`,
    `$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and ($_.CommandLine -like ('*' + $target + '*')) }`,
    `foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue } catch {} }`,
    `Start-Sleep -Milliseconds 800`,
    `foreach ($p in $procs) {`,
    `  try { if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}`,
    `}`,
  ].join("\n");
  try {
    runPowerShell(script, { silent: true });
  } catch {
    // ignore
  }
}

/**
 * Chrome flags optimized for power + lower detectability.
 * Derived from GROK_WORKFLOW_CHROME_EXTRA_ARGS + CHROME_EXTRA_ARGS in the Python tool.
 */
export const CHROME_BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-popup-blocking",
  "--mute-audio",
  "--disable-features=Translate,BackForwardCache",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  "--remote-allow-origins=*",
  // Important: force Chrome to open a new window for this instance instead of
  // forwarding the cmd-line to a running Chrome (the main cause of "exit code=0")
  "--new-window",
];

export interface SpawnChromeOptions {
  userDataDir: string;
  debugPort: number;
  host?: string;
  startUrl?: string;
  lang?: string;
  windowMode?: WindowMode;
  extraArgs?: string[];
}

export interface ChromeHandle {
  process: ChildProcess;
  pid: number;
  userDataDir: string;
  host: string;
  port: number;
}

export async function spawnChrome(opts: SpawnChromeOptions): Promise<ChromeHandle> {
  const {
    userDataDir,
    debugPort,
    host = "127.0.0.1",
    startUrl = "about:blank",
    lang = "vi",
    windowMode = WINDOW_MODE,
    extraArgs = [],
  } = opts;

  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

  // If CDP is already ready → don't spawn a new one, the caller will reuse it
  if (await isCdpReady(host, debugPort)) {
    throw new Error(
      `CDP port ${debugPort} đã busy. Nếu là Chrome của tool, reuse qua findRunningCdpPortForUserData.`
    );
  }

  const exe = findChromeExe();

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${userDataDir}`,
    `--lang=${lang}`,
    ...CHROME_BASE_ARGS,
  ];

  if (windowMode === "headless") {
    args.push("--headless=new", "--window-size=1280,860");
  } else if (windowMode === "offscreen") {
    args.push("--window-position=-32000,-32000", "--window-size=1280,860");
  } else {
    // Headful: force position (40,40) on the primary screen so Chrome can't reuse an off-screen position
    args.push("--window-position=40,40", "--window-size=1280,860");
  }

  args.push(...extraArgs);
  args.push(startUrl);

  const stderrBuf: string[] = [];
  const child = spawn(exe, args, {
    detached: true,
    windowsHide: windowMode === "headless",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();
  child.stderr?.on("data", (c: Buffer) => {
    stderrBuf.push(c.toString("utf-8"));
    if (stderrBuf.join("").length > 4000) stderrBuf.splice(0, stderrBuf.length - 2);
  });

  // Wait for CDP ready. If spawn forwarded to another instance, Chrome will exit(0) immediately
  // → fall back to finding the port of an already-running Chrome with the same user-data-dir.
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode !== null) {
    const found = findRunningCdpPortForUserData(userDataDir);
    if (found && (await isCdpReady(host, found))) {
      return {
        process: child,
        pid: -1,
        userDataDir,
        host,
        port: found,
      };
    }
    const err = stderrBuf.join("").trim().slice(-400);
    throw new Error(
      `Chrome exit ngay sau khi start (code=${child.exitCode}). ` +
      `Thường do Chrome đang mở với profile khác và forward cmd-line sang đó. ` +
      `Thử đóng hết Chrome đang mở rồi thử lại, hoặc đặt CHROME_WINDOW_MODE=headful. ` +
      (err ? `stderr: ${err}` : "")
    );
  }

  const ok = await waitCdp(host, debugPort, 30);
  if (!ok) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    throw new Error(`Chrome CDP không ready tại ${host}:${debugPort}`);
  }

  return {
    process: child,
    pid: child.pid as number,
    userDataDir,
    host,
    port: debugPort,
  };
}

/**
 * Open or reuse Chrome for a specific user-data-dir.
 * - If a Chrome is running with this dir → reuse its port (Windows)
 * - Otherwise → pick a free port and spawn
 */
export async function openOrReuseChrome(opts: {
  userDataDir: string;
  preferredPort: number;
  host?: string;
  startUrl?: string;
  lang?: string;
  windowMode?: WindowMode;
  /** App URL to match when probing (e.g. "labs.google/fx"). Helps locate an existing Chrome. */
  probeMatchUrl?: string;
}): Promise<ChromeHandle> {
  const { userDataDir, preferredPort, host = "127.0.0.1", probeMatchUrl } = opts;

  // 1. Try probing via WMI (Windows) — exact match by user-data-dir
  const running = findRunningCdpPortForUserData(userDataDir);
  if (running && (await isCdpReady(host, running))) {
    return { process: null as unknown as ChildProcess, pid: -1, userDataDir, host, port: running };
  }

  // 2. If preferredPort already has CDP ready → ONLY reuse if it belongs to
  //    the same user-data-dir. Without this check, VEO (port 9222) could
  //    claim a Grok Chrome (port 9223) if ports drift after a dynamic pick.
  if (await isCdpReady(host, preferredPort)) {
    const ownerPort = findRunningCdpPortForUserData(userDataDir);
    if (ownerPort === preferredPort) {
      return { process: null as unknown as ChildProcess, pid: -1, userDataDir, host, port: preferredPort };
    }
    // Port busy but belongs to a different profile — skip to avoid
    // cross-contaminating another provider's Chrome window.
  }

  // 3. Fallback: probe CDP ports nearby; if the URL matches, reuse it.
  //    Narrow range to +5 (was +30) to avoid grabbing a port owned by
  //    another provider (VEO=9222, Grok=9223 — a +30 scan from either
  //    would overlap into the other's range and cause tab cross-contamination).
  if (probeMatchUrl) {
    const found = await probeExistingCdpPort(host, preferredPort, preferredPort + 5, probeMatchUrl);
    if (found) {
      // Double-check: make sure this port actually belongs to our userDataDir,
      // not just any Chrome that happens to have a matching URL open.
      const ownerPort = findRunningCdpPortForUserData(userDataDir);
      if (ownerPort === found || !ownerPort) {
        return { process: null as unknown as ChildProcess, pid: -1, userDataDir, host, port: found };
      }
    }
  }

  // 4. No Chrome running with this profile → pick a free port + spawn
  let port = preferredPort;
  if (!(await canBind(host, port))) {
    port = await pickFreePort(host, port + 1);
  }

  return spawnChrome({ ...opts, debugPort: port });
}
