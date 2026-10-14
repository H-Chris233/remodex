const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createRealtimeGateway } = require("../src/realtime-gateway");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = "a".repeat(64);

async function until(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the test condition.");
    await delay(5);
  }
}

async function harness(t, options = {}) {
  const native = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => native.once("listening", resolve));
  const records = [], starts = [], stops = [], responses = [];
  const loaded = new Set(["thread-a", "thread-b"]);
  let control;
  const emit = (method, params) => {
    for (const record of records) if (record.socket.readyState === WebSocket.OPEN
      && record.threads.has(params.threadId)) record.socket.send(JSON.stringify({ method, params }));
  };
  native.on("connection", (socket) => {
    const record = { socket, threads: new Set(), messages: [] };
    records.push(record);
    socket.on("message", (data) => {
      const raw = data.toString(), request = JSON.parse(raw);
      record.messages.push({ raw, request });
      if (!request.method) { responses.push({ record, request }); return; }
      const result = (value = {}) => socket.send(JSON.stringify({ id: request.id, result: value }));
      if (request.method === "initialize") {
        record.initialized = true;
        if (request.params.clientInfo.name === "remodex_realtime_gateway") control = record;
        result({ userAgent: "codex/0.162.1" });
      } else if (request.method === "initialized") {
        return;
      } else if (request.method === "thread/loaded/list") {
        result({ data: [...loaded], nextCursor: null });
      } else if (request.method === "thread/resume") {
        record.threads.add(request.params.threadId);
        result({ thread: { id: request.params.threadId, turns: [] } });
      } else if (["thread/start", "thread/fork"].includes(request.method)) {
        loaded.add("created-thread");
        record.threads.add("created-thread");
        result({ thread: { id: "created-thread", turns: [] } });
      } else if (request.method === "thread/realtime/start") {
        starts.push(request);
        if (options.rejectStart) {
          socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: "Rejected before submitting." } }));
        } else {
          if (!options.delayStartAck) result();
          if (options.ready !== false) setImmediate(() => {
            emit("thread/realtime/started", { threadId: request.params.threadId,
              realtimeSessionId: request.params.realtimeSessionId, version: "v3" });
            emit("thread/realtime/sdp", { threadId: request.params.threadId, sdp: "answer" });
          });
        }
      } else if (request.method === "thread/realtime/stop") {
        stops.push(request);
        result();
        if (options.closed !== false) setImmediate(() => emit("thread/realtime/closed", {
          threadId: request.params.threadId, reason: "requested",
        }));
      } else if (request.id != null) result({ echo: request.params });
    });
  });
  const nativeUrl = `ws://127.0.0.1:${native.address().port}`;
  const gateway = createRealtimeGateway({ port: 0, upstreamUrl: nativeUrl,
    reconnectDelayMs: 10, requestTimeoutMs: 500, ...options.gateway });
  const address = await gateway.start();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
    for (const record of records) record.socket.terminate();
    await new Promise((resolve) => native.close(resolve));
  });
  async function client(experimental = true) {
    const socket = new WebSocket(address.url);
    sockets.push(socket);
    const messages = [], pending = new Map();
    let nextId = 0;
    socket.on("error", () => {});
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.id != null && !message.method && pending.has(message.id)) {
        pending.get(message.id)(message); pending.delete(message.id);
      }
    });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const rpc = (method, params, id = ++nextId) => new Promise((resolve) => {
      pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
    });
    await rpc("initialize", { clientInfo: { name: "test-client", version: "1" },
      capabilities: { experimentalApi: experimental } });
    socket.send(JSON.stringify({ method: "initialized" }));
    await rpc("thread/resume", { threadId: "thread-a", excludeTurns: true });
    return { socket, messages, rpc };
  }
  return { gateway, address, nativeUrl, records, starts, stops, loaded, responses, emit, client,
    get control() { return control; } };
}

