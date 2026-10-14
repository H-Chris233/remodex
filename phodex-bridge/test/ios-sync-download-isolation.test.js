const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS sidebar timeouts preserve serving downloads and do not leak their error to other requests", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-swift-sync-downloads-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const services = path.resolve(__dirname, "../../CodexMobile/CodexMobile/Services");
  function extract(file, start, end) {
    const source = fs.readFileSync(path.join(services, file), "utf8");
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `extract complete production method ${start}`);
    return source.slice(first, last);
  }
  const methods = [
    extract("CodexService+Sync.swift", "    func syncThreadsList()", "    func syncThreadHistory("),
    extract("CodexService+Connection.swift", "    func handleReceiveError(", "\n}\n"),
    extract("CodexService+Connection.swift", "    func hasReceivedSecureActivity(", "    // Detects connect-time"),
    extract("CodexService+Transport.swift", "    func failAllPendingRequests(", "    func idKey("),
    extract("CodexService+Transport.swift", "    func probeForegroundConnectionIfNeeded()", "    private func foregroundConnectionProbeResult("),
  ].join("\n");
  const harness = path.join(directory, "SyncDownloadChecks.swift");
  fs.writeFileSync(harness, String.raw`
import Foundation
nonisolated enum CodexServiceError: LocalizedError {
    case disconnected, invalidInput(String)
    var errorDescription: String? {
        switch self { case .disconnected: return "Disconnected"; case .invalidInput(let value): return value }
    }
}
struct CodexSecureSession { var sessionId: String; var keyEpoch: Int; var lastInboundCounter: Int }
enum NWProtocolWebSocket { enum CloseCode {} }
enum CodexWebSocketKeepAlivePolicy { static let foregroundProbeTimeoutNanoseconds: UInt64 = 1 }
struct Voice { func connectionLost(allowRecovery: Bool) {} }
typealias RPCMessage = String
@MainActor final class CodexService {
    var isConnected = true, isInitialized = true, isAppInForeground = true
    var shouldAutoReconnectOnForeground = false
    var secureSession: CodexSecureSession? = CodexSecureSession(sessionId: "test-session", keyEpoch: 1, lastInboundCounter: 0)
    var pendingRequests: [String: CheckedContinuation<RPCMessage, Error>] = [:]
    var threads: [Int] = [], resumedThreadIDs: Set<String> = []
    var recentActiveThreadListLimit = 1, trustedReconnectFailureCount = 0
    var connectionRecoveryState = "", lastErrorMessage: String?
    var realtimeVoice = Voice()
    var socketCloses = 0
    var webSocketForegroundProbeTimeoutOverrideNanoseconds: UInt64?
    var fetch: () async throws -> [Int] = { throw CodexServiceError.invalidInput("thread/list timed out while syncing chats.") }
    var probe: () async -> Result<Void, Error> = { .failure(CodexServiceError.invalidInput("thread/list timed out while syncing chats.")) }
    func fetchCoalescedServerThreads(limit: Int) async throws -> [Int] { try await fetch() }
    func foregroundConnectionProbeResult(timeoutNanoseconds: UInt64) async -> Result<Void, Error> { await probe() }
    func isRecoverableTransientConnectionError(_ error: Error) -> Bool {
        if case CodexServiceError.invalidInput(let message) = error { return message.contains("timed out") }
        return false
    }
    func receiveErrorDisposition(for error: Error, relayCloseCode: NWProtocolWebSocket.CloseCode?) ->
        (shouldAutoReconnectOnForeground: Bool, shouldClearSavedRelaySession: Bool, connectionRecoveryState: String, lastErrorMessage: String?) {
        (true, false, "retrying", error.localizedDescription)
    }
    func cancelCurrentSocketConnection() { socketCloses += 1 }
    func resetSecureTransportState() { secureSession = nil }
    func clearSavedRelaySession() { secureSession = nil }
    func cancelRuntimeSettingsUpdates() {}
    func finalizeAllStreamingState(preserveRunLifecycle: Bool) {}
    func endBackgroundRunGraceTask(reason: String) {}
    func clearConnectionSyncState() {}
    func reconcileLocalThreadsWithServer(_ threads: [Int]) {}
    func debugSyncLog(_ message: String) {}
    func presentConnectionErrorIfNeeded(_ error: Error) { lastErrorMessage = error.localizedDescription }
` + methods + String.raw`
}
@main struct Checks {
    @MainActor static func pendingFile(_ service: CodexService) async -> Task<String, Error> {
        let file: Task<String, Error> = Task { @MainActor in
            try await withCheckedThrowingContinuation { continuation in
                service.pendingRequests["file"] = continuation
            }
        }
        while service.pendingRequests["file"] == nil { await Task.yield() }
        return file
    }
    @MainActor static func main() async throws {
        let timeout = CodexServiceError.invalidInput("thread/list timed out while syncing chats.")
        let healthy = CodexService()
        let file = await pendingFile(healthy)
        healthy.fetch = {
            healthy.secureSession!.lastInboundCounter += 1
            throw timeout
        }
        await healthy.syncThreadsList()
        precondition(healthy.isConnected && healthy.socketCloses == 0, "sidebar timeout disconnected a serving download")
        precondition(healthy.pendingRequests["file"] != nil, "sidebar timeout failed the file request")
        healthy.pendingRequests.removeValue(forKey: "file")!.resume(returning: "file bytes")
        let bytes = try await file.value
        precondition(bytes == "file bytes")

        let dead = CodexService()
        let interruptedFile = await pendingFile(dead)
        await dead.syncThreadsList()
        precondition(!dead.isConnected && dead.socketCloses == 1, "a silent dead peer must still reconnect")
        do { _ = try await interruptedFile.value; preconditionFailure("file must fail when the socket closes") }
        catch CodexServiceError.disconnected {}
        catch { preconditionFailure("wrong file error: \(error)") }

        let foreground = CodexService()
        foreground.probe = {
            foreground.secureSession!.lastInboundCounter += 1
            return .failure(timeout)
        }
        await foreground.probeForegroundConnectionIfNeeded()
        precondition(foreground.isConnected && foreground.socketCloses == 0)
        foreground.probe = { .failure(timeout) }
        await foreground.probeForegroundConnectionIfNeeded()
        precondition(!foreground.isConnected && foreground.socketCloses == 1)

        let auth = CodexService()
        let authFile = await pendingFile(auth)
        auth.handleReceiveError(CodexServiceError.invalidInput("pairing rejected"))
        do { _ = try await authFile.value; preconditionFailure("authentication error must propagate") }
        catch CodexServiceError.invalidInput(let message) { precondition(message == "pairing rejected") }
        catch { preconditionFailure("authentication failure was masked") }
        print("sync/download isolation checks passed")
    }
}
`);
  const binary = path.join(directory, "sync-downloads");
  execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-default-isolation", "MainActor", "-parse-as-library",
    "-module-cache-path", path.join(directory, "cache"), harness, "-o", binary], { timeout: 45000 });
  const output = execFileSync(binary, { encoding: "utf8", timeout: 10000 });
  assert.match(output, /sync\/download isolation checks passed/);
});
