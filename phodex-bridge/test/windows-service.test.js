const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const state = require("../src/daemon-state");
const { startWindowsService, stopWindowsService, getWindowsServiceStatus, runWindowsService, runWindowsServiceCommand, validateRelay, resolveCodexBinary } = require("../src/windows-service");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { REMODEX_DEVICE_STATE_DIR: directory };
  const config = { relayUrl: "wss://relay.example.com/relay", codexPath: process.execPath };
  let installed = false;
  let running = false;
  const calls = [];
  const task = (action) => {
    calls.push(action);
    if (action === "Status") return { installed, running };
    if (action === "Install") installed = true;
    if (action === "Stop" || action === "Uninstall") running = false;
    if (action === "Uninstall") installed = false;
    if (action === "Start") {
      running = true;
      state.writeBridgeStatus({ pid: process.pid, codexLaunchState: "connected", connectionStatus: "connected" }, { env });
      state.writePairingSession({ sessionId: "private-session", expiresAt: Date.now() + 60_000 }, { env });
    }
    return { ok: true };
  };
  return { env, config, task, calls, directory };
}

test("Windows service start is idempotent and pairing data is kept outside status", async (t) => {
  const f = fixture(t);
  const first = await startWindowsService({ ...f, waitForPairing: true });
  const second = await startWindowsService({ ...f, waitForPairing: true });
  assert.equal(first.pairingSession.pairingPayload.sessionId, "private-session");
  assert.equal(second.status.bridgeAlive, true);
  assert.equal(f.calls.filter((call) => call === "Start").length, 1);
  assert.doesNotMatch(JSON.stringify(second.status), /private-session|relay\.example/);
  state.writeBridgeStatus({ pid: process.pid, connectionStatus: "connected" }, { env: f.env, now: () => new Date(0) });
  const stale = getWindowsServiceStatus(f);
  assert.equal(stale.bridgeAlive, false);
  assert.equal(stale.connectionStatus, "disconnected");
});

test("Windows restart stops the old task before replacing configuration", async (t) => {
  const f = fixture(t);
  await startWindowsService(f);
  f.calls.length = 0;
  await startWindowsService({ ...f, restart: true });
  assert.deepEqual(f.calls.slice(0, 4), ["Status", "Stop", "Install", "Start"]);
  const identityPath = path.join(f.directory, "device-identity.json");
  fs.writeFileSync(identityPath, "keep trust");
  stopWindowsService({ ...f, uninstall: true });
  assert.equal(fs.readFileSync(identityPath, "utf8"), "keep trust");
  assert.equal(getWindowsServiceStatus(f).installed, false);
  assert.equal(state.readPairingSession({ env: f.env }), null);
});

test("Windows startup reports Codex failures instead of claiming the task is healthy", async (t) => {
  const f = fixture(t);
  const task = (action, options) => {
    const result = f.task(action, options);
    if (action === "Start") state.writeBridgeStatus({ state: "error", lastError: "Codex executable failed" }, { env: f.env });
    return result;
  };
  await assert.rejects(startWindowsService({ ...f, task }), /Codex executable failed/);
});

test("expired pairing is regenerated and task startup timeout is actionable", async (t) => {
  const f = fixture(t);
  await startWindowsService(f);
  state.writePairingSession({ sessionId: "expired", expiresAt: 1 }, { env: f.env });
  const result = await startWindowsService({ ...f, waitForPairing: true });
  assert.equal(f.calls.filter((call) => call === "Start").length, 2);
  assert.notEqual(result.pairingSession.pairingPayload.sessionId, "expired");
  let now = 0;
  await assert.rejects(startWindowsService({
    ...f, restart: true, timeoutMs: 2, now: () => now,
    sleep: async () => { now += 3; },
    task(action, options) {
      const result = f.task(action, options);
      if (action === "Start") state.clearBridgeStatus({ env: f.env });
      return result;
    },
  }), /startup timed out/);
});

test("service runner uses existing callbacks without printing pairing material", (t) => {
  const f = fixture(t);
  state.writeDaemonConfig(f.config, { env: f.env });
  let options;
  runWindowsService({ env: f.env, startBridgeImpl: (value) => { options = value; } });
  assert.equal(options.printPairingQr, false);
  assert.equal(f.env.REMODEX_CODEX_BIN, process.execPath);
  options.onPairingSession({ pairingPayload: { sessionId: "secret" } });
  options.onBridgeStatus({ pid: 123, state: "running" });
  assert.equal(state.readPairingSession({ env: f.env }).pairingPayload.sessionId, "secret");
  assert.equal(state.readBridgeStatus({ env: f.env }).pid, 123);
});

test("service CLI routes lifecycle commands and only explicit pairing JSON contains secrets", async () => {
  const calls = [];
  const messages = [];
  const options = { jsonOutput: true, consoleImpl: { log: (message) => messages.push(message) }, deps: {
    start: async (args) => { calls.push(args); return { status: { installed: true }, pairingSession: { private: "secret" } }; },
    stop: (args) => calls.push(args), reset: () => calls.push("reset"),
  } };
  await runWindowsServiceCommand("start", options);
  assert.doesNotMatch(messages.pop(), /secret/);
  await runWindowsServiceCommand("qr", options);
  assert.match(messages.pop(), /secret/);
  await runWindowsServiceCommand("reset-pairing", options);
  assert.deepEqual(calls.slice(-2), [{ uninstall: false }, "reset"]);
  assert.equal(await runWindowsServiceCommand("run", options), false);
});

test("relay and executable configuration reject unsafe public transports or ambiguous commands", () => {
  assert.doesNotThrow(() => validateRelay("wss://relay.example.com/relay"));
  assert.doesNotThrow(() => validateRelay("ws://127.0.0.1:9000/relay"));
  for (const url of ["", "ws://relay.example.com/relay", "https://relay.example.com", "wss://user:pass@relay.example.com", "wss://relay.example.com/relay?token=x"]) {
    assert.throws(() => validateRelay(url));
  }
  assert.throws(() => resolveCodexBinary({ REMODEX_CODEX_BIN: "codex & anything" }), /absolute/);
});
