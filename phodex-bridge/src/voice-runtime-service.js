// Purpose: Installs the independent per-user Voice runtime and launches Desktop with local configuration.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const state = require("./daemon-state");
const { resolveCodexBinary } = require("./windows-service");
const { buildLaunchAgentPlist } = require("./macos-launch-agent");
const { readBridgeConfig } = require("./codex-desktop-refresher");
const { VOICE_ENDPOINT, runtimePath, resolveVoiceEndpoint, readRuntimeConfig, readRuntimeStatus, writeRuntimeJson,
  probeRuntime, assertRuntimeIdle, withRuntimeClient, runVoiceRuntime } = require("./voice-runtime");

const LABEL = "com.remodex.voice-runtime";
const CLI_PATH = path.resolve(__dirname, "..", "bin", "remodex.js");
const BACKUP_FILE = "voice-setup-backup.json";
const VOICE_COMMANDS = new Set(["setup-voice", "run-voice-runtime", "voice-runtime-status", "stop-voice-runtime", "rollback-voice", "open-desktop"]);

function runtimeTaskName(env = process.env) {
  const root = path.resolve(state.resolveRemodexStateDir({ env })).toLowerCase();
  return `Remodex-VoiceRuntime-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

function runtimePlistPath(env = process.env) {
  return path.join(env.HOME || os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function invokeRuntimeService(action, { env = process.env, platform = process.platform, execImpl = execFileSync } = {}) {
  if (platform === "win32") {
    const output = execImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(__dirname, "scripts", "windows-task.ps1"), "-Action", action,
      "-StateDir", path.resolve(state.resolveRemodexStateDir({ env })), "-TaskName", runtimeTaskName(env), "-WorkerKind", "voice-runtime"],
    { env, encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  }
  if (platform !== "darwin") throw new Error("Voice runtime service setup is supported on Windows and macOS.");
  const uid = String(env.UID || execImpl("id", ["-u"], { env, encoding: "utf8" }).trim());
  if (!/^\d+$/.test(uid)) throw new Error("Unable to determine the launchd user domain.");
  const target = `gui/${uid}/${LABEL}`;
  const plistPath = runtimePlistPath(env);
  const installed = fs.existsSync(plistPath);
  let running = false;
  let loaded = false;
  try {
    const output = execImpl("launchctl", ["print", target], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    loaded = true;
    running = /\bstate = running\b/.test(output);
    if (action === "Status") return { installed, running };
  } catch (error) {
    if (action === "Status") return { installed, running: false };
    if (action !== "Install" && action !== "Start" && !installed) return { ok: true };
  }
  if (action === "Install") {
    if (running) throw new Error("The Voice runtime is running; stop it before reinstalling.");
    const config = readRuntimeConfig({ env });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, buildLaunchAgentPlist({ homeDir: env.HOME || os.homedir(), pathEnv: env.PATH || "",
      stateDir: state.resolveRemodexStateDir({ env }), nodePath: config.nodePath, cliPath: config.cliPath,
      stdoutLogPath: runtimePath("logs/voice-runtime.stdout.log", { env }), stderrLogPath: runtimePath("logs/voice-runtime.stderr.log", { env }),
      label: LABEL, serviceCommand: "run-voice-runtime" }), { mode: 0o600 });
  } else if (action === "Start") {
    if (!installed) throw new Error("The Voice runtime is not installed. Run remodex setup-voice.");
    if (!running) {
      execImpl("launchctl", loaded ? ["kickstart", target] : ["bootstrap", `gui/${uid}`, plistPath], { env, stdio: ["ignore", "ignore", "pipe"] });
    }
  } else if (action === "Stop" || action === "Uninstall") {
    if (loaded) execImpl("launchctl", ["bootout", `gui/${uid}`, plistPath], { env, stdio: ["ignore", "ignore", "pipe"] });
    if (action === "Uninstall") fs.rmSync(plistPath, { force: true });
  }
  return { ok: true };
}

function resolveRuntimeBinary(env = process.env, platform = process.platform, execImpl = execFileSync) {
  if (platform === "win32") return resolveCodexBinary(env, execImpl);
  const candidate = env.REMODEX_CODEX_BIN || execImpl("which", ["codex"], { env, encoding: "utf8" }).trim();
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) throw new Error("Install/login to Codex or set REMODEX_CODEX_BIN to its absolute path.");
  return candidate;
}

async function setupVoice({ env = process.env, platform = process.platform, service = invokeRuntimeService,
  resolveBinary = resolveRuntimeBinary, probe = probeRuntime, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30_000, now = Date.now,
} = {}) {
  const saved = state.readDaemonConfig({ env }) || {};
  const previous = readRuntimeConfig({ env });
  const runtimeConfig = { nodePath: process.execPath, cliPath: CLI_PATH,
    codexPath: resolveBinary({ ...env, REMODEX_CODEX_BIN: env.REMODEX_CODEX_BIN || saved.codexPath || previous?.codexPath }, platform),
    codexHome: env.CODEX_HOME || saved.codexHome || previous?.codexHome || path.join(os.homedir(), ".codex"),
    gatewayToken: previous?.gatewayToken || randomBytes(32).toString("hex"),
    nativeToken: previous?.nativeToken || randomBytes(32).toString("hex") };
  const endpoint = resolveVoiceEndpoint(runtimeConfig);
  if (!/^[0-9a-f]{64}$/.test(runtimeConfig.nativeToken)) throw new Error("The saved native runtime credential is invalid. No runtime was started.");
  state.ensureRemodexStateDir({ env });
  state.ensureRemodexLogsDir({ env });
  const current = service("Status", { env, platform });
  if (current.running) {
    if (JSON.stringify(previous) !== JSON.stringify(runtimeConfig)) throw new Error("The running Voice runtime has different executable/configuration paths. Finish its tasks and run stop-voice-runtime before setup.");
    await probe(endpoint);
  } else {
    const heartbeat = readRuntimeStatus({ env });
    if (heartbeat?.state === "running" && now() - Date.parse(heartbeat.updatedAt) < 20_000) {
      throw new Error("A Voice runtime is alive without its service owner. No new runtime was started; inspect voice-runtime-status before reinstalling.");
    }
    // Windows mode bits do not restrict other users; secure the state directory before saving credentials.
    if (platform === "win32") service("Install", { env, platform });
    writeRuntimeJson("voice-runtime-config.json", runtimeConfig, { env });
    fs.rmSync(runtimePath("voice-runtime-status.json", { env }), { force: true });
    if (platform !== "win32") service("Install", { env, platform });
    service("Start", { env, platform });
    const deadline = now() + timeoutMs;
    while (true) {
      try { await probe(endpoint); break; } catch {
        const status = readRuntimeStatus({ env });
        if (status?.state === "error") throw new Error(status.lastError || "Voice runtime startup failed.");
        if (now() >= deadline) throw new Error("Voice runtime startup timed out. Inspect voice-runtime-status; no bridge configuration was changed.");
        await sleep(250);
      }
    }
  }
  const currentConfig = state.readDaemonConfig({ env }) || saved;
  // Back up only connection fields, preserving later relay/pairing and manual connection changes.
  if (!fs.existsSync(runtimePath(BACKUP_FILE, { env }))) writeRuntimeJson(BACKUP_FILE, {
    hadCodexEndpoint: Object.hasOwn(currentConfig, "codexEndpoint"), codexEndpoint: currentConfig.codexEndpoint || "",
    installedCodexEndpoint: endpoint,
    changedCodexHome: currentConfig.codexHome !== runtimeConfig.codexHome,
    hadCodexHome: Object.hasOwn(currentConfig, "codexHome"), codexHome: currentConfig.codexHome || "",
    installedCodexHome: runtimeConfig.codexHome,
  }, { env });
  state.writeDaemonConfig({ ...readBridgeConfig({ env }), ...currentConfig, codexEndpoint: endpoint, codexHome: runtimeConfig.codexHome }, { env });
  return { endpoint: VOICE_ENDPOINT, migrationRequired: true,
    nextStep: "Wait for all Desktop and Remodex tasks to finish, quit Desktop normally, then run remodex open-desktop <originalThreadId>. Restart only the Remodex bridge after its old tasks are idle." };
}

async function stopVoiceRuntime({ env = process.env, platform = process.platform, service = invokeRuntimeService,
  assertIdle = assertRuntimeIdle, uninstall = false, now = Date.now } = {}) {
  const heartbeat = readRuntimeStatus({ env });
  if (service("Status", { env, platform }).running
      || (heartbeat?.state === "running" && now() - Date.parse(heartbeat.updatedAt) < 20_000)) await assertIdle({ env });
  service(uninstall ? "Uninstall" : "Stop", { env, platform });
  return { stopped: true };
}

async function rollbackVoice(options = {}) {
  const env = options.env || process.env;
  const backupPath = runtimePath(BACKUP_FILE, { env });
  if (!fs.existsSync(backupPath)) throw new Error("There is no Voice setup to roll back.");
  await stopVoiceRuntime({ ...options, uninstall: true });
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const config = state.readDaemonConfig({ env }) || {};
  if (config.codexEndpoint === backup.installedCodexEndpoint) {
    if (backup.hadCodexEndpoint) config.codexEndpoint = backup.codexEndpoint;
    else delete config.codexEndpoint;
  }
  if (backup.changedCodexHome && config.codexHome === backup.installedCodexHome) {
    if (backup.hadCodexHome) config.codexHome = backup.codexHome;
    else delete config.codexHome;
  }
  state.writeDaemonConfig(config, { env });
  fs.rmSync(backupPath);
  return { restored: true, nextStep: "Quit the shared Desktop normally, start Desktop from its usual launcher, then restart the bridge." };
}

function resolveDesktopExecutable({ env = process.env, platform = process.platform, execImpl = execFileSync } = {}) {
  if (platform === "darwin") {
    const app = env.REMODEX_CODEX_APP_PATH || "/Applications/Codex.app";
    if (!app.endsWith(".app")) return app;
    const executable = execImpl("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!executable || /[/\\\0\r\n]/.test(executable)) throw new Error("The Codex bundle has an invalid executable name.");
    return path.join(app, "Contents", "MacOS", executable);
  }
  if (env.REMODEX_CODEX_APP_PATH) return env.REMODEX_CODEX_APP_PATH;
  if (platform !== "win32") throw new Error("The Desktop launcher is supported on Windows and macOS.");
  const output = execImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-AppxPackage -Name '*Codex*' | Select-Object -ExpandProperty InstallLocation"],
  { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  for (const root of output.trim().split(/\r?\n/).filter(Boolean)) {
    for (const name of ["ChatGPT.exe", "Codex.exe"]) {
      for (const file of [path.join(root, "app", name), path.join(root, name)]) if (fs.existsSync(file)) return file;
    }
  }
  throw new Error("Codex Desktop was not found. Set REMODEX_CODEX_APP_PATH to its installed executable.");
}

function assertDesktopStopped(executable, { env = process.env, platform = process.platform, execImpl = execFileSync } = {}) {
  if (platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
      + "try { $desktopProcesses=Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:REMODEX_DESKTOP_EXECUTABLE_PATH)) -ErrorAction Stop } "
      + "catch { if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenName*') { throw }; $desktopProcesses=@() }; "
      + "ConvertTo-Json -InputObject @($desktopProcesses | ForEach-Object { $_.Path }) -Compress";
    const output = execImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...env, REMODEX_DESKTOP_EXECUTABLE_PATH: executable }, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const paths = JSON.parse(output.trim() || "[]");
    if (!Array.isArray(paths) || paths.some((value) => !value)) throw new Error("Unable to verify Desktop process ownership; no application was launched.");
    const target = fs.realpathSync(executable).toLowerCase();
    if (paths.some((value) => fs.realpathSync(value).toLowerCase() === target)) {
      throw new Error("Wait for all Desktop turns to finish, then quit Desktop normally before using open-desktop. Existing processes cannot inherit the shared runtime environment.");
    }
  } else {
    try {
      execImpl("pgrep", ["-f", executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { if (error.status === 1) return; throw error; }
    throw new Error("Wait for all Desktop turns to finish, then quit Desktop normally before using open-desktop.");
  }
}

async function openSharedDesktop(threadId = "", { env = process.env, platform = process.platform,
  resolveDesktop = resolveDesktopExecutable, assertStopped = assertDesktopStopped, spawnImpl = spawn,
  client = withRuntimeClient, fsImpl = fs } = {}) {
  const config = readRuntimeConfig({ env });
  const endpoint = resolveVoiceEndpoint(config);
  if (!config || state.readDaemonConfig({ env })?.codexEndpoint !== endpoint) throw new Error("Run remodex setup-voice first.");
  if (threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Use the original Codex thread UUID.");
  const executable = resolveDesktop({ env, platform });
  if (!path.isAbsolute(executable) || !fsImpl.existsSync(executable)) throw new Error("The Codex Desktop executable was not found.");
  const asar = platform === "darwin" ? path.join(path.dirname(executable), "..", "Resources", "app.asar")
    : path.join(path.dirname(executable), "resources", "app.asar");
  if (!fsImpl.existsSync(asar) || !fsImpl.readFileSync(asar).includes(Buffer.from("CODEX_APP_SERVER_WS_URL"))) {
    throw new Error("This Desktop installation does not expose the shared local runtime setting; no application was launched.");
  }
  assertStopped(executable, { env, platform });
  await client(endpoint, async (request) => {
    if (threadId) {
      const result = await request("thread/resume", { threadId, excludeTurns: true });
      if (result?.thread?.id !== threadId) throw new Error("Codex did not restore the original thread; Desktop was not launched.");
    } else await request("thread/loaded/list", {});
  });
  const launchEnv = { ...env, CODEX_HOME: config.codexHome, CODEX_APP_SERVER_WS_URL: endpoint };
  delete launchEnv.CODEX_APP_SERVER_FORCE_CLI;
  const child = spawnImpl(executable, threadId ? [`codex://threads/${threadId}`] : [], {
    env: launchEnv, stdio: "ignore", detached: true, windowsHide: true,
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { launched: true, endpoint: VOICE_ENDPOINT, threadId: threadId || null };
}

