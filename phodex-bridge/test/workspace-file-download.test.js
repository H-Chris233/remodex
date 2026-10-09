// FILE: workspace-file-download.test.js
// Purpose: Verifies exact binary downloads, trusted thread scoping, and bounded file handle lifecycle.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createWorkspaceFileDownloadService, createFileDownloadThreadReader,
  normalizeDownloadPath, markdownLinkTargets } = require("../src/workspace-file-download");
const { isOpenCodeRequest } = require("../src/bridge");

function fixture(t, { context, now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-download-"));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const service = createWorkspaceFileDownloadService({
    readThreadContext: async (threadId) => {
      assert.equal(threadId, "thread-1");
      return context || { cwd, turns: [] };
    }, now,
  });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function file(name, data = "hello", outside = false) {
    const filePath = path.join(outside ? root : cwd, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    return filePath;
  }
  async function start(filePath, extras = {}) {
    return service.handleMethod("workspace/startFileDownload", { threadId: "thread-1", path: filePath, ...extras });
  }
  async function read(downloadId, offset = 0) {
    return service.handleMethod("workspace/readFileChunk", { downloadId, offset });
  }
  return { root, cwd, service, file, start, read };
}

function errorCode(expected) {
  return (error) => error.errorCode === expected;
}

test("binary download reconstructs exact bytes across chunks and closes at eof", async (t) => {
  const f = fixture(t);
  const source = Buffer.alloc(256 * 1024 + 123);
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
  const local = f.file("中文 资料.docx", source);
  const metadata = await f.start(local, { cwd: "forged-cwd" });
  assert.equal(metadata.fileName, "中文 资料.docx");
  assert.equal(metadata.path, fs.realpathSync(local));
  assert.equal(metadata.byteLength, source.length);
  assert.equal(metadata.chunkSize, 262144);
  assert.equal(typeof metadata.mtimeMs, "number");
  const first = await f.read(metadata.downloadId);
  const last = await f.read(metadata.downloadId, first.bytesRead);
  assert.equal(first.eof, false);
  assert.equal(first.bytesRead, metadata.chunkSize);
  assert.equal(last.offset, metadata.chunkSize);
  assert.equal(last.bytesRead, 123);
  assert.equal(last.eof, true);
  assert.deepEqual(Buffer.concat([Buffer.from(first.dataBase64, "base64"), Buffer.from(last.dataBase64, "base64")]), source);
  await assert.rejects(f.read(metadata.downloadId), errorCode("download_expired"));
});

test("empty files and exact chunk boundaries return a final valid chunk", async (t) => {
  const f = fixture(t);
  const empty = await f.start(f.file("empty.pdf", Buffer.alloc(0)));
  assert.deepEqual(await f.read(empty.downloadId), { offset: 0, bytesRead: 0, dataBase64: "", eof: true });
  const exact = await f.start(f.file("exact.bin", Buffer.alloc(262144, 7)));
  const result = await f.read(exact.downloadId);
  assert.equal(result.bytesRead, 262144);
  assert.equal(result.eof, true);
});

test("invalid offsets are rejected without closing a valid download", async (t) => {
  const f = fixture(t);
  const metadata = await f.start(f.file("data.bin", Buffer.from([0, 1, 255])));
  for (const offset of [-1, 0.5, 4, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.read(metadata.downloadId, offset), errorCode("invalid_offset"));
  }
  assert.equal((await f.read(metadata.downloadId)).bytesRead, 3);
});

test("offset may equal file size and closes the handle", async (t) => {
  const f = fixture(t);
  const metadata = await f.start(f.file("file.bin"));
  assert.deepEqual(await f.read(metadata.downloadId, metadata.byteLength), {
    offset: metadata.byteLength, bytesRead: 0, dataBase64: "", eof: true,
  });
});

test("files above 100 MiB and directories are rejected", async (t) => {
  const f = fixture(t);
  const large = f.file("large.bin", "");
  fs.truncateSync(large, 104857601);
  await assert.rejects(f.start(large), errorCode("file_too_large"));
  await assert.rejects(f.start(f.cwd), errorCode("file_not_found"));
  fs.truncateSync(large, 104857600);
  const metadata = await f.start(large);
  assert.equal(metadata.byteLength, 104857600);
});

