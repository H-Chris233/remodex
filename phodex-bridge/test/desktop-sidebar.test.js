const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDesktopSidebarService, projectSnapshot, projectForThread } = require("../src/desktop-sidebar");
const { handleDesktopRequest } = require("../src/desktop-handler");

function savedState(home) {
  return {
    "electron-persisted-atom-state": { "sidebar-custom-sections-v3": {
      account: { sections: [
        { id: "a", name: "Work", itemKeys: ["codex:project:old", "chatgpt:project:cloud"] },
        { id: "b", name: "Personal", itemKeys: ["codex:project:second", "codex:thread:local:standalone"] },
      ], sectionOrder: ["custom:b", "custom:a"] },
      other: { sections: [{ id: "secret", name: "Other account", itemKeys: ["codex:project:old"] }], sectionOrder: [] },
    } },
    "local-projects": {
      old: { name: "Old name", rootPaths: ["/work/repo"] },
      second: { name: "Personal", rootPaths: ["/work/second"] },
    },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { old: "native", second: "native2" } },
    "thread-project-assignments": { moved: { projectKind: "local", projectId: "second" }, external: { projectKind: "local", projectId: "old" } },
    "projectless-thread-ids": ["rootless"],
  };
}
const nativeProjects = [
  { id: "native", name: "Repo", roots: [{ path: "/work/repo" }, { path: "/work/docs" }] },
  { id: "native2", name: "Personal", roots: [{ path: "/work/second" }] },
];
function fakeAuth(accountId = "account") {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: "user" } };
  return { authMethod: "chatgpt", authToken: `test.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature` };
}
function fixture(t, { accountId = "account", list, readThread, worktrees = [], projects = nativeProjects, supplemental = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-sidebar-"));
  const statePath = path.join(home, ".codex-global-state.json");
  fs.writeFileSync(statePath, JSON.stringify(savedState(home)));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const identity = { accountId };
  const service = createDesktopSidebarService({
    codexHome: home, platform: "darwin", listWorktreePaths: async () => worktrees,
    listSupplementalThreads: async () => supplemental,
    sendCodexRequest: async (method, params) => {
      calls.push({ method, params });
      if (method === "getAuthStatus") return fakeAuth(identity.accountId);
      if (method === "project/list") return { data: projects, nextCursor: null };
      if (method === "thread/list") return list ? list(params) : { data: [], nextCursor: null };
      if (method === "thread/read") return { thread: readThread ? await readThread(params) : null };
      throw new Error(`Unexpected RPC ${method}`);
    },
  });
  return { service, home, statePath, calls, identity };
}

test("projects merge native identities with current-account sections and preserve desktop order", () => {
  const snapshot = projectSnapshot(savedState("/home"), nativeProjects, "account", "scope", "/home", "darwin");
  assert.deepEqual(snapshot.sections.map((section) => section.name), ["Personal", "Work"]);
  assert.equal(snapshot.projects.length, 2);
  assert.deepEqual(snapshot.projects[0], { id: "old", name: "Repo", rootPaths: ["/work/repo", "/work/docs"], projectId: "native" });
  assert.equal(JSON.stringify(snapshot).includes("Other account"), false);
  assert.equal(JSON.stringify(snapshot).includes("standalone"), false);
  assert.deepEqual(projectSnapshot(savedState("/home"), nativeProjects, "missing", "s", "/home", "darwin").sections, []);
});

test("project resolution prefers explicit membership and keeps rootless threads outside projects", () => {
  const snapshot = projectSnapshot(savedState("/home"), nativeProjects, "account", "scope", "/home", "darwin");
  assert.equal(projectForThread({ id: "moved", cwd: "/work/repo" }, snapshot, "darwin"), "second");
  assert.equal(projectForThread({ id: "child", parentThreadId: "moved", cwd: "/work/repo" }, snapshot, "darwin"), "second");
  assert.equal(projectForThread({ id: "moved", projectId: "native", cwd: "/work/second" }, snapshot), "old");
  assert.equal(projectForThread({ id: "rootless", cwd: "/work/repo" }, snapshot), null);
  assert.equal(projectForThread({ id: "x", projectId: "unknown", cwd: "/work/repo" }, snapshot), null);
  assert.equal(projectForThread({ id: "x", cwd: "/work/docs" }, snapshot), "old");
  assert.equal(projectForThread({ id: "x", cwd: "/work/docs/chapter" }, snapshot), null);
  assert.equal(projectForThread({ id: "x", cwd: "/work/repository" }, snapshot), null);
});

test("Windows extended paths and worktree origin match without rewriting cwd", () => {
  const snapshot = { projects: [{ id: "p", rootPaths: ["E:\\Work\\Repo"] }], threadProjectIds: {}, excludedThreadIds: [] };
  const thread = { id: "x", cwd: "C:\\worktree", worktreeOriginPath: "\\\\?\\e:\\work\\REPO\\" };
  assert.equal(projectForThread(thread, snapshot, "win32"), "p");
  assert.equal(thread.cwd, "C:\\worktree");
});

test("storage failure and unsupported shapes never become a successful empty catalog", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.statePath, "broken");
  await assert.rejects(f.service.read(), { errorCode: "sidebar_storage_unavailable" });
  fs.writeFileSync(f.statePath, "{}");
  await assert.rejects(f.service.read(), { errorCode: "sidebar_format_unsupported" });
  fs.unlinkSync(f.statePath);
  await assert.rejects(f.service.read(), { errorCode: "sidebar_storage_unavailable" });
});

