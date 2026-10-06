// Purpose: Runs the existing bridge in a per-user Windows scheduled task.
// Task Scheduler owns the process tree; no global process-name kills or extra supervisor.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { readBridgeConfig } = require("./codex-desktop-refresher");
const state = require("./daemon-state");
const { printQR } = require("./qr");
const { resetBridgeTrustState } = require("./secure-device-state");

function taskName(env = process.env) {
  const root = path.resolve(state.resolveRemodexStateDir({ env })).toLowerCase();
  return `Remodex-Bridge-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

function invokeTask(action, { env = process.env, execImpl = execFileSync } = {}) {
  const output = execImpl("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(__dirname, "scripts", "windows-task.ps1"),
    "-Action", action, "-StateDir", path.resolve(state.resolveRemodexStateDir({ env })),
    "-TaskName", taskName(env),
  ], { env, encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output.trim().replace(/^\uFEFF/, ""));
}

function resolveCodexBinary(env = process.env, execImpl = execFileSync) {
  let candidate = env.REMODEX_CODEX_BIN;
  if (!candidate) {
    for (const name of ["codex.exe", "codex.cmd"]) {
      try {
        candidate = execImpl("where.exe", [name], { env, encoding: "utf8", windowsHide: true })
          .trim().split(/\r?\n/)[0];
        if (candidate) break;
      } catch { /* Try the npm shim when no native binary is on PATH. */ }
    }
  }
  if (!candidate || !path.isAbsolute(candidate) || !/\.(exe|cmd)$/i.test(candidate)
      || /["\r\n%]/.test(candidate) || !fs.existsSync(candidate)) {
    throw new Error("Codex was not found. Install/login to Codex first, or set REMODEX_CODEX_BIN to its absolute .exe/.cmd path.");
  }
  return candidate;
}

function validateRelay(relayUrl) {
  let url;
  try { url = new URL(relayUrl); } catch { throw new Error("Set REMODEX_RELAY to wss://your-domain/relay before starting."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "wss:" && !(local && url.protocol === "ws:"))
      || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a credential-free wss:// relay URL (ws:// is allowed only for loopback tests).");
  }
}

function prepareServiceConfig({ env = process.env, resolveBinary = resolveCodexBinary } = {}) {
  const saved = state.readDaemonConfig({ env }) || {};
  const config = env.REMODEX_RELAY || env.PHODEX_RELAY || !saved.relayUrl
    ? readBridgeConfig({ env }) : saved;
  validateRelay(config.relayUrl);
  return {
    ...config,
    pushServiceUrl: "",
    nodePath: process.execPath,
    cliPath: path.resolve(__dirname, "..", "bin", "remodex.js"),
    codexPath: resolveBinary({ ...env, REMODEX_CODEX_BIN: env.REMODEX_CODEX_BIN || saved.codexPath }),
    codexHome: env.CODEX_HOME || saved.codexHome || "",
  };
}

function getWindowsServiceStatus({ env = process.env, task = invokeTask, now = Date.now } = {}) {
  const scheduler = task("Status", { env });
  const bridge = state.readBridgeStatus({ env });
  const bridgeAlive = scheduler.running && Boolean(bridge?.pid)
    && now() - Date.parse(bridge.updatedAt) < 20_000;
  return {
    taskName: taskName(env),
    installed: scheduler.installed,
    taskRunning: scheduler.running,
    lastTaskResult: scheduler.lastTaskResult ?? null,
    bridgeAlive,
    connectionStatus: bridgeAlive ? bridge.connectionStatus : "disconnected",
    codexLaunchState: bridgeAlive ? bridge.codexLaunchState : "stopped",
    lastError: bridge?.lastError || "",
    stdoutLogPath: state.resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: state.resolveBridgeStderrLogPath({ env }),
  };
}

async function startWindowsService({
  env = process.env, task = invokeTask, config = prepareServiceConfig({ env }),
  restart = false, waitForPairing = false, timeoutMs = 20_000,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const scheduler = task("Status", { env });
  const saved = state.readDaemonConfig({ env });
  const pairing = state.readPairingSession({ env });
  const configChanged = JSON.stringify(saved) !== JSON.stringify(config);
  const expiredPairing = waitForPairing && (!pairing?.pairingPayload || pairing.pairingPayload.expiresAt <= now());
  if (scheduler.running && !restart && !configChanged && !expiredPairing) {
    const status = getWindowsServiceStatus({ env, task, now });
    if (!status.bridgeAlive) throw new Error("The task is running without a fresh bridge heartbeat. Check status/logs, then run remodex restart.");
    return { status, pairingSession: waitForPairing ? pairing : null };
  }
  // Stop the scheduler-owned tree before replacing config or deleting its live state.
  if (scheduler.installed) task("Stop", { env });
  state.ensureRemodexStateDir({ env });
  state.ensureRemodexLogsDir({ env });
  state.writeDaemonConfig(config, { env });
  state.clearPairingSession({ env });
  state.clearBridgeStatus({ env });
  task("Install", { env });
  task("Start", { env });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const bridge = state.readBridgeStatus({ env });
    if (bridge?.state === "error" || bridge?.codexLaunchState === "error") {
      throw new Error(bridge.lastError || "Codex failed to start. See remodex status.");
    }
    const freshPairing = state.readPairingSession({ env });
    if (bridge?.pid && bridge.codexLaunchState === "connected"
        && (!waitForPairing || freshPairing?.pairingPayload?.expiresAt > now())) {
      return { status: getWindowsServiceStatus({ env, task, now }), pairingSession: freshPairing };
    }
    await sleep(250);
  }
  throw new Error("Windows bridge startup timed out. Run remodex status and inspect the reported logs.");
}

function stopWindowsService({ env = process.env, task = invokeTask, uninstall = false } = {}) {
  task(uninstall ? "Uninstall" : "Stop", { env });
  state.clearPairingSession({ env });
  state.writeBridgeStatus({ state: "stopped", connectionStatus: "disconnected", pid: null, lastError: "" }, { env });
}

function runWindowsService({ env = process.env, startBridgeImpl } = {}) {
  const config = state.readDaemonConfig({ env });
  validateRelay(config?.relayUrl);
  if (!config.codexPath) throw new Error("Missing service configuration. Run remodex start again.");
  env.REMODEX_CODEX_BIN = config.codexPath;
  if (config.codexHome) env.CODEX_HOME = config.codexHome;
  const startBridge = startBridgeImpl || require("./bridge").startBridge;
  startBridge({
    config,
    printPairingQr: false,
    onPairingSession: (session) => state.writePairingSession(session, { env }),
    onBridgeStatus: (status) => state.writeBridgeStatus(status, { env }),
  });
}

const serviceCommands = new Set(["up", "start", "restart", "stop", "status", "qr", "pair", "uninstall-service", "reset-pairing", "run-service"]);
async function runWindowsServiceCommand(command, { jsonOutput = false, consoleImpl = console, deps = {} } = {}) {
  if (!serviceCommands.has(command)) return false;
  if (command === "run-service") {
    (deps.run || runWindowsService)();
    return true;
  }
  if (command === "status") {
    const status = (deps.status || getWindowsServiceStatus)();
    consoleImpl.log(jsonOutput ? JSON.stringify(status) : Object.entries(status).map(([key, value]) => `${key}: ${value}`).join("\n"));
    return true;
  }
  if (["stop", "uninstall-service", "reset-pairing"].includes(command)) {
    (deps.stop || stopWindowsService)({ uninstall: command === "uninstall-service" });
    if (command === "reset-pairing") (deps.reset || resetBridgeTrustState)();
    consoleImpl.log(jsonOutput ? JSON.stringify({ ok: true }) : `[remodex] ${command} completed.`);
    return true;
  }
  const showPairing = ["up", "qr", "pair"].includes(command);
  const result = await (deps.start || startWindowsService)({ restart: ["restart", "qr", "pair"].includes(command), waitForPairing: showPairing });
  if (jsonOutput) {
    // Only an explicit qr/pair request returns bearer-like pairing data.
    consoleImpl.log(JSON.stringify({ ok: true, ...result.status, ...(["qr", "pair"].includes(command) ? { pairingSession: result.pairingSession } : {}) }));
  } else if (showPairing) {
    (deps.printQR || printQR)(result.pairingSession);
  } else {
    consoleImpl.log("[remodex] Windows bridge service is running. Use remodex qr to pair.");
  }
  return true;
}

module.exports = { taskName, invokeTask, resolveCodexBinary, validateRelay, prepareServiceConfig, getWindowsServiceStatus, startWindowsService, stopWindowsService, runWindowsService, runWindowsServiceCommand };