test("two-handle limit, cancellation, and repeated close are safe", async (t) => {
  const f = fixture(t);
  const local = f.file("file.bin");
  const first = await f.start(local);
  await f.start(local);
  await assert.rejects(f.start(local), errorCode("too_many_downloads"));
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(await f.service.handleMethod("workspace/closeFileDownload", { downloadId: first.downloadId }), { closed: true });
  }
  await assert.rejects(f.read(first.downloadId), errorCode("download_expired"));
  await f.start(local);
});

test("concurrent starts never bypass the two-handle limit", async (t) => {
  const f = fixture(t);
  const local = f.file("file.bin");
  const results = await Promise.allSettled([f.start(local), f.start(local), f.start(local)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.find((result) => result.status === "rejected").reason.errorCode, "too_many_downloads");
});

test("idle downloads expire after 120 seconds and release capacity", async (t) => {
  let clock = 0;
  const f = fixture(t, { now: () => clock });
  const local = f.file("file.bin");
  const first = await f.start(local);
  await f.start(local);
  clock = 120000;
  await assert.rejects(f.read(first.downloadId), errorCode("download_expired"));
  await f.start(local);
});

test("bridge disposal closes handles and prevents new downloads", async (t) => {
  const f = fixture(t);
  const local = f.file("file.bin");
  const metadata = await f.start(local);
  await f.service.dispose();
  await f.service.dispose();
  await assert.rejects(f.read(metadata.downloadId), errorCode("download_expired"));
  await assert.rejects(f.start(local), errorCode("download_unavailable"));
  fs.renameSync(local, `${local}.moved`);
});

test("source mutation and path replacement fail rather than mixing versions", async (t) => {
  const f = fixture(t);
  const local = f.file("file.bin", Buffer.alloc(262145, 1));
  const metadata = await f.start(local);
  await f.read(metadata.downloadId);
  fs.appendFileSync(local, "changed");
  await assert.rejects(f.read(metadata.downloadId, 262144), errorCode("file_changed"));
  const second = await f.start(local);
  fs.renameSync(local, `${local}.old`);
  f.file("file.bin", Buffer.alloc(second.byteLength, 2));
  await assert.rejects(f.read(second.downloadId), errorCode("file_changed"));
});

test("mutation during the read is checked before returning bytes", async (t) => {
  const f = fixture(t);
  const local = f.file("data.bin", Buffer.alloc(262145, 1));
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      fs.appendFileSync(local, "changed");
      return result;
    };
    return handle;
  };
  try {
    const metadata = await f.start(local);
    await assert.rejects(f.read(metadata.downloadId), errorCode("file_changed"));
  } finally {
    fs.promises.open = originalOpen;
  }
});

test("missing thread, missing file and unreferenced path escapes are rejected", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.start("file.bin", { threadId: "" }), errorCode("missing_thread_id"));
  await assert.rejects(f.start("file.bin"), errorCode("file_not_found"));
  f.file("outside.pdf", "secret", true);
  await assert.rejects(f.start("../outside.pdf"), errorCode("file_path_not_allowed"));
});

test("realpath validation rejects an uncited symlink or Windows junction escape", async (t) => {
  const f = fixture(t);
  const outside = f.file("exports/outside.pdf", "secret", true);
  const link = path.join(f.cwd, "linked");
  try {
    fs.symlinkSync(path.dirname(outside), link, "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("Creating symlinks requires Windows developer mode or privilege.");
    throw error;
  }
  await assert.rejects(f.start(path.join(link, "outside.pdf")), errorCode("file_path_not_allowed"));
});

test("a real assistant citation authorizes exactly one outside file", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const outside = f.file("产物 (最终).pdf", Buffer.from([0, 255, 1]), true);
  context.turns[0].items.push({ type: "agentMessage", text: `[Download](<${outside}>)` });
  const metadata = await f.start(outside, { turnId: "turn-1" });
  assert.deepEqual(Buffer.from((await f.read(metadata.downloadId)).dataBase64, "base64"), Buffer.from([0, 255, 1]));
  await assert.rejects(f.start(f.file("other.pdf", "secret", true)), errorCode("file_path_not_allowed"));
  await assert.rejects(f.start(outside, { turnId: "turn-other" }), errorCode("file_path_not_allowed"));
});

