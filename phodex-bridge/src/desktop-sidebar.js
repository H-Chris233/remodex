// Reads Desktop's local project organization without changing its persisted state.
const fs = require("fs");
const path = require("path");
const { createHash, randomBytes } = require("crypto");
const { resolveCodexHome } = require("./codex-home");
const { buildThreadReadStateContext } = require("./desktop-ipc-shared");
const { createWorktreeOriginEnricher } = require("./worktree-origin");
const { registeredWorktrees, resolveLocalCheckoutRoot } = require("./git-handler");

const PAGE_SIZE = 50;
const CURSOR_TTL_MS = 10 * 60 * 1000;

function sidebarError(code, message) {
  return Object.assign(new Error(message), { errorCode: code });
}

function normalizedPath(value, platform = process.platform) {
  let result = typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
  if (result.startsWith("//?/UNC/")) result = `//${result.slice(8)}`;
  else if (result.startsWith("//?/")) result = result.slice(4);
  result = result.replace(/\/+$/, "");
  if (!result && typeof value === "string" && value.trim().startsWith("/")) result = "/";
  return platform === "win32" ? result.toLowerCase() : result;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function projectSnapshot(state, nativeProjects, accountId, scopeKey, codexHome, platform) {
  const atoms = state["electron-persisted-atom-state"];
  const savedProjects = state["local-projects"];
  if (!object(atoms) || !object(savedProjects)) {
    throw sidebarError("sidebar_format_unsupported", "Desktop project storage is not supported by this bridge.");
  }
  const accounts = atoms["sidebar-custom-sections-v3"];
  if (accounts !== undefined && !object(accounts)) {
    throw sidebarError("sidebar_format_unsupported", "Desktop section storage has an unsupported format.");
  }
  const sectionState = accounts?.[accountId];
  if (sectionState !== undefined && (!object(sectionState) || !Array.isArray(sectionState.sections)
    || !Array.isArray(sectionState.sectionOrder))) {
    throw sidebarError("sidebar_format_unsupported", "Desktop section storage has an unsupported format.");
  }
  const homeKey = `local:${normalizedPath(codexHome, platform)}`;
  const mapping = Object.entries(state["app-server-project-id-by-legacy-project-id-by-host"] || {})
    .find(([key]) => key.startsWith("local:") && `local:${normalizedPath(key.slice(6), platform)}` === homeKey)?.[1] || {};
  const nativeById = new Map(nativeProjects.map((project) => [project.id, project]));
  const projects = [];
  const aliases = new Map();
  const usedNativeIds = new Set();
  function add(id, name, roots, nativeId = null) {
    const hostPath = platform === "win32" ? path.win32 : path.posix;
    if (!id || typeof name !== "string" || !name.trim() || roots.length === 0
      || roots.some((root) => typeof root !== "string" || !hostPath.isAbsolute(root))) return;
    projects.push({ id, name, rootPaths: roots, projectId: nativeId });
    aliases.set(id, id);
    if (nativeId) { aliases.set(nativeId, id); usedNativeIds.add(nativeId); }
  }
  for (const [id, saved] of Object.entries(savedProjects)) {
    if (!object(saved) || (saved.hostId != null && saved.hostId !== "local")) continue;
    const nativeId = typeof mapping[id] === "string" ? mapping[id] : (nativeById.has(id) ? id : null);
    const native = nativeById.get(nativeId);
    // A migrated project deleted from the native catalog must not be resurrected.
    if (nativeId && !native) continue;
    add(id, native?.name ?? saved.name, native ? native.roots.map((root) => root.path) : strings(saved.rootPaths), nativeId);
  }
  for (const native of nativeProjects) {
    if (!usedNativeIds.has(native.id)) add(native.id, native.name, native.roots.map((root) => root.path), native.id);
  }
  const assignedProjects = new Set();
  const sectionsById = new Map();
  for (const section of sectionState?.sections || []) {
    if (!object(section) || typeof section.id !== "string" || typeof section.name !== "string"
      || !Array.isArray(section.itemKeys)) {
      throw sidebarError("sidebar_format_unsupported", "Desktop section storage has an unsupported format.");
    }
    sectionsById.set(section.id, section);
  }
  const sectionOrder = [...new Set([
    ...strings(sectionState?.sectionOrder).map((id) => id.replace(/^custom:/, "")),
    ...sectionsById.keys(),
  ])];
  const sections = sectionOrder.flatMap((id) => {
    const section = sectionsById.get(id);
    if (!section) return [];
    const projectIds = strings(section.itemKeys).flatMap((key) => {
      if (!key.startsWith("codex:project:")) return [];
      const projectId = aliases.get(key.slice("codex:project:".length));
      if (!projectId || assignedProjects.has(projectId)) return [];
      assignedProjects.add(projectId);
      return [projectId];
    });
    return projectIds.length ? [{ id, name: section.name, projectIds }] : [];
  });
  const threadProjectIds = Object.create(null);
  const excludedThreadIds = new Set(strings(state["projectless-thread-ids"]));
  for (const [threadId, assignment] of Object.entries(state["thread-project-assignments"] || {})) {
    const hostId = state["thread-project-membership-host-ids"]?.[threadId];
    const projectId = assignment?.projectKind === "local" ? aliases.get(assignment.projectId) : null;
    if (projectId && (hostId == null || hostId === "local")) threadProjectIds[threadId] = projectId;
    else excludedThreadIds.add(threadId);
  }
  const snapshot = { schemaVersion: 1, scopeKey, projects, sections, threadProjectIds, excludedThreadIds: [...excludedThreadIds] };
  return { ...snapshot, revision: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

function projectForThread(thread, snapshot, platform = process.platform) {
  if (thread.projectId) return snapshot.projects.find((project) => project.projectId === thread.projectId || project.id === thread.projectId)?.id ?? null;
  if (snapshot.excludedThreadIds.includes(thread.id)) return null;
  if (Object.hasOwn(snapshot.threadProjectIds, thread.id)) return snapshot.threadProjectIds[thread.id];
  const parentId = thread.parentThreadId || thread.parent_thread_id;
  if (parentId && Object.hasOwn(snapshot.threadProjectIds, parentId)) return snapshot.threadProjectIds[parentId];
  const cwd = normalizedPath(thread.worktreeOriginPath || thread.cwd, platform);
  if (!cwd) return null;
  // Match thread/list's exact cwd filter; an inferred descendant would not be pageable.
  const matches = snapshot.projects.filter((project) => project.rootPaths.some((root) => normalizedPath(root, platform) === cwd));
  return matches.length === 1 ? matches[0].id : null;
}

async function projectWorktreePaths(roots) {
  const paths = [];
  for (const root of roots) {
    // Non-Git projects have no registered worktrees.
    const checkout = await resolveLocalCheckoutRoot(root).catch(() => null);
    if (!checkout) continue;
    const relative = path.relative(checkout, root);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const entries = await registeredWorktrees(checkout);
    paths.push(...entries.map((entry) => path.join(entry.path, relative)));
  }
  return paths;
}

function createDesktopSidebarService({
  sendCodexRequest, codexHome = resolveCodexHome(), fsModule = fs, platform = process.platform,
  enabled = true, deviceId = "", listWorktreePaths = projectWorktreePaths, enrichThread = null,
  listSupplementalThreads = async () => [], now = Date.now,
} = {}) {
  const enrichSummary = enrichThread || createWorktreeOriginEnricher({ fsModule, codexHome }).attachToThread;
  const pages = new Map();
  let readInFlight = null;
  let currentScope = null;

  async function identity() {
    if (!enabled) throw sidebarError("sidebar_unsupported", "Desktop sidebar is unavailable for an external Codex endpoint.");
    const auth = await sendCodexRequest("getAuthStatus", { includeToken: true, refreshToken: false });
    const context = buildThreadReadStateContext(auth);
    if (context?.identity.kind !== "chatgpt") {
      throw sidebarError("sidebar_identity_unavailable", "The desktop account could not be identified.");
    }
    const scopeKey = createHash("sha256").update(JSON.stringify([deviceId, normalizedPath(codexHome, platform), context.identity])).digest("hex");
    if (currentScope !== scopeKey) { pages.clear(); currentScope = scopeKey; }
    return { accountId: context.identity.accountId, scopeKey };
  }

  async function assertIdentity(scopeKey) {
    if ((await identity()).scopeKey !== scopeKey) throw sidebarError("sidebar_scope_changed", "The desktop account changed. Refresh projects.");
  }

  async function readSnapshot() {
    const { accountId, scopeKey } = await identity();
    let state;
    try { state = JSON.parse(await fsModule.promises.readFile(path.join(codexHome, ".codex-global-state.json"), "utf8")); }
    catch { throw sidebarError("sidebar_storage_unavailable", "Desktop project organization could not be read."); }
    const nativeProjects = [];
    const cursors = new Set();
    let cursor = null;
    do {
      let result;
      try { result = await sendCodexRequest("project/list", { cursor, limit: 100 }); }
      catch (error) {
        if (error.code === -32601 || /unknown variant|unknown method|method not found/i.test(error.message)) {
          throw sidebarError("sidebar_unsupported", "This Codex version does not support the desktop project catalog.");
        }
        throw error;
      }
      if (!Array.isArray(result?.data) || result.data.some((project) => !project?.id || !Array.isArray(project.roots)
        || project.roots.some((root) => typeof root?.path !== "string"))) {
        throw sidebarError("sidebar_format_unsupported", "Codex returned an unsupported project catalog.");
      }
      nativeProjects.push(...result.data);
      cursor = result.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw sidebarError("sidebar_invalid_cursor", "Codex repeated a project cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    await assertIdentity(scopeKey);
    return projectSnapshot(state, nativeProjects, accountId, scopeKey, codexHome, platform);
  }

  function read() {
    if (!readInFlight) readInFlight = readSnapshot().finally(() => { readInFlight = null; });
    return readInFlight;
  }

  function prunePages() {
    for (const [key, page] of pages) if (page.expiresAt <= now()) pages.delete(key);
    while (pages.size >= 100) pages.delete(pages.keys().next().value);
  }

  async function fill(source, state) {
    while (!source.buffer.length && !source.done) {
      let rows;
      if (source.ids) {
        rows = [];
        for (let index = 0; index < source.ids.length; index += 4) {
          rows.push(...await Promise.all(source.ids.slice(index, index + 4).map(async (threadId) => {
            try { return (await sendCodexRequest("thread/read", { threadId, includeTurns: false }))?.thread; }
            catch (error) {
              if (/thread.*not found|thread.*archived|no rollout found/i.test(error.message)) return null;
              throw error;
            }
          })));
        }
        source.done = true;
      } else {
        const result = await sendCodexRequest("thread/list", {
          ...source.params, cursor: source.cursor, limit: PAGE_SIZE, archived: false,
          sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
          modelProviders: [], useStateDbOnly: true, sortKey: "updated_at",
        });
        if (!Array.isArray(result?.data)) throw sidebarError("sidebar_invalid_page", "Codex returned an invalid thread page.");
        rows = result.data;
        const next = result.nextCursor || null;
        if (next && source.cursors.includes(next)) throw sidebarError("sidebar_invalid_cursor", "Codex repeated a thread cursor.");
        if (next) source.cursors.push(next);
        source.cursor = next;
        source.done = !next;
      }
      source.buffer = rows.filter((thread) => thread?.id && !thread.archived
        && !String(thread.path || "").replace(/\\/g, "/").includes("/archived_sessions/")).map((thread) => {
        const { turns, ...summary } = thread;
        return enrichSummary(summary);
      }).filter((thread) => projectForThread(thread, state.snapshot, platform) === state.projectId).sort(compareThreads);
    }
  }

  async function buildPage(original) {
    // Commit pagination only after success so a failed read can retry the same cursor.
    const state = { ...original, sources: structuredClone(original.sources), seen: new Set(original.seen) };
    const data = [];
    while (data.length < PAGE_SIZE) {
      await Promise.all(state.sources.map((source) => fill(source, state)));
      const available = state.sources.filter((source) => source.buffer.length);
      if (!available.length) break;
      available.sort((a, b) => compareThreads(a.buffer[0], b.buffer[0]));
      const thread = available[0].buffer.shift();
      if (!state.seen.has(thread.id)) { state.seen.add(thread.id); data.push(thread); }
    }
    const latest = await read();
    if (latest.scopeKey !== state.snapshot.scopeKey) throw sidebarError("sidebar_scope_changed", "The desktop account changed. Refresh projects.");
    if (latest.revision !== state.snapshot.revision) throw sidebarError("sidebar_cursor_expired", "The project organization changed. Refresh this project.");
    let nextCursor = null;
    if (state.sources.some((source) => source.buffer.length || !source.done)) {
      nextCursor = randomBytes(24).toString("hex");
      prunePages();
      pages.set(nextCursor, { state, expiresAt: now() + CURSOR_TTL_MS });
    }
    return { scopeKey: state.snapshot.scopeKey, data, nextCursor };
  }

  async function listProjectThreads(params = {}) {
    const { scopeKey } = await identity();
    if (params.scopeKey !== scopeKey) throw sidebarError("sidebar_scope_changed", "The desktop account changed. Refresh projects.");
    prunePages();
    if (params.cursor != null) {
      const page = pages.get(params.cursor);
      if (!page || page.state.projectId !== params.projectId || page.state.snapshot.scopeKey !== scopeKey) {
        throw sidebarError("sidebar_cursor_expired", "The project page expired. Refresh this project.");
      }
      if (!page.promise) page.promise = buildPage(page.state).catch((error) => { page.promise = null; throw error; });
      const result = await page.promise;
      await assertIdentity(scopeKey);
      return result;
    }
    const snapshot = await read();
    if (snapshot.scopeKey !== scopeKey) throw sidebarError("sidebar_scope_changed", "The desktop account changed. Refresh projects.");
    const project = snapshot.projects.find((item) => item.id === params.projectId);
    if (!project) throw sidebarError("sidebar_project_not_found", "The desktop project is no longer available.");
    const roots = [...new Set([...project.rootPaths, ...await listWorktreePaths(project.rootPaths)])];
    const sources = [];
    if (project.projectId) sources.push({ params: { projectId: project.projectId }, cursor: null, cursors: [], buffer: [], done: false });
    sources.push({ params: { cwd: roots }, cursor: null, cursors: [], buffer: [], done: false });
    const ids = Object.entries(snapshot.threadProjectIds).filter(([, id]) => id === project.id).map(([id]) => id);
    if (ids.length) sources.push({ ids, buffer: [], done: false });
    const supplemental = (await listSupplementalThreads())
      .filter((thread) => projectForThread(thread, snapshot, platform) === project.id)
      .map(({ turns, ...summary }) => summary);
    if (supplemental.length) sources.push({ buffer: supplemental.sort(compareThreads), done: true });
    return buildPage({ snapshot, projectId: project.id, sources, seen: new Set() });
  }

  function invalidate() { currentScope = null; pages.clear(); }
  return { read, listProjectThreads, invalidate };
}

function compareThreads(a, b) {
  return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) || a.id.localeCompare(b.id);
}

module.exports = { createDesktopSidebarService, projectSnapshot, projectForThread, normalizedPath };