const phoneStart = (client, session = "phone-session-a") => client.rpc("remodex/realtime/start", {
  threadId: "thread-a", realtimeSessionId: session, leaseToken: token,
  version: "v3", outputModality: "audio", transport: { type: "webrtc", sdpOffer: "offer" },
});
const phoneParams = (session = "phone-session-a") => ({
  threadId: "thread-a", realtimeSessionId: session, leaseToken: token,
});
const desktopStart = (client, threadId = "thread-a") => client.rpc("thread/realtime/start", {
  threadId, version: "v3", outputModality: "audio", transport: { type: "webrtc", sdpOffer: "desktop-offer" },
});

test("ordinary RPCs keep raw bytes, IDs, and independent initialized connections", async (t) => {
  const h = await harness(t);
  const a = await h.client(), b = await h.client();
  const raw = '{ "id": "shared-id", "method": "thread/read", "params": { "threadId": "thread-a", "format": "unchanged" } }';
  a.socket.send(raw); b.socket.send(raw);
  await until(() => h.records.filter((r) => r.messages.some((m) => m.raw === raw)).length === 2);
  assert.equal(h.records.length, 3);
  for (const record of h.records) assert.equal(record.initialized, true);
  assert.equal(h.control.messages.some((m) => m.raw === raw), false);
});

test("phone and Desktop cannot replace or stop each other's Voice; stop remains fenced and idempotent", async (t) => {
  const h = await harness(t, { closed: false });
  const phone = await h.client(), desktop = await h.client();
  assert.deepEqual((await phoneStart(phone)).result, {});
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/sdp"));
  assert.ok((await desktopStart(desktop)).error);
  assert.ok((await desktop.rpc("thread/realtime/stop", { threadId: "thread-a" })).error);
  assert.ok((await desktop.rpc("thread/realtime/appendText", { threadId: "thread-a", text: "intrude" })).error);
  await phone.rpc("remodex/realtime/stop", phoneParams());
  await phone.rpc("remodex/realtime/stop", phoneParams());
  await until(() => h.stops.length === 1);
  assert.ok((await desktopStart(desktop)).error);
  h.emit("thread/realtime/closed", { threadId: "thread-a", reason: "transport_closed" });
  assert.equal((await phone.rpc("remodex/realtime/status", { threadId: "thread-a" })).result.state, "closing");
  h.emit("thread/realtime/closed", { threadId: "thread-a", reason: "requested" });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
  assert.deepEqual((await desktopStart(desktop)).result, {});
  assert.ok((await phone.rpc("remodex/realtime/stop", phoneParams())).error);
  assert.equal(h.stops.length, 1);
});

test("mobile realtime uses one ordered source and tagged session identity, without tokens", async (t) => {
  const h = await harness(t);
  const phone = await h.client();
  await phoneStart(phone);
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/sdp"));
  const events = phone.messages.filter((m) => m.method?.startsWith("thread/realtime/"));
  assert.deepEqual(events.map((m) => m.method), ["thread/realtime/started", "thread/realtime/sdp"]);
  for (const event of events) assert.equal(event.params.remodexRealtimeSessionId, "phone-session-a");
  assert.equal(h.starts[0].params.leaseToken, undefined);
  assert.equal(JSON.stringify(h.control.messages).includes(token), false);
  const status = await phone.rpc("remodex/realtime/status", { threadId: "thread-a" });
  assert.equal(status.result.realtimeSessionId, "phone-session-a");
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal((await phone.rpc("remodex/realtime/status", { threadId: "thread-b" })).result.state, "idle");
});