test("an outside citation cannot authorize a different symlink alias to the same file", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const outside = f.file("exports/outside.pdf", "document", true);
  const alias = path.join(f.cwd, "alias");
  fs.symlinkSync(path.dirname(outside), alias, "junction");
  context.turns[0].items = [{ type: "agentMessage", text: `[File](<${outside}>)` }];
  await assert.rejects(f.start(path.join(alias, "outside.pdf")), errorCode("file_path_not_allowed"));
  const metadata = await f.start(outside);
  assert.equal((await f.read(metadata.downloadId)).eof, true);
});

test("file URLs, relative destinations and angle-bracket spaces match actual citations", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const outside = f.file("资料 (一).pdf", "test", true);
  for (const target of [pathToFileURL(outside).href, "../资料 (一).pdf"]) {
    context.turns[0].items = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `[File](<${target}>)` }] }];
    const metadata = await f.start(outside);
    assert.equal((await f.read(metadata.downloadId)).eof, true);
  }
});

test("forged phone text, user/tool links, bare names and code examples never authorize outside files", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const outside = f.file("outside.pdf", "secret", true);
  const link = `[Download](<${outside}>)`;
  for (const item of [
    { type: "message", role: "user", text: link },
    { type: "toolCallOutput", text: link },
    { type: "reasoning", text: link },
    { type: "agentMessage", text: "[Download](outside.pdf)" },
    { type: "agentMessage", text: `\`${link}\`` },
    { type: "agentMessage", text: `\`\`\`\n${link}\n\`\`\`` },
  ]) {
    context.turns[0].items = [item];
    await assert.rejects(f.start(outside, { messageText: link, cwd: f.root }), errorCode("file_path_not_allowed"));
  }
});

test("local source suffixes are stripped while drive letters remain valid", async (t) => {
  const f = fixture(t);
  const local = f.file("data.txt");
  const metadata = await f.start(`${local}:12:3`);
  assert.equal(metadata.path, fs.realpathSync(local));
  await f.read(metadata.downloadId);
  const hashSuffix = await f.start(`${local}#L12-L15`);
  assert.equal(hashSuffix.path, fs.realpathSync(local));
  await f.read(hashSuffix.downloadId);
  for (const remote of ["https://example.test/file.pdf", "file://remote/share/file.pdf", "\\\\server\\share\\file.pdf"]) {
    await assert.rejects(f.start(remote), errorCode("file_path_not_allowed"));
  }
});

test("literal percent filenames retain exact bytes both inside and outside the workspace", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const bytes = Buffer.from([0, 34, 254, 255]);
  const inside = f.file("a%20b.docx", bytes);
  f.file("a b.docx", "wrong file");
  const insideMetadata = await f.start(inside);
  assert.deepEqual(Buffer.from((await f.read(insideMetadata.downloadId)).dataBase64, "base64"), bytes);
  const outside = f.file("a%20b.docx", bytes, true);
  f.file("a b.docx", "wrong file", true);
  context.turns[0].items = [{ type: "agentMessage", text: "[Literal](../a%20b.docx)" }];
  const outsideMetadata = await f.start(outside);
  assert.deepEqual(Buffer.from((await f.read(outsideMetadata.downloadId)).dataBase64, "base64"), bytes);
  await assert.rejects(f.start(path.join(f.root, "a b.docx")), errorCode("file_path_not_allowed"));
  const fileURL = `${pathToFileURL(outside).href}?download=1#preview`;
  context.turns[0].items = [{ type: "agentMessage", text: `[URL](<${fileURL}>)` }];
  const urlMetadata = await f.start(fileURL);
  assert.deepEqual(Buffer.from((await f.read(urlMetadata.downloadId)).dataBase64, "base64"), bytes);
});

test("a home-directory thread grants only an exact cited file, including ~/ paths", async (t) => {
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  const originalHome = os.homedir;
  os.homedir = () => f.root;
  try {
    context.cwd = f.root;
    const bytes = Buffer.from([0, 255, 23]);
    f.file("export%20.docx", bytes, true);
    const secret = f.file("uncited.txt", "secret", true);
    context.turns[0].items = [{ type: "agentMessage", text: "[File](<~/export%20.docx>)" }];
    const metadata = await f.start("~/export%20.docx");
    assert.deepEqual(Buffer.from((await f.read(metadata.downloadId)).dataBase64, "base64"), bytes);
    await assert.rejects(f.start(secret), errorCode("file_path_not_allowed"));
  } finally {
    os.homedir = originalHome;
  }
});

