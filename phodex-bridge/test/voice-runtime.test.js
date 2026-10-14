const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const WebSocket = require("ws");
const state = require("../src/daemon-state");
const { VOICE_ENDPOINT, CODEX_ENDPOINT, runtimePath, resolveVoiceEndpoint, readRuntimeConfig, writeRuntimeJson, createVoiceRuntime,
  buildRuntimeLaunch, withRuntimeClient, probeRuntime, assertRuntimeIdle } = require("../src/voice-runtime");
const { setupVoice, rollbackVoice, stopVoiceRuntime, runtimeTaskName, invokeRuntimeService,
  openSharedDesktop, assertDesktopStopped, getVoiceRuntimeStatus } = require("../src/voice-runtime-service");
const { resolveDesktopExecutable } = require("../src/voice-runtime-service");
const { buildLaunchAgentPlist } = require("../src/macos-launch-agent");
const { main } = require("../bin/remodex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-voice-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { REMODEX_DEVICE_STATE_DIR: root, CODEX_HOME: path.join(root, "codex") };
  return { root, env, config: { codexPath: process.execPath, codexHome: env.CODEX_HOME, gatewayToken: "a".repeat(64), nativeToken: "b".repeat(64) } };
}

test("shared worker orders readiness and gateway startup, and stops only its own Codex child", async (t) => {
  const f = fixture(t);
  const calls = [];
  const child = new EventEmitter();
  child.pid = 321;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const runtime = createVoiceRuntime({ ...f, platform: "win32",
    portCheck: async (port) => calls.push(`port:${port}`),
    spawnImpl(command, args, options) {
      calls.push("codex:start");
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["app-server", "--listen", CODEX_ENDPOINT, "--enable", "realtime_conversation", "-c", 'realtime.type="conversational"',
        "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(f.config.nativeToken).digest("hex")]);
      assert.doesNotMatch(args.join(" "), new RegExp(f.config.nativeToken));
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.CODEX_HOME, f.env.CODEX_HOME);
      return child;
    },
    probe: async (endpoint, options) => {
      if (endpoint === CODEX_ENDPOINT) assert.equal(options.nativeToken, f.config.nativeToken);
      calls.push(`probe:${endpoint}`);
    },
    gatewayFactory(options) {
      assert.deepEqual(options, { listenHost: "127.0.0.1", port: 4510, upstreamUrl: CODEX_ENDPOINT,
        gatewayToken: f.config.gatewayToken, nativeToken: f.config.nativeToken });
      return { start: async () => calls.push("gateway:start"), close: async () => calls.push("gateway:close") };
    },
    stopChild: (target) => { assert.equal(target, child); calls.push("codex:stop"); child.exitCode = 0; },
  });
  t.after(() => runtime.close());
  await runtime.start();
  child.stderr.emit("data", Buffer.from("private-session-identifier"));
  assert.equal(JSON.parse(fs.readFileSync(runtimePath("voice-runtime-status.json", { env: f.env }))).state, "running");
  await runtime.close();
  await runtime.close();
  assert.deepEqual(calls, ["port:4510", "port:4511", "codex:start", `probe:${CODEX_ENDPOINT}`, "gateway:start", `probe:${resolveVoiceEndpoint(f.config)}`, "gateway:close", "codex:stop"]);
  assert.doesNotMatch(fs.readFileSync(runtimePath("voice-runtime-status.json", { env: f.env }), "utf8"), /private-session/);
});

test("port conflicts fail before launching any process and publish an actionable error", async (t) => {
  const f = fixture(t);
  const runtime = createVoiceRuntime({ ...f, portCheck: async () => { throw new Error("Port 4510 is already in use"); },
    spawnImpl: () => assert.fail("A conflicting port must never spawn Codex") });
  await assert.rejects(runtime.start(), /4510.*already in use/);
  assert.equal(JSON.parse(fs.readFileSync(runtimePath("voice-runtime-status.json", { env: f.env }))).state, "error");
});

