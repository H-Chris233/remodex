// Keeps realtime ownership on one ordered control connection; task RPCs stay per-client.
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const WebSocket = require("ws");

function createRealtimeGateway({
  listenHost = "127.0.0.1", port = 4510, upstreamUrl = "ws://127.0.0.1:4511",
  gatewayToken = randomBytes(32).toString("hex"), nativeToken = "",
  WebSocketImpl = WebSocket, WebSocketServerImpl = WebSocket.Server,
  leaseMs = 45_000, requestTimeoutMs = 20_000, reconnectDelayMs = 1_000,
  now = () => performance.now(),
} = {}) {
  const loopback = (host) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);
  const upstream = new URL(upstreamUrl);
  if (!loopback(listenHost) || upstream.protocol !== "ws:" || !loopback(upstream.hostname)
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("The realtime gateway and native runtime must use credential-free loopback addresses.");
  }
  if (typeof gatewayToken !== "string" || !/^[0-9a-f]{64}$/.test(gatewayToken)
    || typeof nativeToken !== "string" || (nativeToken && !/^[0-9a-f]{64}$/.test(nativeToken))) {
    throw new Error("Gateway and native tokens must be 32-byte lowercase hex secrets.");
  }
  const secretPath = Buffer.from(`/voice/${gatewayToken}`);
  const authenticatedPath = (url) => typeof url === "string" && Buffer.byteLength(url) === secretPath.length
    && timingSafeEqual(Buffer.from(url), secretPath);
  const upstreamOptions = { perMessageDeflate: false,
    ...(nativeToken ? { headers: { Authorization: `Bearer ${nativeToken}` } } : {}) };
  let server, control, controlReady, controlInitialized = false, reconnectTimer, leaseTimer, closing = false;
  const clients = new Set();
  const calls = new Map();
  const taskOwners = new Map();
  const taskCreators = new Map();
  const taskRestorations = new Map();
  const resolvedRequestIds = [];
  const serverRequests = new Map();
  const waiters = new Map();
  const loadedThreads = new Set();
  const loadedChecks = new Map();
  const idKey = (id) => `${typeof id}:${id}`;
  const parse = (data) => { try { return JSON.parse(data.toString()); } catch { return null; } };
  const open = (socket) => socket?.readyState === WebSocketImpl.OPEN;
  const send = (socket, value) => { if (open(socket)) socket.send(JSON.stringify(value)); };
  const reply = (client, request, result = {}) => send(client.socket, { id: request.id, result });
  const reject = (client, request, message, code = -32004, errorCode = "control_unavailable", data = {}) => send(client.socket, {
    id: request.id, error: { code, message, data: { errorCode, ...data } },
  });
  const rejectError = (client, request, error) => error.rpcError
    ? send(client.socket, { id: request.id, error: error.rpcError })
    : reject(client, request, error.message, -32004, error.errorCode || "control_unavailable");
  const threadIdOf = (message) => message.params?.threadId || message.params?.thread?.id;
  const gatewayError = (message, errorCode) => Object.assign(new Error(message), { errorCode });
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

  const recoveryParams = (call) => call.phone && call.controlRecovery && !closing && now() < call.expiresAt
    ? { remodexRealtimeRecovery: "controlLost" } : {};

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
      ...message, params: { ...message.params, remodexRealtimeSessionId: call.sessionId,
        ...(message.method === "thread/realtime/closed" ? recoveryParams(call) : {}) },
    } : message);
    if (message.method === "thread/realtime/closed") release(call);
    if (message.method === "thread/realtime/error") void stopCall(call);
  }

  function taskOwner(threadId) {
    if (!taskOwners.has(threadId)) return null;
    let owner = taskOwners.get(threadId);
    if (!open(owner.socket)) {
      owner = [...clients].find((client) => client.initialized && open(client.socket) && client.threads.has(threadId));
      if (owner) taskOwners.set(threadId, owner);
    }
    return owner && open(owner.socket) ? owner : null;
  }

  const phoneSupports = (method) => method === "item/tool/requestUserInput"
    || method === "tool/requestUserInput" || method.endsWith("requestApproval");
  const deviceVerification = (message) => message.method === "mcpServer/elicitation/request"
    && message.params?.mode === "openai/userVerification";

  function decorateRequest(client, message) {
    return client.phone && message.method.endsWith("requestApproval") ? {
      ...message, params: { ...message.params, remodexActionSource: "sharedRuntime" },
    } : message;
  }

  function requestOwner(message) {
    const threadId = threadIdOf(message) || message.params?.conversationId;
    if (!phoneSupports(message.method)) {
      const creator = taskCreators.get(threadId);
      if (creator?.initialized && !creator.phone && open(creator.socket)) return creator;
      const desktops = [...clients].filter((client) => client.initialized && !client.phone
        && open(client.socket) && (!threadId || client.threads.has(threadId)));
      return desktops.find((client) => /codex.*desktop/i.test(client.name || "")) || desktops[0] || null;
    }
    const preferred = calls.get(threadId)?.client || taskOwner(threadId)
      || (!threadId && [...calls.values()].find((call) => open(call.client.socket))?.client);
    if (preferred && open(preferred.socket)) return preferred;
    return [...clients].find((client) => client.initialized && open(client.socket)
      && (!threadId || client.threads.has(threadId))) || null;
  }

  function deliverServerRequest(entry) {
    if (entry.resolved || entry.response || (entry.client && open(entry.client.socket))) return;
    const client = requestOwner(entry.message);
    if (!client) return;
    entry.client = client;
    // Desktop receives its native ID; mobile IDs stay distinct from its independent upstream.
    entry.downstreamId = client.phone ? `remodex-gateway-request-${randomUUID()}` : entry.message.id;
    entry.dispatched = true;
    send(client.socket, decorateRequest(client, { ...entry.message, id: entry.downstreamId }));
  }

  function receiveServerRequest(message, source) {
    const key = idKey(message.id);
    let entry = serverRequests.get(key);
    if (!entry) {
      entry = { message, client: null, downstreamId: null, recipients: new Set() };
      serverRequests.set(key, entry);
    }
    entry.recipients.add(source);
    if (entry.resolved) return;
    if (entry.response) void flushServerResponse(entry);
    else deliverServerRequest(entry);
  }

  async function flushServerResponse(entry) {
    if (!entry.response || entry.resolved || entry.answered || entry.sending) return;
    entry.sending = true;
    try {
      let socket = controlInitialized && open(control) ? control
        : [...entry.recipients].find((recipient) => recipient !== control && open(recipient));
      if (!socket) socket = await ensureControl();
      if (entry.resolved || !entry.response) return;
      const response = { ...entry.response, id: entry.message.id };
      entry.sentSocket = socket;
      await new Promise((resolve, rejectSend) => socket.send(JSON.stringify(response),
        (error) => error ? rejectSend(error) : resolve()));
      entry.answered = true;
    } catch { /* Keep the original ID and answer until an initialized connection recovers. */ }
    finally { entry.sending = false; }
  }

  function resolveServerRequest(message) {
    const key = idKey(message.params?.requestId);
    const entry = serverRequests.get(key);
    if (!entry) return null;
    if (!entry.resolved) {
      entry.resolved = true;
      entry.response = null;
      if (entry.client) send(entry.client.socket, {
        ...message, params: { ...message.params, requestId: entry.downstreamId },
      });
      // Keep recent terminal IDs so late UI answers and native replays cannot resurrect prompts.
      resolvedRequestIds.push(key);
      if (resolvedRequestIds.length > 500) serverRequests.delete(resolvedRequestIds.shift());
    }
    return entry;
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
      receiveServerRequest(message, control);
      return;
    }
    if (message.method?.startsWith("thread/realtime/")) {
      const restoration = taskRestorations.get(threadIdOf(message));
      if (restoration?.submitted && message.method === "thread/realtime/closed" && message.params?.reason === "requested") {
        restoration.complete();
        return;
      }
      forwardRealtime(message);
      return;
    }
    if (message.method === "serverRequest/resolved" && resolveServerRequest(message)) return;
    const threadId = threadIdOf(message);
    const owner = taskOwner(threadId);
    // Realtime start subscribes control even when an empty task has no resumable rollout.
    if (owner) send(owner.socket, message);
    if (["thread/closed", "thread/deleted"].includes(message.method)) {
      taskOwners.delete(threadId);
      taskCreators.delete(threadId);
      loadedThreads.delete(threadId);
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
    const socket = new WebSocketImpl(upstreamUrl, upstreamOptions);
    control = socket;
    socket.on("message", (data) => { if (control === socket) handleControlMessage(data); });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (control !== socket) return;
      controlReady = null;
      controlInitialized = false;
      for (const restoration of taskRestorations.values()) restoration.abort();
      loadedThreads.clear();
      loadedChecks.clear();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Native realtime control connection closed."));
      }
      waiters.clear();
      // Lost events cannot prove the session ended. Retain the fence until cleanup.
      for (const call of calls.values()) {
        if (call.phone && call.phase !== "closing" && !closing && now() < call.expiresAt) {
          call.controlRecovery = true;
          // Signal before the internal stop can close WebRTC's data channel.
          send(call.client.socket, { method: "remodex/realtime/recovering", params: {
            threadId: call.threadId, remodexRealtimeSessionId: call.sessionId, ...recoveryParams(call),
          } });
        }
        call.phase = "closing";
        call.stopSent = false;
        call.controlLost = true;
      }
      for (const entry of serverRequests.values()) if (entry.sentSocket === socket && !entry.resolved) entry.answered = false;
      if (!closing) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void ensureControl().then(async () => {
          for (const call of [...calls.values()]) if (call.controlLost && call.phase === "closing") await stopCall(call);
          await Promise.allSettled([...taskOwners.keys()].filter((threadId) => !calls.has(threadId)).map(restoreTask));
          for (const entry of serverRequests.values()) if (entry.response) void flushServerResponse(entry);
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
    controlInitialized = true;
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

  async function ensureLoaded(threadId) {
    await ensureControl();
    if (loadedThreads.has(threadId)) return;
    if (loadedChecks.has(threadId)) return loadedChecks.get(threadId);
    const socket = control;
    const attempt = (async () => {
      let cursor;
      const cursors = new Set();
      for (;;) {
        const page = await nativeRequest("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (page?.data?.includes(threadId)) break;
        cursor = page?.nextCursor;
        if (!cursor || cursors.has(cursor)) throw gatewayError("The task is not loaded in the shared runtime. Open it in Codex first.", "thread_not_loaded");
        cursors.add(cursor);
      }
      // Native realtime RPCs attach this connection before enqueueing; resume needs a rollout even for loaded empty tasks.
      if (control !== socket || !open(socket)) throw new Error("Native realtime control changed while checking the loaded task.");
      loadedThreads.add(threadId);
    })();
    loadedChecks.set(threadId, attempt);
    try { await attempt; } finally { if (loadedChecks.get(threadId) === attempt) loadedChecks.delete(threadId); }
  }

  function restoreTask(threadId) {
    if (taskRestorations.has(threadId)) return taskRestorations.get(threadId).promise;
    let resolveClosed, rejectClosed;
    const closed = new Promise((resolve, rejectRestore) => { resolveClosed = resolve; rejectClosed = rejectRestore; });
    closed.catch(() => {});
    const restoration = { submitted: false, timer: null,
      complete() {
        this.done = true;
        clearTimeout(this.timer);
        if (taskRestorations.get(threadId) === this) taskRestorations.delete(threadId);
        const owner = taskOwner(threadId);
        if (owner?.phone) send(owner.socket, { method: "thread/replaced", params: { threadId } });
        resolveClosed();
      },
      abort() {
        clearTimeout(this.timer);
        if (taskRestorations.get(threadId) === this) taskRestorations.delete(threadId);
        rejectClosed(gatewayError("The task listener connection closed while recovering.", "control_unavailable"));
      },
    };
    taskRestorations.set(threadId, restoration);
    restoration.promise = (async () => {
      try {
        await ensureLoaded(threadId);
        restoration.submitted = true;
        // No active Voice owns this fenced thread. Stop reattaches without requiring a persisted rollout or a turn.
        await nativeRequest("thread/realtime/stop", { threadId });
        if (!restoration.done) restoration.timer = setTimeout(() => rejectClosed(gatewayError("The task listener is still recovering.", "control_unavailable")), requestTimeoutMs);
        await closed;
      } catch (error) {
        if (restoration.done) return;
        if (!restoration.submitted) restoration.abort();
        throw error;
      }
    })();
    restoration.promise.catch(() => {});
    return restoration.promise;
  }

  async function stopCall(call) {
    if (calls.get(call.threadId) !== call) return;
    call.phase = "closing";
    if (!call.submitted) { release(call); return; }
    if (call.stopSent) return;
    call.stopSent = true;
    try {
      await ensureLoaded(call.threadId);
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
      reject(client, message, "Initialize with experimentalApi=true before starting Voice.", -32600, "not_initialized");
      return;
    }
    if (typeof threadId !== "string" || !threadId || (phone && (!validToken(params.leaseToken)
      || typeof params.realtimeSessionId !== "string" || !params.realtimeSessionId || params.realtimeSessionId.length > 128))) {
      reject(client, message, "Voice requires a threadId, sessionId and a private lease token.", -32602, "invalid_params");
      return;
    }
    if (phone) client.phone = true;
    const restoration = taskRestorations.get(threadId);
    if (restoration) {
      try { await restoration.promise; } catch (error) { rejectError(client, message, error); return; }
    }
    if (calls.has(threadId) || (phone && [...calls.values()].some((call) => call.phone))) {
      reject(client, message, "A realtime session is already active or being cleaned up.", -32004, "voice_busy");
      return;
    }
    const sessionId = typeof params.realtimeSessionId === "string" && params.realtimeSessionId
      ? params.realtimeSessionId : randomUUID();
    const call = { threadId, sessionId, client, phone, phase: "starting", submitted: false,
      startObserved: false, startFailed: false, stopSent: false,
      tokenBytes: phone ? tokenBytes(params.leaseToken) : null, expiresAt: now() + leaseMs };
    calls.set(threadId, call);
    const priorOwner = taskOwners.get(threadId);
    try {
      await ensureLoaded(threadId);
      if (calls.get(threadId) !== call || (client.closed && !phone)) throw gatewayError("Voice startup was cancelled.", "startup_cancelled");
      const { leaseToken, ...startParams } = params;
      call.submitted = true;
      taskOwners.set(threadId, client);
      const result = await nativeRequest("thread/realtime/start", { ...startParams, realtimeSessionId: sessionId });
      reply(client, message, result || {});
    } catch (error) {
      if (!call.submitted || error.rpcError) {
        release(call);
        if (taskOwners.get(threadId) === client) {
          if (priorOwner) taskOwners.set(threadId, priorOwner); else taskOwners.delete(threadId);
        }
      } else void stopCall(call);
      rejectError(client, message, error);
    }
  }

  async function handle(client, data, binary) {
    const message = parse(data);
    if (message?.id != null && !message.method) {
      const entry = [...serverRequests.values()].find((entry) => entry.client === client && entry.downstreamId === message.id);
      if (entry) {
        if (!entry.resolved && !entry.response) { entry.response = message; void flushServerResponse(entry); }
        return;
      }
    }
    if (closing) { if (message?.id != null) reject(client, message, "The realtime gateway is shutting down."); return; }
    const method = message?.method;
    if ((method?.startsWith("remodex/realtime/") || ["thread/realtime/start", "thread/realtime/stop",
      "thread/realtime/appendAudio", "thread/realtime/appendText", "thread/realtime/appendSpeech"].includes(method))
      && typeof message.id !== "string" && !Number.isSafeInteger(message.id)) {
      reject(client, { id: null }, "Realtime control requires a JSON-RPC request id.", -32600, "invalid_params");
      return;
    }
    if (method === "remodex/realtime/status") {
      const call = message.params?.threadId ? calls.get(message.params.threadId)
        : [...calls.values()].find((call) => call.phone) || calls.values().next().value;
      reply(client, message, callState(call));
      return;
    }
    if (method === "remodex/realtime/heartbeat" || method === "remodex/realtime/stop") {
      const call = calls.get(message.params?.threadId);
      if (!ownsPhone(call, message.params)) {
        reject(client, message, "The Voice lease does not match the current session.", -32004, "lease_mismatch"); return;
      }
      if (!client.initialized || !client.experimental) {
        reject(client, message, "Initialize the runtime before renewing Voice.", -32600, "not_initialized"); return;
      }
      call.client = client;
      taskOwners.set(call.threadId, client);
      if (method.endsWith("heartbeat")) {
        if (call.phase === "closing") { reject(client, message, "Voice is being cleaned up.", -32004, "closing", recoveryParams(call)); return; }
        call.expiresAt = now() + leaseMs;
        reply(client, message, callState(call));
      } else { call.controlRecovery = false; void stopCall(call); reply(client, message); }
      return;
    }
    if (method === "thread/realtime/start" || method === "remodex/realtime/start") {
      await startCall(client, message, method.startsWith("remodex/")); return;
    }
    if (method === "thread/realtime/stop") {
      const call = calls.get(message.params?.threadId);
      if (!call || call.phone || call.client !== client) {
        reject(client, message, "Only the current realtime owner can stop this session.", -32004, "owner_mismatch"); return;
      }
      void stopCall(call); reply(client, message); return;
    }
    if (["thread/realtime/appendAudio", "thread/realtime/appendText", "thread/realtime/appendSpeech"].includes(method)) {
      const call = calls.get(message.params?.threadId);
      if (!call || call.client !== client || call.phase === "closing") {
        reject(client, message, "Only the current realtime owner can append to this session.", -32004, "owner_mismatch"); return;
      }
      try { reply(client, message, await nativeRequest(method, message.params)); }
      catch (error) { rejectError(client, message, error); }
      return;
    }
    if (method?.startsWith("remodex/realtime/")) {
      reject(client, message, "Unknown realtime gateway method.", -32601, "unknown_method"); return;
    }
    if (method === "initialize" && message.id != null) {
      if (!client.initialized) { client.name = message.params?.clientInfo?.name; client.phone = client.name === "codexmobile_ios"; }
      client.initializes.set(idKey(message.id), message.params?.capabilities?.experimentalApi === true);
    }
    if (["thread/resume", "thread/start", "thread/fork"].includes(method) && message.id != null)
      client.threadRequests.set(idKey(message.id), { threadId: message.params?.threadId,
        creates: method === "thread/start" || method === "thread/fork" });
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
    const client = { socket, upstream: new WebSocketImpl(upstreamUrl, upstreamOptions),
      queue: [], queuedBytes: 0, initialized: false, experimental: false, closed: false,
      initializes: new Map(), threadRequests: new Map(), threads: new Set(), phone: false };
    clients.add(client);
    socket.on("error", () => {});
    // Do not serialize a long start with its heartbeat/stop: the owner is reserved synchronously.
    socket.on("message", (data, binary) => void handle(client, data, binary).catch(() => socket.close(1011, "Gateway request failed.")));
    socket.on("close", () => {
      client.closed = true;
      clients.delete(client);
      client.upstream.terminate();
      for (const call of calls.values()) if (call.client === client && !call.phone) void stopCall(call);
      for (const entry of serverRequests.values()) if (entry.client === client && !entry.resolved && !entry.response) {
        if (!phoneSupports(entry.message.method) && entry.dispatched) {
          entry.response = { error: { code: -32004, message: "The Desktop disconnected before returning its result." } };
          void flushServerResponse(entry);
        } else { entry.client = null; deliverServerRequest(entry); }
      }
    });
    client.upstream.on("open", () => {
      for (const [data, binary] of client.queue) client.upstream.send(data, { binary });
      client.queue = []; client.queuedBytes = 0;
    });
    client.upstream.on("message", (data, binary) => {
      const message = parse(data);
      if (message?.method?.startsWith("thread/realtime/")) return;
      if (message?.method === "serverRequest/resolved") {
        const resolved = resolveServerRequest(message);
        if (resolved?.client === client) return;
      }
      if (message?.method && message.id != null && !deviceVerification(message)
        && (!phoneSupports(message.method) || taskOwners.has(threadIdOf(message)))) {
        receiveServerRequest(message, client.upstream);
        if (!phoneSupports(message.method) || taskOwner(threadIdOf(message)) === client) return;
      }
      if (message?.method && message.id == null && taskOwner(threadIdOf(message)) === client) return;
      if (message?.id != null && !message.method) {
        const key = idKey(message.id);
        if (client.initializes.has(key)) {
          if (!message.error) { client.initialized = true; client.experimental = client.initializes.get(key); }
          client.initializes.delete(key);
        }
        if (client.threadRequests.has(key)) {
          const request = client.threadRequests.get(key);
          const threadId = message.result?.thread?.id || request.threadId;
          if (!message.error && typeof threadId === "string") {
            client.threads.add(threadId);
            if (request.creates) taskCreators.set(threadId, client);
          }
          client.threadRequests.delete(key);
        }
        for (const entry of serverRequests.values()) if (!entry.client && !entry.resolved && !entry.response) deliverServerRequest(entry);
      }
      if (open(socket)) {
        if (message?.id != null && message.method && client.phone) send(socket, decorateRequest(client, message));
        else socket.send(data, { binary });
      }
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
          verifyClient: ({ req }) => !req.headers.origin && authenticatedPath(req.url)
            && loopback(req.socket.remoteAddress?.replace(/^::ffff:/, "")) });
        server.on("connection", accept);
        await new Promise((resolve, rejectStart) => { server.once("listening", resolve); server.once("error", rejectStart); });
      } catch (error) {
        await this.close();
        throw error;
      }
      leaseTimer = setInterval(() => {
        for (const call of calls.values()) {
          if (call.phone && now() >= call.expiresAt) { call.controlRecovery = false; void stopCall(call); }
          else if (call.phase === "closing" && !call.stopSent) void stopCall(call);
        }
      }, Math.min(1_000, Math.max(10, leaseMs / 3)));
      leaseTimer.unref();
      return { host: listenHost, port: server.address().port, url: `ws://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${server.address().port}/voice/${gatewayToken}` };
    },
    async close() {
      closing = true;
      for (const restoration of taskRestorations.values()) restoration.abort();
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