test("raw destinations retain Mac backslashes and literal URL punctuation", () => {
  const macPath = "/tmp/a\\ (final)#part?x%20.docx";
  assert.equal(normalizeDownloadPath(macPath), macPath);
  assert.deepEqual(markdownLinkTargets(`[File](<${macPath}>)`), [macPath]);
  const windowsPath = "E:\\Documents\\(final)\\a%20b.docx";
  assert.deepEqual(markdownLinkTargets(`[File](${windowsPath})`), [windowsPath]);
  assert.equal(normalizeDownloadPath(windowsPath), windowsPath);
  const homePath = path.join(os.homedir(), "artifact%20.docx");
  assert.equal(normalizeDownloadPath("~/artifact%20.docx"), homePath);
  assert.deepEqual(markdownLinkTargets("[File](<~/artifact%20.docx>)"), ["~/artifact%20.docx"]);
});

test("POSIX filename punctuation and Mac backslashes preserve downloaded bytes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX filenames containing '?' or literal backslashes cannot be created on Windows.");
  const context = { cwd: "", turns: [{ id: "turn-1", items: [] }] };
  const f = fixture(t, { context });
  context.cwd = f.cwd;
  const bytes = Buffer.from([0, 34, 254, 255]);
  for (const outside of [false, true]) {
    const local = f.file("a\\ (final)#part?x%20.docx", bytes, outside);
    context.turns[0].items = [{ type: "agentMessage", text: `[File](<${local}>)` }];
    const metadata = await f.start(local);
    assert.deepEqual(Buffer.from((await f.read(metadata.downloadId)).dataBase64, "base64"), bytes);
  }
});

test("download RPC replies use the standard encrypted-response callback contract", async (t) => {
  const f = fixture(t);
  const local = f.file("file.bin");
  const response = await new Promise((resolve) => {
    assert.equal(f.service.handleRequest(JSON.stringify({ id: "request-1", method: "workspace/startFileDownload",
      params: { threadId: "thread-1", path: local } }), (raw) => resolve(JSON.parse(raw))), true);
  });
  assert.equal(response.id, "request-1");
  assert.equal(typeof response.result.downloadId, "string");
  assert.equal(f.service.handleRequest("{}", () => assert.fail("Unexpected response")), false);
});

test("runtime reader uses the authoritative OpenCode API and bridge download route wins", async (t) => {
  const f = fixture(t);
  const runtime = {
    handlesThreadId: (id) => id.startsWith("opencode:"),
    async handleRequest(request) {
      assert.equal(request.method, "thread/read");
      assert.equal(request.params.includeTurns, true);
      return { thread: { id: request.params.threadId, cwd: f.cwd, turns: [] } };
    },
  };
  const reader = createFileDownloadThreadReader({
    openCodeRuntime: runtime,
    sendCodexRequest() { assert.fail("OpenCode downloads must not read Codex"); },
    readRollout() { assert.fail("OpenCode downloads must not scan Codex rollouts"); },
  });
  assert.equal((await reader("opencode:session-1")).cwd, f.cwd);
  for (const method of ["workspace/startFileDownload", "workspace/readFileChunk", "workspace/closeFileDownload"]) {
    assert.equal(isOpenCodeRequest({ method, params: { threadId: "opencode:session-1" } }, runtime), false);
  }
});

test("Codex runtime reader augments missing recent citations with bounded trusted rollout results", async (t) => {
  const f = fixture(t);
  const turns = [{ id: "turn-1", items: [{ type: "message", role: "assistant", text: "trusted" }] }];
  const reader = createFileDownloadThreadReader({
    async sendCodexRequest(method, params) {
      assert.equal(method, "thread/read");
      assert.equal(params.includeTurns, true);
      return { thread: { id: params.threadId, cwd: f.cwd, turns: [] } };
    },
    readRollout: () => ({ cwd: "older-cwd", turns }),
  });
  assert.deepEqual(await reader("thread-1"), { cwd: f.cwd, turns });
  const fallbackOnly = createFileDownloadThreadReader({
    async sendCodexRequest() { throw new Error("Unavailable runtime"); },
    readRollout: () => ({ cwd: f.cwd, turns }),
  });
  assert.deepEqual(await fallbackOnly("thread-1"), { cwd: f.cwd, turns });
  const wrongThread = createFileDownloadThreadReader({
    async sendCodexRequest() { return { thread: { id: "other-thread", cwd: f.root, turns } }; },
  });
  await assert.rejects(wrongThread("thread-1"), errorCode("thread_not_found"));
});