test("a reconnected phone proves its private lease; observer-visible session IDs cannot renew it", async (t) => {
  const h = await harness(t);
  const first = await h.client();
  await phoneStart(first);
  first.socket.terminate();
  await delay(20);
  assert.equal(h.stops.length, 0);
  const second = await h.client();
  assert.ok((await second.rpc("remodex/realtime/heartbeat", { ...phoneParams(), leaseToken: "b".repeat(64) })).error);
  assert.ok((await second.rpc("remodex/realtime/heartbeat", { threadId: "thread-a", realtimeSessionId: "phone-session-a" })).error);
  assert.equal((await second.rpc("remodex/realtime/heartbeat", phoneParams())).result.state, "active");
  h.emit("thread/realtime/transcript/delta", { threadId: "thread-a", role: "assistant", delta: "continued" });
  await until(() => second.messages.some((m) => m.params?.delta === "continued"));
  await second.rpc("remodex/realtime/stop", phoneParams());
  await until(() => h.stops.length === 1);
});

test("lease expiry submits only one stop and waits for the requested close", async (t) => {
  let clock = 0;
  const h = await harness(t, { closed: false, gateway: { leaseMs: 90, now: () => clock } });
  const phone = await h.client();
  await phoneStart(phone);
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/started"));
  clock = 89;
  await phone.rpc("remodex/realtime/heartbeat", phoneParams());
  clock = 100;
  await delay(40);
  assert.equal(h.stops.length, 0);
  clock = 180;
  await until(() => h.stops.length === 1);
  await delay(50);
  assert.equal(h.stops.length, 1);
  assert.equal((await phone.rpc("remodex/realtime/status", { threadId: "thread-a" })).result.state, "closing");
});

test("provider startup error queues cleanup even though native start already acknowledged", async (t) => {
  const h = await harness(t, { ready: false, closed: false });
  const phone = await h.client(), desktop = await h.client();
  await phoneStart(phone);
  h.emit("thread/realtime/error", { threadId: "thread-a", message: "Provider startup failed." });
  await until(() => h.stops.length === 1);
  assert.ok((await desktopStart(desktop)).error);
  h.emit("thread/realtime/closed", { threadId: "thread-a", reason: "requested" });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
  assert.equal((await phone.rpc("remodex/realtime/status", { threadId: "thread-a" })).result.state, "idle");
});

test("startup timeout retains the fence; late SDP is not delivered to the abandoned call", async (t) => {
  const h = await harness(t, { ready: false, delayStartAck: true, closed: false,
    gateway: { requestTimeoutMs: 60 } });
  const phone = await h.client(), desktop = await h.client();
  assert.ok((await phoneStart(phone)).error);
  await until(() => h.stops.length === 1);
  assert.ok((await desktopStart(desktop)).error);
  h.emit("thread/realtime/started", { threadId: "thread-a", realtimeSessionId: "phone-session-a", version: "v3" });
  h.emit("thread/realtime/sdp", { threadId: "thread-a", sdp: "late-answer" });
  await delay(30);
  assert.equal(phone.messages.some((m) => m.params?.sdp === "late-answer"), false);
  assert.equal(phone.messages.some((m) => m.method === "thread/realtime/started"), false);
  h.emit("thread/realtime/closed", { threadId: "thread-a", reason: "requested" });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
});

test("native rejection before submit releases ownership; unloaded tasks never cold-resume", async (t) => {
  const h = await harness(t, { rejectStart: true });
  const phone = await h.client();
  assert.ok((await phoneStart(phone)).error);
  assert.equal((await phone.rpc("remodex/realtime/status", { threadId: "thread-a" })).result.state, "idle");
  assert.equal(h.stops.length, 0);
  const response = await phone.rpc("remodex/realtime/start", {
    ...phoneParams(), threadId: "unloaded", outputModality: "audio",
  });
  assert.ok(response.error);
  assert.equal(h.control.messages.some((m) => m.request.method === "thread/resume"
    && m.request.params.threadId === "unloaded"), false);
});