async function runVoiceCommand(command, { jsonOutput = false, consoleImpl = console, threadId = "", deps = {} } = {}) {
  if (!VOICE_COMMANDS.has(command)) return false;
  let result;
  if (command === "run-voice-runtime") { await (deps.run || runVoiceRuntime)(); return true; }
  if (command === "setup-voice") result = await (deps.setup || setupVoice)();
  if (command === "stop-voice-runtime") result = await (deps.stop || stopVoiceRuntime)();
  if (command === "rollback-voice") result = await (deps.rollback || rollbackVoice)();
  if (command === "open-desktop") result = await (deps.open || openSharedDesktop)(threadId);
  if (command === "voice-runtime-status") {
    result = (deps.status || getVoiceRuntimeStatus)();
  }
  consoleImpl.log(jsonOutput ? JSON.stringify(result) : `[remodex] ${JSON.stringify(result)}`);
  return true;
}

function getVoiceRuntimeStatus({ env = process.env, platform = process.platform, service = invokeRuntimeService, now = Date.now } = {}) {
  const saved = readRuntimeStatus({ env });
  const scheduler = service("Status", { env, platform });
  const fresh = saved?.state === "running" && now() - Date.parse(saved.updatedAt) < 20_000;
  return { ...scheduler, state: fresh ? (scheduler.running ? "running" : "orphaned") : (scheduler.running ? "unavailable" : "stopped"),
    endpoint: VOICE_ENDPOINT, lastError: saved?.lastError || "" };
}

module.exports = { VOICE_COMMANDS, runtimeTaskName, invokeRuntimeService, resolveRuntimeBinary,
  setupVoice, stopVoiceRuntime, rollbackVoice, resolveDesktopExecutable, assertDesktopStopped, openSharedDesktop, runVoiceCommand, getVoiceRuntimeStatus };
