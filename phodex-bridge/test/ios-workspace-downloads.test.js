const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS original-file store preserves names, validates chunks and reopens offline copies", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-swift-downloads-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../CodexMobile/CodexMobile/Services/CodexService+WorkspaceDownloads.swift"), "utf8");
  const typesStart = source.indexOf("nonisolated struct WorkspaceDownloadedFile:");
  const typesEnd = source.indexOf("\nextension CodexService {", typesStart);
  const storeStart = source.indexOf("private actor WorkspaceDownloadStore {");
  assert.ok(typesStart >= 0 && typesEnd > typesStart && storeStart > typesEnd,
    "compile the complete production download models and disk actor");
  const harness = path.join(directory, "WorkspaceDownloads.swift");
  fs.writeFileSync(harness, "import Foundation\n" + source.slice(typesStart, typesEnd)
    + "\nnonisolated enum CodexServiceError: Error { case invalidResponse(String), invalidInput(String), disconnected }\n"
    + source.slice(storeStart) + String.raw`

private func expectFailure(_ operation: () async throws -> Void) async throws {
    do {
        try await operation()
        preconditionFailure("Expected invalid chunks to fail")
    } catch { }
}

@main struct WorkspaceDownloadChecks {
    static func main() async throws {
        precondition(WorkspaceDownloadNetworkError.allowsCachedCopy(CodexServiceError.disconnected))
        precondition(WorkspaceDownloadNetworkError.allowsCachedCopy(WorkspaceDownloadNetworkError.timedOut))
        precondition(!WorkspaceDownloadNetworkError.allowsCachedCopy(CancellationError()))
        precondition(!WorkspaceDownloadNetworkError.allowsCachedCopy(CodexServiceError.invalidInput("File not found")))
        precondition(!WorkspaceDownloadNetworkError.allowsCachedCopy(
            CodexServiceError.invalidInput(WorkspaceDownloadNetworkError.timeoutMessage)))
        precondition(!WorkspaceDownloadNetworkError.allowsCachedCopy(CodexServiceError.invalidResponse("Malformed response")))
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let documents = root.appendingPathComponent("Documents", isDirectory: true)
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let files = FileManager.default
        let downloads = documents.appendingPathComponent("Downloads", isDirectory: true)
        try files.createDirectory(at: downloads, withIntermediateDirectories: true)
        let key = WorkspaceDownloadKey(
            identity: WorkspaceDownloadIdentity(deviceID: "computer", publicKey: "trusted-public-key"),
            threadID: "thread", requestedPath: "output/作品.docx"
        )
        let payload = Data([0, 255, 1, 2, 0])
        let metadata = WorkspaceDownloadMetadata(
            sourcePath: "E:/Project/output/作品.docx", fileName: "作品.docx",
            byteLength: payload.count, mtimeMs: 1234, chunkSize: 3
        )
        let store = WorkspaceDownloadStore(documentsDirectory: documents, supportDirectory: support)
        let userFile = downloads.appendingPathComponent("作品.docx")
        let userBytes = Data("user-owned original".utf8)
        try userBytes.write(to: userFile)
        let id = try await store.begin(metadata: metadata)
        let firstOffset = try await store.append(id, offset: 0, bytesRead: 3,
            base64: payload.prefix(3).base64EncodedString(), eof: false)
        precondition(firstOffset == 3)
        let finalOffset = try await store.append(id, offset: 3, bytesRead: 2,
            base64: payload.suffix(2).base64EncodedString(), eof: true)
        precondition(finalOffset == payload.count)
        let saved = try await store.finish(id, key: key)
        precondition(saved.fileName == "作品 (1).docx" && !saved.isLocalCache)
        let savedBytes = try Data(contentsOf: saved.url)
        let untouchedUserBytes = try Data(contentsOf: userFile)
        precondition(savedBytes == payload && untouchedUserBytes == userBytes)

        let reopened = WorkspaceDownloadStore(documentsDirectory: documents, supportDirectory: support)
        let cached = try await reopened.cachedFile(for: key, matching: metadata)
        precondition(cached?.url == saved.url && cached?.isLocalCache == true)
        let changed = WorkspaceDownloadMetadata(sourcePath: metadata.sourcePath,
            fileName: metadata.fileName, byteLength: metadata.byteLength, mtimeMs: 1235, chunkSize: 3)
        let changedCache = try await reopened.cachedFile(for: key, matching: changed)
        precondition(changedCache == nil)
        let otherComputer = WorkspaceDownloadKey(
            identity: WorkspaceDownloadIdentity(deviceID: "computer", publicKey: "different-public-key"),
            threadID: key.threadID, requestedPath: key.requestedPath)
        let otherCache = try await reopened.cachedFile(for: otherComputer)
        precondition(otherCache == nil)

        let badID = try await reopened.begin(metadata: metadata)
        try await expectFailure {
            _ = try await reopened.append(badID, offset: 1, bytesRead: 1, base64: "AA==", eof: false)
        }
        try await expectFailure {
            _ = try await reopened.append(badID, offset: 0, bytesRead: 2, base64: "AA==", eof: false)
        }
        try await expectFailure {
            _ = try await reopened.append(badID, offset: 0, bytesRead: 1, base64: "AA==", eof: true)
        }
        try await expectFailure {
            _ = try await reopened.append(badID, offset: 0, bytesRead: 1, base64: "invalid", eof: false)
        }
        await reopened.abort(badID)

        let cancelledID = try await reopened.begin(metadata: metadata)
        _ = try await reopened.append(cancelledID, offset: 0, bytesRead: 3,
            base64: payload.prefix(3).base64EncodedString(), eof: false)
        let transfer = Task {
            do {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                _ = try await reopened.append(cancelledID, offset: 3, bytesRead: 2,
                    base64: payload.suffix(2).base64EncodedString(), eof: true)
            } catch {
                await reopened.abort(cancelledID)
                throw error
            }
        }
        transfer.cancel()
        try await expectFailure { try await transfer.value }
        let leftovers = try files.contentsOfDirectory(at: support, includingPropertiesForKeys: nil)
        precondition(!leftovers.contains { $0.pathExtension == "part" })

        let empty = WorkspaceDownloadMetadata(sourcePath: "E:/Project/empty.txt",
            fileName: "empty.txt", byteLength: 0, mtimeMs: 1234, chunkSize: 3)
        let emptyID = try await reopened.begin(metadata: empty)
        _ = try await reopened.append(emptyID, offset: 0, bytesRead: 0, base64: "", eof: true)
        let emptySaved = try await reopened.finish(emptyID, key: WorkspaceDownloadKey(
            identity: key.identity, threadID: key.threadID, requestedPath: "empty.txt"))
        let emptyBytes = try Data(contentsOf: emptySaved.url)
        precondition(emptySaved.fileName == "empty.txt" && emptyBytes.isEmpty)

        let backslash = WorkspaceDownloadMetadata(sourcePath: #"/repo/report\file.bin"#,
            fileName: #"report\file.bin"#, byteLength: 0, mtimeMs: 1234, chunkSize: 3)
        let backslashID = try await reopened.begin(metadata: backslash)
        _ = try await reopened.append(backslashID, offset: 0, bytesRead: 0, base64: "", eof: true)
        let backslashKey = WorkspaceDownloadKey(identity: key.identity, threadID: key.threadID,
            requestedPath: backslash.sourcePath)
        let backslashSaved = try await reopened.finish(backslashID, key: backslashKey)
        precondition(backslashSaved.fileName == backslash.fileName)
        let backslashCache = try await reopened.cachedFile(for: backslashKey)
        precondition(backslashCache?.url == backslashSaved.url)

        try files.removeItem(at: saved.url)
        let missing = try await reopened.cachedFile(for: key)
        precondition(missing == nil)
        print("workspace download store checks passed")
    }
}
`);
  const binary = path.join(directory, "workspace-downloads");
  const compilerHelp = execFileSync("xcrun", ["swiftc", "-help"], { encoding: "utf8", timeout: 10000 });
  assert.match(compilerHelp, /-default-isolation/, "requires Swift with the app's default isolation setting");
  execFileSync("xcrun", ["swiftc", "-parse-as-library", "-swift-version", "5", "-default-isolation", "MainActor",
    "-module-cache-path", path.join(directory, "cache"), harness, "-o", binary], { timeout: 45000 });
  const output = execFileSync(binary, [path.join(directory, "storage")], { encoding: "utf8", timeout: 10000 });
  assert.match(output, /workspace download store checks passed/);
});