test("spawn failure without a PID never targets a process and reports failure once", async (t) => {
  const f = fixture(t);
  const child = new EventEmitter();
  const failures = [];
  const runtime = createVoiceRuntime({ ...f, portCheck: async () => {}, spawnImpl: () => {
    queueMicrotask(() => child.emit("error", new Error("spawn failed"))); return child;
  }, probe: async () => { throw new Error("offline"); }, sleep: async () => {},
  stopChild: () => assert.fail("No process was spawned"), onFailure: (error) => failures.push(error) });
  await assert.rejects(runtime.start(), /shared Codex process stopped/);
  await runtime.close();
  assert.equal(failures.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(runtimePath("voice-runtime-status.json", { env: f.env }))).state, "error");
});

test("exited children are not killed; cleanup failure remains an error and is idempotent", async (t) => {
  const f = fixture(t);
  const child = new EventEmitter(); child.pid = 333; child.exitCode = null;
  let kills = 0;
  const runtime = createVoiceRuntime({ ...f, portCheck: async () => {}, spawnImpl: () => child,
    probe: async () => {}, gatewayFactory: () => ({ start: async () => {}, close: async () => {} }),
    stopChild: () => { kills += 1; throw new Error("access denied"); } });
  await runtime.start();
  await assert.rejects(runtime.close(), /Unable to stop/);
  await assert.rejects(runtime.close(), /Unable to stop/);
  assert.equal(kills, 1);
  assert.equal(JSON.parse(fs.readFileSync(runtimePath("voice-runtime-status.json", { env: f.env }))).state, "error");
  const exited = new EventEmitter(); exited.pid = 334; exited.exitCode = 0;
  const second = createVoiceRuntime({ ...f, portCheck: async () => {}, spawnImpl: () => exited,
    probe: async () => {}, gatewayFactory: () => ({ start: async () => {}, close: async () => {} }),
    stopChild: () => assert.fail("An exited child must not be killed") });
  await second.start(); await second.close();
});

test("Windows shim invocation is hidden and uses a single fixed Codex listener", (t) => {
  const f = fixture(t);
  const shim = path.join(f.root, "Codex shim.cmd");
  fs.writeFileSync(shim, "@exit /b 0");
  const launch = buildRuntimeLaunch({ ...f.config, codexPath: shim }, f.env, "win32");
  assert.equal(launch.command, "cmd.exe");
  assert.match(launch.args.at(-1), /4511.*--enable realtime_conversation/);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.windowsVerbatimArguments, true);
});

test("ordinary probe initializes its own client and checks loaded threads without creating work", async (t) => {
  const server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  const seen = [];
  server.on("connection", (socket) => socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    seen.push(message);
    if (message.id) socket.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? { userAgent: "codex/0.162.1" } : { data: [] } }));
  }));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await probeRuntime(endpoint), { endpoint, threadIds: [] });
  assert.deepEqual(seen.map((message) => message.method), ["initialize", "initialized", "thread/loaded/list"]);
  assert.equal(seen[0].params.capabilities.experimentalApi, true);
  await withRuntimeClient(endpoint, async (request) => request("thread/read", { threadId: "read-only" }));
  assert.equal(seen.filter((message) => message.method === "initialize").length, 2);
});

test("authenticated readiness probes use a bearer header and redact secret paths in results/errors", async (t) => {
  const nativeToken = "d".repeat(64);
  const gatewayToken = "c".repeat(64);
  const server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0,
    verifyClient: (info) => info.req.headers.authorization === `Bearer ${nativeToken}` });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  server.on("connection", (socket) => socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (message.id) socket.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? {} : { data: [] } }));
  }));
  const origin = `ws://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/voice/${gatewayToken}`;
  const result = await probeRuntime(endpoint, { nativeToken });
  assert.deepEqual(result, { endpoint: origin, threadIds: [] });
  assert.doesNotMatch(JSON.stringify(result), /cccccccc|dddddddd|\/voice\//);
  await assert.rejects(probeRuntime(endpoint), (error) => {
    assert.match(error.message, /unavailable/);
    assert.doesNotMatch(error.message, /cccccccc|dddddddd|\/voice\//);
    return true;
  });
});