test("external endpoints and unidentified accounts fail before exposing catalog data", async () => {
  const service = createDesktopSidebarService({ enabled: false, sendCodexRequest: () => assert.fail("must not request remote auth") });
  await assert.rejects(service.read(), { errorCode: "sidebar_unsupported" });
  const noIdentity = createDesktopSidebarService({ sendCodexRequest: async () => ({ authMethod: "apikey" }) });
  await assert.rejects(noIdentity.read(), { errorCode: "sidebar_identity_unavailable" });
});

test("legacy project API reports an explicit unsupported capability", async (t) => {
  const f = fixture(t);
  const service = createDesktopSidebarService({ codexHome: f.home, sendCodexRequest: async (method) => {
    if (method === "getAuthStatus") return fakeAuth();
    throw Object.assign(new Error("method not found"), { code: -32601 });
  } });
  await assert.rejects(service.read(), { errorCode: "sidebar_unsupported" });
});

test("directory fallback loads old chats, deduplicates sources and excludes moved/rootless chats", async (t) => {
  const row = { id: "old-chat", cwd: "/work/repo", updatedAt: 10 };
  const f = fixture(t, {
    list: (params) => ({ data: params.projectId ? [] : [row, { id: "moved", cwd: "/work/repo" }, { id: "rootless", cwd: "/work/repo" }], nextCursor: null }),
    readThread: ({ threadId }) => ({ id: threadId, cwd: "/elsewhere", updatedAt: 5, turns: [{ secret: true }] }),
  });
  const before = fs.readFileSync(f.statePath, "utf8");
  const snapshot = await f.service.read();
  const page = await f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey });
  assert.deepEqual(page.data.map((thread) => thread.id), ["old-chat", "external"]);
  assert.equal(page.nextCursor, null);
  assert.equal(JSON.stringify(page).includes("secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("authToken"), false);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
  assert.ok(f.calls.every(({ method }) => ["getAuthStatus", "project/list", "thread/list", "thread/read"].includes(method)));
  assert.ok(f.calls.filter(({ method }) => method === "thread/read").every(({ params }) => params.includeTurns === false));
});

test("multi-source pagination is bounded, deduplicated and retryable", async (t) => {
  const rows = Array.from({ length: 75 }, (_, index) => ({ id: `t-${index}`, projectId: "native", cwd: "/work/repo", updatedAt: 100 - index }));
  let failNext = false;
  const f = fixture(t, { list: (params) => {
    if (params.cursor && failNext) { failNext = false; throw new Error("temporary failure"); }
    const offset = params.cursor ? 50 : 0;
    return { data: rows.slice(offset, offset + 50), nextCursor: offset === 0 ? "next" : null };
  } });
  const snapshot = await f.service.read();
  const params = { projectId: "old", scopeKey: snapshot.scopeKey };
  const first = await f.service.listProjectThreads(params);
  assert.equal(first.data.length, 50);
  assert.ok(first.nextCursor);
  failNext = true;
  await assert.rejects(f.service.listProjectThreads({ ...params, cursor: first.nextCursor }), /temporary failure/);
  const second = await f.service.listProjectThreads({ ...params, cursor: first.nextCursor });
  assert.equal(second.data.length, 25);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.data, ...second.data].map((row) => row.id)).size, 75);
  assert.deepEqual(await f.service.listProjectThreads({ ...params, cursor: first.nextCursor }), second);
});

