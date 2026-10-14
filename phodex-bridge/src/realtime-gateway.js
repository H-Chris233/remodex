// Keeps realtime ownership on one ordered control connection; task RPCs stay per-client.
const { randomUUID, timingSafeEqual } = require("node:crypto");
const WebSocket = require("ws");

function createRealtimeGateway({
  listenHost = "127.0.0.1", port = 4510, upstreamUrl = "ws://127.0.0.1:4511",
  WebSocketImpl = WebSocket, WebSocketServerImpl = WebSocket.Server,
  leaseMs = 45_000, requestTimeoutMs = 20_000, reconnectDelayMs = 1_000,
  now = Date.now,
} = {}) {
  const loopback = (host) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);
  const upstream = new URL(upstreamUrl);
  if (!loopback(listenHost) || upstream.protocol !== "ws:" || !loopback(upstream.hostname)
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("The realtime gateway and native runtime must use credential-free loopback addresses.");
  }
  let server, control, controlReady, reconnectTimer, leaseTimer, closing = false;
  const clients = new Set();
  const calls = new Map();
  const taskOwners = new Map();
  const serverRequests = new Map();
  const waiters = new Map();
  const subscribed = new Set();
  const subscriptions = new Map();
  const idKey = (id) => `${typeof id}:${id}`;
  const parse = (data) => { try { return JSON.parse(data.toString()); } catch { return null; } };
  const open = (socket) => socket?.readyState === WebSocketImpl.OPEN;
  const send = (socket, value) => { if (open(socket)) socket.send(JSON.stringify(value)); };
  const reply = (client, request, result = {}) => send(client.socket, { id: request.id, result });
  const reject = (client, request, message, code = -32004) => send(client.socket, {
    id: request.id, error: { code, message },
  });
  const tokenBytes = (token) => Buffer.from(token, "hex");
  const validToken = (token) => typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
  const ownsPhone = (call, params) => Boolean(call?.phone && call.sessionId === params?.realtimeSessionId
    && validToken(params?.leaseToken) && timingSafeEqual(call.tokenBytes, tokenBytes(params.leaseToken)));
  const callState = (call) => ({ supported: true, protocolVersion: 1,
    state: call?.phase || "idle", threadId: call?.threadId || null,
    realtimeSessionId: call?.sessionId || null });

  function release(call) {
    if (calls.get(call.threadId) === call) calls.delete(call.threadId);
  }

  function forwardRealtime(message) {
    const call = calls.get(message.params?.threadId);
    if (!call) return;
    if (message.method === "thread/realtime/started") {
      if (message.params?.realtimeSessionId !== call.sessionId) return;
      call.startObserved = true;
      if (call.phase === "closing") return;
      call.phase = "active";
    } else if (message.method === "thread/realtime/error") {
      call.startFailed = true;
    } else if (message.method === "thread/realtime/closed") {
      // A queued stop's requested close is the barrier after startup and prior fanout.
      if (!call.startObserved && !call.startFailed && !call.controlLost) return;
      if (call.phase === "closing" && message.params?.reason !== "requested") return;
    } else if (!call.startObserved || call.phase === "closing") {
      return;
    }
    send(call.client.socket, call.phone ? {
      ...message, params: { ...message.params, remodexRealtimeSessionId: call.sessionId },
    } : message);
    if (message.method === "thread/realtime/closed") release(call);
    if (message.method === "thread/realtime/error") void stopCall(call);
  }

  function requestOwner(message) {
    const threadId = message.params?.threadId || message.params?.conversationId;
    const preferred = calls.get(threadId)?.client || taskOwners.get(threadId)
      || (!threadId && [...calls.values()].find((call) => open(call.client.socket))?.client);
    if (preferred && open(preferred.socket)) return preferred;
    return [...clients].find((client) => client.initialized && open(client.socket)
      && (!threadId || client.threads.has(threadId))) || null;
  }

  function deliverServerRequest(entry) {
    const client = requestOwner(entry.message);
    if (!client) return;
    entry.client = client;
    entry.downstreamId = `remodex-gateway-request-${randomUUID()}`;
    send(client.socket, { ...entry.message, id: entry.downstreamId });
  }

  function handleControlMessage(data) {
    const message = parse(data);
    if (!message) return;
    if (message.id != null && !message.method) {
      const waiter = waiters.get(idKey(message.id));
      if (!waiter) return;
      waiters.delete(idKey(message.id));
      clearTimeout(waiter.timer);
      if (message.error) {
        const error = new Error(message.error.message || "Native runtime rejected the gateway request.");
        error.rpcError = message.error;
        waiter.reject(error);
      } else waiter.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      const entry = { message, client: null, downstreamId: null };
      serverRequests.set(idKey(message.id), entry);
      deliverServerRequest(entry);
      return;
    }
    if (message.method?.startsWith("thread/realtime/")) forwardRealtime(message);
    if (message.method === "serverRequest/resolved") {
      const entry = serverRequests.get(idKey(message.params?.requestId));
      if (entry?.client) send(entry.client.socket, {
        ...message, params: { ...message.params, requestId: entry.downstreamId },
      });
      serverRequests.delete(idKey(message.params?.requestId));
    }
  }

  function nativeRequest(method, params, socket = control) {
    if (!open(socket)) return Promise.reject(new Error("Native realtime control is disconnected."));
    const id = `remodex-gateway-${randomUUID()}`;
    return new Promise((resolve, rejectRequest) => {
      const timer = setTimeout(() => {
        waiters.delete(idKey(id));
        rejectRequest(new Error(`Native realtime control request timed out: ${method}`));
      }, requestTimeoutMs);
      waiters.set(idKey(id), { resolve, reject: rejectRequest, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const waiter = waiters.get(idKey(id));
        if (!waiter) return;
        waiters.delete(idKey(id));
        clearTimeout(timer);
        rejectRequest(error);
      });
    });
  }

  async function connectControl() {
    const socket = new WebSocketImpl(upstreamUrl, { perMessageDeflate: false });
    control = socket;
    socket.on("message", (data) => { if (control === socket) handleControlMessage(data); });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (control !== socket) return;
      controlReady = null;
      subscribed.clear();
      subscriptions.clear();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Native realtime control connection closed."));
      }
      waiters.clear();
      // Lost events cannot prove the session ended. Retain the fence until cleanup.
      for (const call of calls.values()) {
        call.phase = "closing";
        call.stopSent = false;
        call.controlLost = true;
      }
      serverRequests.clear();
      if (!closing) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void ensureControl().then(async () => {
          for (const call of [...calls.values()]) await stopCall(call);
        }).catch(() => {});
      }, reconnectDelayMs);
    });
    await new Promise((resolve, rejectOpen) => {
      socket.once("open", resolve);
      socket.once("error", rejectOpen);
      socket.once("close", () => rejectOpen(new Error("Native realtime control closed before connecting.")));
    });
    await nativeRequest("initialize", { clientInfo: {
      name: "remodex_realtime_gateway", title: "Remodex Realtime Gateway", version: "1",
    }, capabilities: { experimentalApi: true } }, socket);
    send(socket, { method: "initialized" });
    return socket;
  }

  function ensureControl() {
    if (closing && !open(control)) return Promise.reject(new Error("The realtime gateway is shutting down."));
    if (!controlReady) {
      const attempt = connectControl();
      controlReady = attempt;
      attempt.catch(() => {
        if (controlReady === attempt) {
          controlReady = null;
          control?.terminate();
        }
      });
    }
    return controlReady;
  }

  async function subscribe(threadId) {
    await ensureControl();
    if (subscribed.has(threadId)) return;
    if (subscriptions.has(threadId)) return subscriptions.get(threadId);
    const socket = control;
    const attempt = (async () => {
      let cursor;
      const cursors = new Set();
      for (;;) {
        const page = await nativeRequest("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (page?.data?.includes(threadId)) break;
        cursor = page?.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("The task is not loaded in the shared runtime. Open it in Codex first.");
        cursors.add(cursor);
      }
      // Only an already loaded thread may be resumed: this subscribes without acquiring another writer.
      const result = await nativeRequest("thread/resume", { threadId, excludeTurns: true });
      if (result?.thread?.id !== threadId) throw new Error("The shared runtime resumed a different task.");
      if (control !== socket || !open(socket)) throw new Error("Native realtime control changed while subscribing.");
      subscribed.add(threadId);
    })();
    subscriptions.set(threadId, attempt);
    try { await attempt; } finally { if (subscriptions.get(threadId) === attempt) subscriptions.delete(threadId); }
  }

  async function stopCall(call) {
    if (calls.get(call.threadId) !== call) return;
    call.phase = "closing";
    if (!call.submitted) { release(call); return; }
    if (call.stopSent) return;
    call.stopSent = true;
    try {
      await subscribe(call.threadId);
      await nativeRequest("thread/realtime/stop", { threadId: call.threadId });
    } catch (error) {
      if (!open(control) || error.rpcError) call.stopSent = false;
      // A timeout cannot prove non-delivery; keep the single queued stop fenced.
    }
  }

  async function startCall(client, message, phone) {
    const params = message.params || {};
    const threadId = params.threadId;
    if (!client.initialized || !client.experimental) {
      reject(client, message, "Initialize with experimentalApi=true before starting Voice.", -32600);
      return;
    }
    if (typeof threadId !== "string" || !threadId || (phone && (!validToken(params.leaseToken)
      || typeof params.realtimeSessionId !== "string" || !params.realtimeSessionId || params.realtimeSessionId.length > 128))) {
      reject(client, message, "Voice requires a threadId and a private lease token.", -32602);
      return;
    }
    if (calls.has(threadId) || (phone && [...calls.values()].some((call) => call.phone))) {
      reject(client, message, "A realtime session is already active or being cleaned up.");
      return;
    }
    const sessionId = typeof params.realtimeSessionId === "string" && params.realtimeSessionId
      ? params.realtimeSessionId : randomUUID();
    const call = { threadId, sessionId, client, phone, phase: "starting", submitted: false,
      startObserved: false, startFailed: false, stopSent: false,
      tokenBytes: phone ? tokenBytes(params.leaseToken) : null, expiresAt: now() + leaseMs };
    calls.set(threadId, call);
    try {
      await subscribe(threadId);
      if (calls.get(threadId) !== call || (client.closed && !phone)) throw new Error("Voice startup was cancelled.");
      const { leaseToken, ...startParams } = params;
      call.submitted = true;
      taskOwners.set(threadId, client);
      const result = await nativeRequest("thread/realtime/start", { ...startParams, realtimeSessionId: sessionId });
      reply(client, message, result || {});
    } catch (error) {
      if (!call.submitted || error.rpcError) release(call);
      else void stopCall(call);
      reject(client, message, error.message, error.rpcError?.code || -32004);
    }
  }

  async function handle(client, data, binary) {
    const message = parse(data);
    if (message?.id != null && !message.method) {
      const entry = [...serverRequests.values()].find((entry) => entry.client === client
        && entry.downstreamId === message.id && !entry.answered);
      if (entry) {
        entry.answered = true;
        send(control, { ...message, id: entry.message.id });
        return;
      }
    }
    if (closing) { if (message?.id != null) reject(client, message, "The realtime gateway is shutting down."); return; }
    const method = message?.method;
    if (method === "remodex/realtime/status") {
      const call = message.params?.threadId ? calls.get(message.params.threadId)
        : [...calls.values()].find((call) => call.phone) || calls.values().next().value;
      reply(client, message, callState(call));
      return;
    }
    if (method === "remodex/realtime/heartbeat" || method === "remodex/realtime/stop") {
      const call = calls.get(message.params?.threadId);
      if (!ownsPhone(call, message.params)) {
        reject(client, message, "The Voice lease does not match the current session."); return;
      }
      if (!client.initialized || !client.experimental) {
        reject(client, message, "Initialize the runtime before renewing Voice.", -32600); return;
      }
      call.client = client;
      taskOwners.set(call.threadId, client);
      if (method.endsWith("heartbeat")) {
        if (call.phase === "closing") { reject(client, message, "Voice is being cleaned up."); return; }
        call.expiresAt = now() + leaseMs;
        reply(client, message, callState(call));
      } else { void stopCall(call); reply(client, message); }
      return;
    }
    if (method === "thread/realtime/start" || method === "remodex/realtime/start") {
      await startCall(client, message, method.startsWith("remodex/")); return;
    }
    if (method === "thread/realtime/stop") {
      const call = calls.get(message.params?.threadId);
      if (!call || call.phone || call.client !== client) {
        reject(client, message, "Only the current realtime owner can stop this session."); return;
      }
      void stopCall(call); reply(client, message); return;
    }
    if (["thread/realtime/appendAudio", "thread/realtime/appendText", "thread/realtime/appendSpeech"].includes(method)) {
      const call = calls.get(message.params?.threadId);
      if (!call || call.client !== client || call.phase === "closing") {
        reject(client, message, "Only the current realtime owner can append to this session."); return;
      }
      try { reply(client, message, await nativeRequest(method, message.params)); }
      catch (error) { reject(client, message, error.message, error.rpcError?.code || -32004); }
      return;
    }
    if (method?.startsWith("remodex/realtime/")) {
      reject(client, message, "Unknown realtime gateway method.", -32601); return;
    }
    if (method === "initialize" && message.id != null) client.initializes.set(idKey(message.id),
      message.params?.capabilities?.experimentalApi === true);
    if (["thread/resume", "thread/start", "thread/fork"].includes(method) && message.id != null)
      client.threadRequests.set(idKey(message.id), message.params?.threadId);
    if (open(client.upstream)) client.upstream.send(data, { binary });
    else {
      client.queuedBytes += data.length;
      if (client.queue.length >= 64 || client.queuedBytes > 256 * 1024 * 1024) {
        client.socket.close(1013, "Native runtime is unavailable."); return;
      }
      client.queue.push([data, binary]);
    }
  }

  function accept(socket) {
    const client = { socket, upstream: new WebSocketImpl(upstreamUrl, { perMessageDeflate: false }),
      queue: [], queuedBytes: 0, initialized: false, experimental: false, closed: false,
      initializes: new Map(), threadRequests: new Map(), threads: new Set() };
    clients.add(client);
    socket.on("error", () => {});
    // Do not serialize a long start with its heartbeat/stop: the owner is reserved synchronously.
    socket.on("message", (data, binary) => void handle(client, data, binary).catch(() => socket.close(1011, "Gateway request failed.")));
    socket.on("close", () => {
      client.closed = true;
      clients.delete(client);
      client.upstream.terminate();
      for (const call of calls.values()) if (call.client === client && !call.phone) void stopCall(call);
      for (const entry of serverRequests.values()) if (entry.client === client && !entry.answered) {
        entry.client = null; deliverServerRequest(entry);
      }
    });
    client.upstream.on("open", () => {
      for (const [data, binary] of client.queue) client.upstream.send(data, { binary });
      client.queue = []; client.queuedBytes = 0;
    });
    client.upstream.on("message", (data, binary) => {
      const message = parse(data);
      if (message?.method?.startsWith("thread/realtime/")) return;
      if (message?.id != null && !message.method) {
        const key = idKey(message.id);
        if (client.initializes.has(key)) {
          if (!message.error) { client.initialized = true; client.experimental = client.initializes.get(key); }
          client.initializes.delete(key);
        }
        if (client.threadRequests.has(key)) {
          const threadId = message.result?.thread?.id || client.threadRequests.get(key);
          if (!message.error && typeof threadId === "string") client.threads.add(threadId);
          client.threadRequests.delete(key);
        }
        for (const entry of serverRequests.values()) if (!entry.client && !entry.answered) deliverServerRequest(entry);
      }
      if (open(socket)) socket.send(data, { binary });
    });
    client.upstream.on("error", () => socket.close(1011, "Native runtime connection failed."));
    client.upstream.on("close", () => socket.close(1011, "Native runtime disconnected."));
  }

  return {
    async start() {
      if (server) throw new Error("The realtime gateway is already running.");
      try {
        await ensureControl();
        server = new WebSocketServerImpl({ host: listenHost, port,
          verifyClient: ({ req }) => !req.headers.origin && loopback(req.socket.remoteAddress?.replace(/^::ffff:/, "")) });
        server.on("connection", accept);
        await new Promise((resolve, rejectStart) => { server.once("listening", resolve); server.once("error", rejectStart); });
      } catch (error) {
        await this.close();
        throw error;
      }
      leaseTimer = setInterval(() => {
        for (const call of calls.values()) {
          if ((call.phone && now() >= call.expiresAt) || (call.phase === "closing" && !call.stopSent)) void stopCall(call);
        }
      }, Math.min(1_000, Math.max(10, leaseMs / 3)));
      leaseTimer.unref();
      return { host: listenHost, port: server.address().port, url: `ws://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${server.address().port}` };
    },
    async close() {
      closing = true;
      for (const call of [...calls.values()]) await stopCall(call);
      clearTimeout(reconnectTimer); clearInterval(leaseTimer);
      for (const client of clients) { client.socket.terminate(); client.upstream.terminate(); }
      control?.terminate();
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}

module.exports = { createRealtimeGateway };
