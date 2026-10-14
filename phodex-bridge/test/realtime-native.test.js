// Opt-in contract check against an installed Codex binary; never uses the user's account or workspace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomBytes, createHash } = require("node:crypto");
const { setTimeout: wait } = require("node:timers/promises");
const WebSocket = require("ws");
const { createRealtimeGateway } = require("../src/realtime-gateway");

async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Native protocol check timed out.");
    await wait(20);
  }
}

async function client(url, name) {
  const socket = new WebSocket(url);
  const notifications = [];
  const pending = new Map();
  let sequence = 0;
  socket.on("error", () => {});
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.method) { notifications.push(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Native client closed."));
    }
    pending.clear();
  });
  await once(socket, "open");
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await request("initialize", { clientInfo: { name, version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized" }));
  return { socket, notifications, request };
}

test("installed Codex shares one thread and releases failed realtime startup without interrupting it", {
  skip: !process.env.REMODEX_VOICE_NATIVE_BIN && "set REMODEX_VOICE_NATIVE_BIN to an installed Codex executable",
  timeout: 45_000,
}, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-native-voice-"));
  let native, gateway, desktop, phone;
  t.after(async () => {
    desktop?.socket.terminate();
    phone?.socket.terminate();
    await gateway?.close();
    if (native && native.exitCode === null && native.signalCode === null) {
      const exited = once(native, "exit");
      native.kill();
      await exited;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const portProbe = net.createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const url = `ws://127.0.0.1:${port}`;
  const nativeToken = randomBytes(32).toString("hex");
  // Transcription mode rejects WebRTC locally, exercising the real asynchronous error/stop contract without inference.
  native = spawn(process.env.REMODEX_VOICE_NATIVE_BIN, ["app-server", "--listen", url,
    "--enable", "realtime_conversation", "-c", 'realtime.type="transcription"',
    "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(nativeToken).digest("hex")], {
    env: { ...process.env, CODEX_HOME: temp, OPENAI_API_KEY: "", CODEX_API_KEY: "" },
    cwd: temp, stdio: "ignore", windowsHide: true,
  });
  let launchError;
  native.on("error", (error) => { launchError = error; });
  await until(async () => {
    if (launchError) throw launchError;
    if (native.exitCode !== null) throw new Error(`Native Codex exited: ${native.exitCode}`);
    try { return (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500), headers: { Authorization: `Bearer ${nativeToken}` } })).ok; }
    catch { return false; }
  });
  gateway = createRealtimeGateway({ port: 0, upstreamUrl: url, nativeToken });
  const endpoint = await gateway.start();
  desktop = await client(endpoint.url, "remodex_native_desktop_check");
  phone = await client(endpoint.url, "remodex_native_phone_check");
  const { thread } = await desktop.request("thread/start", { cwd: temp });
  const observed = await phone.request("thread/read", { threadId: thread.id, includeTurns: false });
  assert.equal(observed.thread.id, thread.id);
  assert.ok((await desktop.request("thread/loaded/list")).data.includes(thread.id));
  const sessionId = require("node:crypto").randomUUID();
  await phone.request("remodex/realtime/start", { threadId: thread.id, realtimeSessionId: sessionId,
    version: "v3", outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\n" },
    leaseToken: "a".repeat(64), clientManagedHandoffs: false });
  await until(() => phone.notifications.some((message) => message.method === "thread/realtime/error"));
  await until(async () => (await phone.request("remodex/realtime/status", { threadId: thread.id })).state === "idle");
  const closed = phone.notifications.find((message) => message.method === "thread/realtime/closed");
  assert.equal(closed.params.reason, "requested");
  assert.equal(closed.params.remodexRealtimeSessionId, sessionId);
  assert.equal((await desktop.request("thread/read", { threadId: thread.id })).thread.id, thread.id);
  assert.equal(desktop.notifications.some((message) => message.method === "turn/started"), false);
});
