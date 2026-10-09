// FILE: workspace-file-download.js
// Purpose: Streams explicitly requested local files through the existing encrypted workspace RPC.
// Layer: Bridge service

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { fileURLToPath } = require("url");
const { resolveWorkspaceFileTarget, isPathInside } = require("./workspace-handler");
const { buildCompleteThreadReadParams, responseItemMessageText } = require("./desktop-ipc-shared");

const CHUNK_SIZE = 256 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 120_000;
const DOWNLOAD_METHODS = new Set([
  "workspace/startFileDownload", "workspace/readFileChunk", "workspace/closeFileDownload",
]);

function downloadError(errorCode, message) {
  return Object.assign(new Error(message), { errorCode, userMessage: message });
}

// Only this bridge-side reader can supply cwd or assistant text; phone-provided context is ignored.
function createFileDownloadThreadReader({ sendCodexRequest, openCodeRuntime, readRollout }) {
  return async (threadId) => {
    const isOpenCode = openCodeRuntime?.handlesThreadId(threadId) === true;
    let thread;
    let readError;
    try {
      const params = buildCompleteThreadReadParams(threadId);
      const result = isOpenCode
        ? await openCodeRuntime.handleRequest({ method: "thread/read", params })
        : await sendCodexRequest("thread/read", params);
      if (!result?.thread || result.thread.id !== threadId) {
        throw downloadError("thread_not_found", "This chat could not be read on the computer.");
      }
      thread = result.thread;
    } catch (error) {
      readError = error;
    }
    let fallback;
    try {
      fallback = !isOpenCode && readRollout ? readRollout(threadId) : null;
    } catch (error) {
      readError ||= error;
    }
    const cwd = thread?.cwd || thread?.current_working_directory || fallback?.cwd;
    if (!cwd) {
      throw readError || downloadError("missing_working_directory", "This chat has no local working directory.");
    }
    return {
      cwd,
      turns: [...(thread?.turns || []), ...(fallback?.turns || [])],
    };
  };
}

function normalizeDownloadPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw downloadError("missing_file_path", "The request must include a local file path.");
  }
  let candidate = value.trim().replace(/^<([\s\S]*)>$/, "$1");
  candidate = candidate.replace(/^sandbox:/i, "");
  if (/^file:/i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.host && url.host !== "localhost") throw new Error("Network file URL");
      candidate = fileURLToPath(url);
    } catch {
      throw downloadError("file_path_not_allowed", "Only local files on this computer can be downloaded.");
    }
  }
  candidate = candidate.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
  if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2));
  if (candidate.includes("\0") || /^[/\\]{2}/.test(candidate)
    || (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-z]:[/\\]/i.test(candidate))
    || /^[a-z]:[^/\\]/i.test(candidate)
    || (process.platform === "win32" && /^[a-z]:.*:/i.test(candidate))) {
    throw downloadError("file_path_not_allowed", "Only local files on this computer can be downloaded.");
  }
  return candidate;
}