test("account change rejects in-flight rows and old cursors", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { list: async () => { await blocked; return { data: [], nextCursor: null }; } });
  const snapshot = await f.service.read();
  const pending = f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey });
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.identity.accountId = "other";
  release();
  await assert.rejects(pending, { errorCode: "sidebar_scope_changed" });
  await assert.rejects(f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey, cursor: "old" }), { errorCode: "sidebar_scope_changed" });
});

test("registered worktree paths participate in directory queries", async (t) => {
  const f = fixture(t, { worktrees: ["/work/tree"], list: (params) => {
    if (params.cwd) assert.deepEqual(params.cwd, ["/work/repo", "/work/docs", "/work/tree"]);
    return { data: [], nextCursor: null };
  } });
  const snapshot = await f.service.read();
  await f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey });
});

test("desktop handler forwards only the two read operations", async () => {
  const response = await new Promise((resolve) => {
    assert.equal(handleDesktopRequest(JSON.stringify({ id: 1, method: "desktop/sidebar/read" }), resolve, {
      desktopSidebar: { read: async () => ({ schemaVersion: 1 }) },
    }), true);
  });
  assert.deepEqual(JSON.parse(response), { id: 1, result: { schemaVersion: 1 } });
});

test("archived explicit assignments are not reintroduced by metadata reads", async (t) => {
  const f = fixture(t, { readThread: ({ threadId }) => ({ id: threadId, cwd: "/work/repo", path: "/home/.codex/archived_sessions/chat.jsonl" }) });
  const snapshot = await f.service.read();
  const result = await f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey });
  assert.deepEqual(result.data, []);
  assert.equal(result.nextCursor, null);
});

test("changed desktop membership invalidates pagination before a page can be applied", async (t) => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: `thread-${i}`, cwd: "/work/repo", updatedAt: 100 - i }));
  const f = fixture(t, { list: (params) => params.projectId
    ? { data: [], nextCursor: null }
    : { data: rows.slice(params.cursor ? 50 : 0, params.cursor ? 100 : 50), nextCursor: params.cursor ? null : "second" } });
  const snapshot = await f.service.read();
  const params = { projectId: "old", scopeKey: snapshot.scopeKey };
  const first = await f.service.listProjectThreads(params);
  const changed = savedState(f.home);
  changed["thread-project-assignments"]["thread-50"] = { projectKind: "local", projectId: "second" };
  fs.writeFileSync(f.statePath, JSON.stringify(changed));
  await assert.rejects(f.service.listProjectThreads({ ...params, cursor: first.nextCursor }), { errorCode: "sidebar_cursor_expired" });
});

test("failed project page can retry without dropping rows", async (t) => {
  let fail = true;
  const f = fixture(t, { list: (params) => {
    if (params.projectId) return { data: [], nextCursor: null };
    if (fail) { fail = false; throw new Error("offline"); }
    return { data: [{ id: "old", cwd: "/work/repo" }], nextCursor: null };
  } });
  const snapshot = await f.service.read();
  const params = { projectId: "old", scopeKey: snapshot.scopeKey };
  await assert.rejects(f.service.listProjectThreads(params), /offline/);
  assert.deepEqual((await f.service.listProjectThreads(params)).data.map((thread) => thread.id), ["old"]);
});

test("desktop scopes distinguish computers even with identical homes and accounts", async (t) => {
  const f = fixture(t);
  const options = { codexHome: f.home, platform: "darwin", sendCodexRequest: async (method) => method === "getAuthStatus"
    ? fakeAuth() : { data: nativeProjects, nextCursor: null } };
  const first = await createDesktopSidebarService({ ...options, deviceId: "computer-a" }).read();
  const second = await createDesktopSidebarService({ ...options, deviceId: "computer-b" }).read();
  assert.notEqual(first.scopeKey, second.scopeKey);
});

test("existing local provider chats remain in their project outside the recent window", async (t) => {
  const f = fixture(t, { supplemental: [
    { id: "opencode:old", cwd: "/work/repo", runtimeProvider: "opencode" },
    { id: "opencode:other", cwd: "/work/other", runtimeProvider: "opencode" },
  ] });
  const snapshot = await f.service.read();
  const result = await f.service.listProjectThreads({ projectId: "old", scopeKey: snapshot.scopeKey });
  assert.deepEqual(result.data.map((thread) => thread.id), ["opencode:old"]);
  assert.equal(result.nextCursor, null);
});