test("shutdown guard checks global Voice state before idle task metadata", async (t) => {
  const server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  class ProbeSocket extends WebSocket { constructor() { super(endpoint); } }
  let voiceState = "closing";
  let threadState = "idle";
  server.on("connection", (socket) => socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (!message.id) return;
    const result = message.method === "remodex/realtime/status" ? { state: voiceState }
      : message.method === "thread/loaded/list" ? { data: ["thread"] }
        : message.method === "thread/read" ? { thread: { id: "thread", status: { type: threadState } } } : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  const config = { gatewayToken: "a".repeat(64) };
  await assert.rejects(assertRuntimeIdle({ WebSocketImpl: ProbeSocket, config }), /Voice call is active or closing/);
  voiceState = "idle"; threadState = "active";
  await assert.rejects(assertRuntimeIdle({ WebSocketImpl: ProbeSocket, config }), /active thread/);
  threadState = "idle";
  await assertRuntimeIdle({ WebSocketImpl: ProbeSocket, config });
});

test("setup and rollback preserve relay, pairing, trust and later unrelated config edits", async (t) => {
  const f = fixture(t);
  state.writeDaemonConfig({ relayUrl: "wss://relay.example/relay", codexEndpoint: "ws://127.0.0.1:5000", codexPath: process.execPath }, { env: f.env });
  state.writePairingSession({ sessionId: "pairing-secret", expiresAt: Date.now() + 60_000 }, { env: f.env });
  fs.writeFileSync(path.join(f.root, "device-identity.json"), "identity-secret");
  const calls = [];
  let running = false;
  const service = (action) => { calls.push(action); if (action === "Status") return { running }; if (action === "Start") running = true; if (action === "Uninstall") running = false; return { ok: true }; };
  const options = { ...f, platform: "win32", service, resolveBinary: () => process.execPath, probe: async () => {} };
  await setupVoice(options);
  const credentials = readRuntimeConfig({ env: f.env });
  assert.match(credentials.gatewayToken, /^[0-9a-f]{64}$/);
  assert.match(credentials.nativeToken, /^[0-9a-f]{64}$/);
  assert.notEqual(credentials.gatewayToken, credentials.nativeToken);
  await setupVoice(options);
  assert.deepEqual(readRuntimeConfig({ env: f.env }), credentials);
  assert.equal(calls.filter((action) => action === "Start").length, 1);
  const changed = state.readDaemonConfig({ env: f.env });
  assert.equal(changed.codexEndpoint, resolveVoiceEndpoint(credentials));
  assert.equal(changed.codexHome, credentials.codexHome);
  state.writeDaemonConfig({ ...changed, relayUrl: "wss://new-relay.example/relay", keepMacAwakeEnabled: true }, { env: f.env });
  await rollbackVoice({ ...options, assertIdle: async () => {} });
  const restored = state.readDaemonConfig({ env: f.env });
  assert.equal(restored.codexEndpoint, "ws://127.0.0.1:5000");
  assert.equal(restored.relayUrl, "wss://new-relay.example/relay");
  assert.equal(restored.keepMacAwakeEnabled, true);
  assert.equal(restored.codexHome, undefined);
  assert.equal(state.readPairingSession({ env: f.env }).pairingPayload.sessionId, "pairing-secret");
  assert.equal(fs.readFileSync(path.join(f.root, "device-identity.json"), "utf8"), "identity-secret");
});

test("setup aligns Codex home with the shared runtime and rollback preserves later connection edits", async (t) => {
  const f = fixture(t);
  state.writeDaemonConfig({ relayUrl: "wss://relay.example/relay", codexPath: process.execPath,
    codexHome: path.join(f.root, "old-home"), codexEndpoint: "ws://127.0.0.1:4999" }, { env: f.env });
  const options = { ...f, platform: "win32", service: () => ({ running: false }), resolveBinary: () => process.execPath, probe: async () => {} };
  await setupVoice(options);
  assert.equal(state.readDaemonConfig({ env: f.env }).codexHome, f.env.CODEX_HOME);
  const later = { ...state.readDaemonConfig({ env: f.env }), codexHome: path.join(f.root, "later-home"), codexEndpoint: "ws://127.0.0.1:4998" };
  state.writeDaemonConfig(later, { env: f.env });
  await rollbackVoice(options);
  assert.deepEqual(state.readDaemonConfig({ env: f.env }), later);
});

test("runtime and public CLI status never expose persisted credentials or gateway paths", async (t) => {
  const f = fixture(t);
  writeRuntimeJson("voice-runtime-config.json", f.config, { env: f.env });
  writeRuntimeJson("voice-runtime-status.json", { state: "running", updatedAt: new Date().toISOString() }, { env: f.env });
  const status = getVoiceRuntimeStatus({ ...f, service: () => ({ running: true }) });
  assert.equal(status.endpoint, VOICE_ENDPOINT);
  assert.doesNotMatch(JSON.stringify(status), /aaaaaaaa|bbbbbbbb|\/voice\//);
  const writes = [];
  const previousWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main({ argv: ["node", "remodex", "status", "--json"], platform: "darwin", deps: {
      getMacOSBridgeServiceStatus: () => ({ daemonConfig: { relayUrl: "wss://private-relay", codexEndpoint: resolveVoiceEndpoint(f.config) } }),
    } });
  } finally { process.stdout.write = previousWrite; }
  const output = writes.join("");
  assert.doesNotMatch(output, /aaaaaaaa|bbbbbbbb|\/voice\//);
  assert.equal(JSON.parse(output).daemonConfig.codexEndpoint, VOICE_ENDPOINT);
});

test("failed startup does not change bridge configuration; stopping active work is rejected", async (t) => {
  const f = fixture(t);
  state.writeDaemonConfig({ relayUrl: "wss://relay.example/relay", codexPath: process.execPath }, { env: f.env });
  const before = fs.readFileSync(state.resolveDaemonConfigPath({ env: f.env }), "utf8");
  let tick = 0;
  await assert.rejects(setupVoice({ ...f, service: () => ({ running: false }), resolveBinary: () => process.execPath,
    probe: async () => { throw new Error("offline"); }, now: () => tick++, timeoutMs: 1, sleep: async () => {} }), /timed out/);
  assert.equal(fs.readFileSync(state.resolveDaemonConfigPath({ env: f.env }), "utf8"), before);
  await assert.rejects(stopVoiceRuntime({ ...f, service: (action) => { assert.equal(action, "Status"); return { running: true }; },
    assertIdle: async () => { throw new Error("Active thread"); } }), /Active thread/);
});

test("runtime platform services use separate worker identities and positional launchd arguments", (t) => {
  const f = fixture(t);
  let args;
  invokeRuntimeService("Status", { ...f, platform: "win32", execImpl: (_command, values) => { args = values; return '{"running":false}'; } });
  assert.equal(args.at(-1), "voice-runtime");
  assert.match(runtimeTaskName(f.env), /^Remodex-VoiceRuntime-/);
  const plist = buildLaunchAgentPlist({ homeDir: "/Users/me", pathEnv: "/usr/bin", stateDir: "/Users/me/.remodex",
    nodePath: "/node", cliPath: "/remodex.js", stdoutLogPath: "/stdout", stderrLogPath: "/stderr",
    label: "com.remodex.voice-runtime", serviceCommand: "run-voice-runtime" });
  assert.match(plist, /com\.remodex\.voice-runtime/);
  assert.match(plist, /<string>run-voice-runtime<\/string>/);
  assert.match(plist, /exec &quot;\$1&quot; &quot;\$2&quot; &quot;\$3&quot;/);
});

test("Desktop launcher restores the original thread before spawning with only process-local settings", async (t) => {
  const f = fixture(t);
  const executable = path.join(f.root, "ChatGPT.exe");
  fs.writeFileSync(executable, "test");
  fs.mkdirSync(path.join(f.root, "resources"));
  fs.writeFileSync(path.join(f.root, "resources", "app.asar"), "CODEX_APP_SERVER_WS_URL");
  writeRuntimeJson("voice-runtime-config.json", f.config, { env: f.env });
  state.writeDaemonConfig({ codexEndpoint: resolveVoiceEndpoint(f.config) }, { env: f.env });
  f.env.CODEX_APP_SERVER_FORCE_CLI = "1";
  const threadId = "019a0000-0000-7000-8000-000000000001";
  const calls = [];
  const result = await openSharedDesktop(threadId, { ...f, platform: "win32", resolveDesktop: () => executable,
    assertStopped: () => calls.push("guard"), client: async (endpoint, run) => {
      assert.equal(endpoint, resolveVoiceEndpoint(f.config));
      return run(async (method, params) => { calls.push(method); assert.deepEqual(params, { threadId, excludeTurns: true }); return { thread: { id: threadId } }; });
    }, spawnImpl: (file, args, options) => {
      calls.push("spawn"); assert.equal(file, executable); assert.deepEqual(args, [`codex://threads/${threadId}`]);
      assert.equal(options.env.CODEX_APP_SERVER_WS_URL, resolveVoiceEndpoint(f.config));
      assert.equal(options.env.CODEX_APP_SERVER_FORCE_CLI, undefined);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child;
    } });
  assert.deepEqual(calls, ["guard", "thread/resume", "spawn"]);
  assert.equal(result.threadId, threadId);
  assert.equal(f.env.CODEX_APP_SERVER_FORCE_CLI, "1");
  assert.throws(() => assertDesktopStopped(executable, { ...f, platform: "win32", execImpl: () => JSON.stringify([executable]) }), /quit Desktop normally/);
  assert.throws(() => assertDesktopStopped(executable, { ...f, platform: "win32", execImpl: () => "[null]" }), /Unable to verify/);
});

test("Desktop discovery accepts current ChatGPT.exe packaging and the macOS bundle executable", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "app"));
  const executable = path.join(f.root, "app", "ChatGPT.exe");
  fs.writeFileSync(executable, "test");
  assert.equal(resolveDesktopExecutable({ ...f, platform: "win32", execImpl: () => f.root }), executable);
  const app = path.join(f.root, "Codex.app");
  assert.equal(resolveDesktopExecutable({ env: { ...f.env, REMODEX_CODEX_APP_PATH: app }, platform: "darwin",
    execImpl: (command, args) => { assert.equal(command, "plutil"); assert.equal(args[1], "CFBundleExecutable"); return "ChatGPT\n"; } }),
  path.join(app, "Contents", "MacOS", "ChatGPT"));
});