test("control-origin server requests round-trip to the task owner after Voice hangs up", async (t) => {
  const h = await harness(t);
  const phone = await h.client();
  await phoneStart(phone);
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/started"));
  await phone.rpc("remodex/realtime/stop", phoneParams());
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
  h.control.socket.send(JSON.stringify({ id: 42, method: "item/tool/call", params: { threadId: "thread-a", tool: "example" } }));
  await until(() => phone.messages.some((m) => m.method === "item/tool/call"));
  const request = phone.messages.find((m) => m.method === "item/tool/call");
  assert.notEqual(request.id, 42);
  phone.socket.send(JSON.stringify({ id: request.id, result: { content: [{ type: "text", text: "done" }] } }));
  await until(() => h.responses.length === 1);
  assert.equal(h.responses[0].record, h.control);
  assert.deepEqual(h.responses[0].request, { id: 42, result: { content: [{ type: "text", text: "done" }] } });
});

test("control reconnection reinitializes and subscribes before cleanup, keeping a single fence", async (t) => {
  const h = await harness(t, { closed: false });
  const phone = await h.client(), desktop = await h.client();
  await phoneStart(phone);
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/started"));
  const previous = h.control;
  previous.socket.terminate();
  await until(() => h.control !== previous && h.stops.length === 1);
  const methods = h.control.messages.map((m) => m.request.method);
  assert.ok(methods.indexOf("initialize") < methods.indexOf("thread/resume"));
  assert.ok(methods.indexOf("thread/resume") < methods.indexOf("thread/realtime/stop"));
  assert.ok((await desktopStart(desktop)).error);
  h.emit("thread/realtime/closed", { threadId: "thread-a", reason: "requested" });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
  assert.deepEqual((await desktopStart(desktop)).result, {});
});

test("Voice cannot bypass a client's experimental initialization", async (t) => {
  const h = await harness(t);
  const client = await h.client(false);
  assert.ok((await phoneStart(client)).error);
  assert.equal(h.starts.length, 0);
});

test("only loopback and clients without browser Origin may reach the gateway", async (t) => {
  assert.throws(() => createRealtimeGateway({ listenHost: "0.0.0.0" }), /loopback/);
  assert.throws(() => createRealtimeGateway({ upstreamUrl: "ws://example.com:4511" }), /loopback/);
  const h = await harness(t);
  const browser = new WebSocket(h.address.url, { headers: { Origin: "https://untrusted.example" } });
  const error = await new Promise((resolve) => browser.once("error", resolve));
  assert.match(error.message, /401/);
  browser.terminate();
  assert.equal(h.records.length, 1);
});


for (const method of ["thread/start", "thread/fork"]) test(`${method} tracks the Desktop owner for approvals after phone disconnect`, async (t) => {
  const h = await harness(t);
  const desktop = await h.client(), phone = await h.client();
  const created = await desktop.rpc(method, { cwd: "C:/workspace", threadId: "thread-a" });
  const threadId = created.result.thread.id;
  await phone.rpc("remodex/realtime/start", { ...phoneParams(), threadId, outputModality: "audio" });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/started"));
  await phone.rpc("remodex/realtime/stop", { ...phoneParams(), threadId });
  await until(() => phone.messages.some((m) => m.method === "thread/realtime/closed"));
  phone.socket.terminate();
  await delay(15);
  h.control.socket.send(JSON.stringify({ id: 71, method: "item/commandExecution/requestApproval",
    params: { threadId, itemId: "command-a", turnId: "turn-a" } }));
  await until(() => desktop.messages.some((m) => m.method === "item/commandExecution/requestApproval"));
  const request = desktop.messages.find((m) => m.method === "item/commandExecution/requestApproval");
  desktop.socket.send(JSON.stringify({ id: request.id, result: { decision: "accept" } }));
  await until(() => h.responses.length === 1);
  assert.deepEqual(h.responses[0].request, { id: 71, result: { decision: "accept" } });
});


test("a port collision rejects startup and closes its initialized control connection", async (t) => {
  const h = await harness(t);
  const gateway = createRealtimeGateway({ port: h.address.port, upstreamUrl: h.nativeUrl });
  await assert.rejects(gateway.start(), /EADDRINUSE/);
  await until(() => h.records.length === 2 && h.records[1].socket.readyState === WebSocket.CLOSED);
});