// Keep the raw destination exactly as the phone does; backslashes and percent signs can be filename bytes.
function markdownLinkTargets(text) {
  text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`/g, "");
  const targets = [];
  const start = /\[[^\]\r\n]*\]\(\s*/g;
  let match;
  while ((match = start.exec(text))) {
    let index = start.lastIndex;
    const angle = text[index] === "<";
    if (angle) index += 1;
    const isWindowsPath = /^[a-z]:[/\\]/i.test(text.slice(index));
    let depth = 0;
    let target = "";
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\n" || char === "\r") break;
      if (char === "\\" && !isWindowsPath && /[()<>\\ ]/.test(text[index + 1] || "")) {
        target += char + text[++index];
      } else if ((angle && char === ">") || (!angle && depth === 0 && char === ")")) {
        const tail = text.slice(index + 1);
        if (!angle || /^\s*(?:["'][^\r\n]*?["']\s*)?\)/.test(tail)) {
          targets.push((angle ? target : target.replace(/\s+["'][^"']*["']\s*$/, "")).trim());
        }
        break;
      } else {
        if (!angle && char === "(") depth += 1;
        if (!angle && char === ")") depth -= 1;
        target += char;
      }
    }
  }
  return targets;
}

async function isReferencedExternalFile(context, turnId, requestedPath, realFilePath) {
  const requestedAbsolute = path.resolve(context.cwd, requestedPath);
  for (const turn of context.turns || []) {
    if (turnId && turn.id !== turnId) continue;
    for (const item of turn.items || []) {
      const type = String(item.type || "").replace(/[_-]/g, "").toLowerCase();
      if (type !== "agentmessage" && !(type === "message" && item.role === "assistant")) continue;
      for (const target of markdownLinkTargets(responseItemMessageText(item))) {
        try {
          const candidate = normalizeDownloadPath(target);
          // External links must name their exact path, never trigger the basename fallback.
          if (candidate === path.basename(candidate)) continue;
          const citedAbsolute = path.resolve(context.cwd, candidate);
          if (path.relative(requestedAbsolute, citedAbsolute) !== "") continue;
          const realTarget = await fs.promises.realpath(citedAbsolute);
          if (path.relative(realFilePath, realTarget) === "") return true;
        } catch { /* An unavailable or non-local citation never authorizes another file. */ }
      }
    }
  }
  return false;
}

function sameFileVersion(first, second) {
  return first.isFile() && second.isFile()
    && ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"].every((key) => first[key] === second[key]);
}

function createWorkspaceFileDownloadService({ readThreadContext, now = Date.now } = {}) {
  const downloads = new Map();
  let pendingStarts = 0;
  let disposed = false;

  async function closeEntry(entry) {
    downloads.delete(entry.id);
    entry.closed = true;
    clearTimeout(entry.expiryTimer);
    entry.closePromise ||= entry.handle.close();
    await entry.closePromise;
  }

  function touch(entry) {
    entry.lastUsed = now();
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = setTimeout(() => { closeEntry(entry).catch(() => {}); }, DOWNLOAD_IDLE_MS);
    entry.expiryTimer.unref?.();
  }

  async function expireIdle() {
    await Promise.all([...downloads.values()]
      .filter((entry) => !entry.busy && now() - entry.lastUsed >= DOWNLOAD_IDLE_MS)
      .map(closeEntry));
  }

  async function start(params) {
    await expireIdle();
    if (disposed) throw downloadError("download_unavailable", "The computer bridge is shutting down.");
    if (downloads.size + pendingStarts >= 2) {
      throw downloadError("too_many_downloads", "Two files are already being downloaded. Finish or cancel one first.");
    }
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId) throw downloadError("missing_thread_id", "File downloads require a chat thread.");
    const requestedPath = normalizeDownloadPath(params.path);
    pendingStarts += 1;
    let handle;
    try {
      const context = await readThreadContext(threadId);
      const { realWorkspaceRoot, realFilePath } = await resolveWorkspaceFileTarget(context.cwd, requestedPath);
      if (!realFilePath) throw downloadError("file_not_found", "The file no longer exists on this computer.");
      const inside = realWorkspaceRoot && isPathInside(realFilePath, realWorkspaceRoot);
      if (!inside && !await isReferencedExternalFile(context, params.turnId, requestedPath, realFilePath)) {
        throw downloadError("file_path_not_allowed", "This external file is not linked by the assistant in this chat.");
      }
      const expected = await fs.promises.stat(realFilePath);
      if (!expected.isFile()) throw downloadError("file_not_found", "The path is not a regular file.");
      if (expected.size > MAX_FILE_BYTES) throw downloadError("file_too_large", "File downloads are limited to 100 MiB.");
      handle = await fs.promises.open(realFilePath,
        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!sameFileVersion(expected, stat)) throw downloadError("file_changed", "The file changed. Download it again.");
      if (disposed) throw downloadError("download_unavailable", "The computer bridge is shutting down.");
      const id = randomUUID();
      const entry = { id, handle, stat, path: realFilePath, closed: false, busy: false };
      downloads.set(id, entry);
      touch(entry);
      handle = null;
      return { downloadId: id, path: realFilePath, fileName: path.basename(realFilePath),
        byteLength: stat.size, mtimeMs: stat.mtimeMs, chunkSize: CHUNK_SIZE };
    } finally {
      pendingStarts -= 1;
      if (handle) await handle.close();
    }
  }

  async function read(params) {
    await expireIdle();
    const entry = downloads.get(params.downloadId);
    if (!entry) throw downloadError("download_expired", "This download expired or was closed. Download the file again.");
    const offset = params.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.stat.size) {
      throw downloadError("invalid_offset", "The file chunk offset is invalid.");
    }
    if (entry.busy) throw downloadError("download_busy", "A file chunk is already being read.");
    entry.busy = true;
    touch(entry);
    try {
      if (!sameFileVersion(entry.stat, await entry.handle.stat())) {
        throw downloadError("file_changed", "The file changed. Download it again.");
      }
      const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, entry.stat.size - offset));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await entry.handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
        if (!chunk.bytesRead) throw downloadError("file_changed", "The file changed. Download it again.");
        bytesRead += chunk.bytesRead;
      }
      const [current, pathStat] = await Promise.all([entry.handle.stat(), fs.promises.stat(entry.path)]);
      if (entry.closed) throw downloadError("download_expired", "This download was cancelled.");
      if (!sameFileVersion(entry.stat, current) || !sameFileVersion(entry.stat, pathStat)) {
        throw downloadError("file_changed", "The file changed. Download it again.");
      }
      const eof = offset + bytesRead === entry.stat.size;
      if (eof) await closeEntry(entry);
      else touch(entry);
      return { offset, bytesRead, dataBase64: buffer.toString("base64"), eof };
    } catch (error) {
      await closeEntry(entry).catch(() => {});
      if (error.errorCode) throw error;
      throw downloadError("file_changed", "The file is unavailable or changed. Download it again.");
    } finally {
      entry.busy = false;
    }
  }

  async function handleMethod(method, params = {}) {
    if (method === "workspace/startFileDownload") return start(params);
    if (method === "workspace/readFileChunk") return read(params);
    if (method === "workspace/closeFileDownload") {
      const entry = downloads.get(params.downloadId);
      if (entry) await closeEntry(entry);
      return { closed: true };
    }
    throw downloadError("unknown_method", `Unknown file download method: ${method}`);
  }

  function handleRequest(rawMessage, sendResponse, parsedMessage) {
    let request = parsedMessage;
    try { request ||= JSON.parse(rawMessage); } catch { return false; }
    if (!DOWNLOAD_METHODS.has(request?.method)) return false;
    handleMethod(request.method, request.params || {}).then((result) => {
      sendResponse(JSON.stringify({ id: request.id, result }));
    }).catch((error) => {
      sendResponse(JSON.stringify({ id: request.id, error: {
        code: -32000, message: error.userMessage || error.message,
        data: { errorCode: error.errorCode || "file_download_error" },
      } }));
    });
    return true;
  }

  async function dispose() {
    disposed = true;
    await Promise.all([...downloads.values()].map(closeEntry));
  }

  return { handleRequest, handleMethod, dispose };
}

module.exports = { createWorkspaceFileDownloadService, createFileDownloadThreadReader, DOWNLOAD_METHODS,
  normalizeDownloadPath, markdownLinkTargets };