test("runtime CLI dispatch precedes bridge lifecycle, and stale runtime heartbeat is not healthy", async (t) => {
  const f = fixture(t);
  const calls = [];
  await main({ argv: ["node", "remodex", "open-desktop", "original-id", "--json"], platform: "win32",
    deps: { runVoiceCommand: async (command, options) => calls.push([command, options.threadId, options.jsonOutput]),
      runWindowsServiceCommand: () => assert.fail("Voice commands must not change the bridge service") } });
  assert.deepEqual(calls, [["open-desktop", "original-id", true]]);
  writeRuntimeJson("voice-runtime-status.json", { state: "running", updatedAt: new Date(0).toISOString() }, { env: f.env });
  assert.equal(getVoiceRuntimeStatus({ ...f, service: () => ({ running: true }) }).state, "unavailable");
});

test("a live orphaned worker is never overwritten or stopped while it has active work", async (t) => {
  const f = fixture(t);
  writeRuntimeJson("voice-runtime-status.json", { state: "running", updatedAt: new Date().toISOString() }, { env: f.env });
  const service = (action) => { assert.equal(action, "Status"); return { running: false }; };
  assert.equal(getVoiceRuntimeStatus({ ...f, service }).state, "orphaned");
  await assert.rejects(setupVoice({ ...f, service, resolveBinary: () => process.execPath, probe: async () => {} }), /without its service owner/);
  await assert.rejects(stopVoiceRuntime({ ...f, service, assertIdle: async () => { throw new Error("active work"); } }), /active work/);
});
