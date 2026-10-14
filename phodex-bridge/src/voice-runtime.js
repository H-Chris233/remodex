// Purpose: Owns the shared Codex process and local Voice gateway independently of the bridge.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const state = require("./daemon-state");
const { version } = require("../package.json");

const VOICE_ENDPOINT = "ws://127.0.0.1:4510";
const CODEX_ENDPOINT = "ws://127.0.0.1:4511";
const runtimePath = (name, options = {}) => path.join(state.resolveRemodexStateDir(options), name);

function readRuntimeConfig(options = {}) {
  const file = runtimePath("voice-runtime-config.json", options);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function readRuntimeStatus(options = {}) {
  try { return JSON.parse(fs.readFileSync(runtimePath("voice-runtime-status.json", options), "utf8")); }
  catch { return null; }
}

function writeRuntimeJson(name, value, options = {}) {
  state.ensureRemodexStateDir(options);
  fs.writeFileSync(runtimePath(name, options), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use; the shared runtime was not started.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

// A connection is initialized separately; probing never creates a thread or sends a turn.
async function withRuntimeClient(endpoint, operation, { WebSocketImpl = WebSocket, timeoutMs = 5000 } = {}) {
  const socket = new WebSocketImpl(endpoint);
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (bytes) => {
    let message;
    try { message = JSON.parse(String(bytes)); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || "Codex rejected the runtime check."));
    else request.resolve(message.result);
  });
  const failPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("The shared runtime connection closed."));
    }
    pending.clear();
  };
  socket.on("error", failPending);
  socket.on("close", failPending);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Shared runtime connection timed out.")), timeoutMs);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("The shared runtime is unavailable.")); });
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Shared runtime ${method} timed out.`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const initialized = await request("initialize", {
      clientInfo: { name: "remodex_voice_setup", title: "Remodex Voice Setup", version },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await operation(request, initialized);
  } finally {
    failPending();
    socket.terminate();
  }
}

function probeRuntime(endpoint = VOICE_ENDPOINT, options = {}) {
  return withRuntimeClient(endpoint, async (request) => {
    const loaded = await request("thread/loaded/list", {});
    return { endpoint, threadIds: loaded.data || [] };
  }, options);
}

async function assertRuntimeIdle(options = {}) {
  return withRuntimeClient(VOICE_ENDPOINT, async (request) => {
    const voice = await request("remodex/realtime/status", {});
    if (voice?.state !== "idle") throw new Error("A Voice call is active or closing. Hang up and wait for cleanup before stopping the shared runtime.");
    let cursor;
    do {
      const page = await request("thread/loaded/list", cursor ? { cursor } : {});
      for (const threadId of page.data || []) {
        const { thread } = await request("thread/read", { threadId, includeTurns: false });
        if (!thread?.status || thread.status.type === "active") {
          throw new Error("Codex still has an active thread. Wait for every turn to finish before stopping or rolling back the shared runtime.");
        }
      }
      if (page.nextCursor && page.nextCursor === cursor) throw new Error("Codex returned an invalid loaded-thread cursor.");
      cursor = page.nextCursor;
    } while (cursor);
  }, options);
}

function buildRuntimeLaunch(config, env = process.env, platform = process.platform) {
  if (!config?.codexPath || !path.isAbsolute(config.codexPath) || !fs.existsSync(config.codexPath)
      || /["\r\n%]/.test(config.codexPath)) throw new Error("The recorded Codex executable no longer exists. Run remodex setup-voice again.");
  const childEnv = { ...env, CODEX_HOME: config.codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex") };
  const args = ["app-server", "--listen", CODEX_ENDPOINT, "--enable", "realtime_conversation", "-c", 'realtime.type="conversational"'];
  if (platform === "win32" && /\.cmd$/i.test(config.codexPath)) {
    return { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/v:off", "/c",
      `""${config.codexPath}" app-server --listen ${CODEX_ENDPOINT} --enable realtime_conversation -c realtime.type=conversational"`],
    options: { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true } };
  }
  return { command: config.codexPath, args, options: { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true } };
}

function createVoiceRuntime({ config, env = process.env, platform = process.platform, spawnImpl = spawn,
  gatewayFactory = (options) => require("./realtime-gateway").createRealtimeGateway(options),
  portCheck = assertPortAvailable, probe = probeRuntime, timeoutMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onFailure = () => {},
  stopChild = (child) => {
    if (platform !== "win32") { child.kill("SIGTERM"); return; }
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
    catch (error) {
      if (child.exitCode != null) return;
      try { process.kill(child.pid, 0); } catch (probeError) { if (probeError.code === "ESRCH") return; }
      throw error;
    }
  },
} = {}) {
  let child;
  let gateway;
  let heartbeat;
  let closing = false;
  let failure;
  let closePromise;
  const report = (runtimeState, lastError = "") => writeRuntimeJson("voice-runtime-status.json", {
    state: runtimeState, pid: process.pid, codexPid: child?.pid || null, endpoint: VOICE_ENDPOINT,
    updatedAt: new Date().toISOString(), lastError,
  }, { env });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(heartbeat);
    closePromise = (async () => {
      let cleanupError;
      try { await gateway?.close(); } catch { cleanupError = new Error("Voice gateway cleanup failed."); }
      try {
        if (Number.isInteger(child?.pid) && child.pid > 0 && child.exitCode == null) stopChild(child);
      } catch { cleanupError ||= new Error("Unable to stop the owned Codex process. The shared runtime has not reported a clean shutdown."); }
      if (cleanupError) failure ||= cleanupError.message;
      report(failure ? "error" : "stopped", failure || "");
      if (cleanupError) throw cleanupError;
    })();
    return closePromise;
  };
  return {
    async start() {
      let launch;
      try {
        await portCheck(4510);
        await portCheck(4511);
        if (closing) throw new Error("Shared Codex startup was cancelled.");
        launch = buildRuntimeLaunch(config || readRuntimeConfig({ env }), env, platform);
      } catch (error) {
        failure = error.message;
        report("error", failure);
        throw error;
      }
      child = spawnImpl(launch.command, launch.args, launch.options);
      // Codex diagnostics can contain live audio/session data. Keep worker logs payload-free.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      const fail = () => {
        if (closing) return;
        failure = "The shared Codex process stopped. Check its executable/configuration, then rerun setup-voice.";
        void close().then(() => onFailure(new Error(failure)), () => onFailure(new Error(failure)));
      };
      child.once("error", fail);
      child.once("exit", fail);
      report("starting");
      try {
        const deadline = Date.now() + timeoutMs;
        while (!closing) {
          try { await probe(CODEX_ENDPOINT, { timeoutMs: 1000 }); break; } catch {
            if (Date.now() >= deadline) throw new Error("Shared Codex startup timed out.");
            await sleep(200);
          }
        }
        if (closing) throw new Error(failure || "Shared Codex startup was cancelled.");
        gateway = gatewayFactory({ listenHost: "127.0.0.1", port: 4510, upstreamUrl: CODEX_ENDPOINT });
        await gateway.start();
        await probe(VOICE_ENDPOINT);
        if (closing) throw new Error(failure || "Shared Codex startup was cancelled.");
        report("running");
        heartbeat = setInterval(() => report("running"), 5000);
        return { endpoint: VOICE_ENDPOINT };
      } catch (error) {
        failure = error.message;
        await close();
        throw error;
      }
    },
    close,
  };
}

async function runVoiceRuntime() {
  const runtime = createVoiceRuntime({ onFailure: () => { process.exitCode = 1; } });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    void runtime.close().catch(() => { process.exitCode = 1; console.error("[remodex] Shared runtime cleanup failed."); });
  });
  await runtime.start();
}

module.exports = { VOICE_ENDPOINT, CODEX_ENDPOINT, runtimePath, readRuntimeConfig, readRuntimeStatus, writeRuntimeJson,
  assertPortAvailable, withRuntimeClient, probeRuntime, assertRuntimeIdle, buildRuntimeLaunch, createVoiceRuntime, runVoiceRuntime };
