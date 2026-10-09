const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const mobile = path.resolve(__dirname, "../../CodexMobile/CodexMobile");
const read = (file) => fs.readFileSync(path.join(mobile, file), "utf8");

// These declarations have four-space method indentation; preserve their Swift verbatim.
function method(source, name) {
  const match = source.match(new RegExp(`^    (?:static )?func ${name}\\b[\\s\\S]*?^    \\}`, "m"));
  assert.ok(match, `Swift method ${name} was not found`);
  return match[0];
}

function declaration(source, name) {
  const match = source.match(new RegExp(`^(?:struct|enum) ${name}\\b[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `Swift declaration ${name} was not found`);
  return match[0];
}

function harness() {
  const service = read("Services/CodexService.swift");
  const sync = read("Services/CodexService+Sync.swift");
  const messages = read("Services/CodexService+Messages.swift");
  const incoming = read("Services/CodexService+Incoming.swift");
  const admission = incoming.match(/^            let shouldMarkOutcomeAsUnread = [\s\S]*?(?=^            if completesCurrentThreadRun)/m);
  assert.ok(admission, "Incoming completion admission expression was not found");
  const startAcknowledgement = incoming.match(/^            if !isHistoricalCompletionEvent\(paramsObject\), let turnID \{[\s\S]*?^            \}/m);
  assert.ok(startAcknowledgement, "Incoming live-start acknowledgement block was not found");
  const methods = [
    ...["refreshInactiveRunningBadgeThreads", "pruneRunningThreadWatchlist", "threadHasActiveOrRunningTurn"]
      .map((name) => method(sync, name)),
    ...["markThreadAsViewed", "markReadyIfUnread", "markFailedIfUnread", "clearOutcomeBadge", "clearRunningThreadWatch", "activeTurnID", "turnTerminalState"]
      .map((name) => method(messages, name)),
    method(read("Services/CodexService+ThreadsTurns.swift"), "normalizedInterruptIdentifier"),
  ].join("\n\n");
  return String.raw`import Foundation

${declaration(service, "CodexRunningThreadWatch")}
${declaration(service, "CodexTurnTerminalState")}
enum CodexSyntheticIdentifiers {
${method(read("Models/CodexSyntheticIdentifiers.swift"), "isProjectedDesktopTurnID")}
}
struct CodexThread { let id: String }
struct CompletionBanner { let threadId: String }

@MainActor final class Gate {
    var entered = false
    var continuation: CheckedContinuation<Void, Never>?
    func pause() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            entered = true
        }
    }
    func waitForEntry() async {
        while !entered { await Task.yield() }
    }
    func release() { continuation!.resume(); continuation = nil }
}

@MainActor final class CodexService {
    var threads = [CodexThread(id: "chat")]
    var activeThreadId: String?
    var activeTurnIdByThread: [String: String] = [:]
    var runningThreadIDs: Set<String> = []
    var protectedRunningFallbackThreadIDs: Set<String> = []
    var desktopMirroredRunningThreadIDs: Set<String> = []
    var readyThreadIDs: Set<String> = []
    var failedThreadIDs: Set<String> = []
    var runningThreadWatchByID: [String: CodexRunningThreadWatch] = [:]
    var latestTurnTerminalStateByThread: [String: CodexTurnTerminalState] = [:]
    var terminalStateByTurnID: [String: CodexTurnTerminalState] = [:]
    var projectedTerminalStateByThreadID: [String: [String: CodexTurnTerminalState]] = [:]
    var viewedProjectedTurnIDsByThread: [String: Set<String>] = [:]
    var recentRunCompletionEventsByThread: [String: Bool] = [:]
    var threadCompletionBanner: CompletionBanner?
    var bannerCount = 0
    var refreshGate: Gate?
    var historyGate: Gate?
    var refreshSucceeds = true
    var closesOnRefresh = true
    var refreshCalls = 0
    var historyCalls = 0

    // Only RPC I/O and presentation are replaced; the state-mutating methods below are production Swift.
    func refreshInFlightTurnState(threadId: String) async -> Bool {
        refreshCalls += 1
        if let refreshGate { await refreshGate.pause() }
        if refreshSucceeds && closesOnRefresh {
            runningThreadIDs.remove(threadId)
            protectedRunningFallbackThreadIDs.remove(threadId)
            desktopMirroredRunningThreadIDs.remove(threadId)
            activeTurnIdByThread.removeValue(forKey: threadId)
        }
        return refreshSucceeds
    }
    func syncThreadHistory(threadId: String, force: Bool) async {
        historyCalls += 1
        if let historyGate { await historyGate.pause() }
    }
    func presentThreadCompletionBannerIfNeeded(threadId: String) {
        bannerCount += 1
        threadCompletionBanner = CompletionBanner(threadId: threadId)
    }
    func isHistoricalCompletionEvent(_ paramsObject: [String: Bool]?) -> Bool {
        paramsObject?["remodexRolloutTerminalCatchUp"] == true
    }
    func completionNeedsUnread(threadId: String, resolvedTurnID: String?,
                               paramsObject: [String: Bool]?, wasAlreadyHandled: Bool) -> Bool {
${admission[0]}
        return shouldMarkOutcomeAsUnread
    }
    func applyTurnStartAcknowledgement(threadId: String, turnID: String?, paramsObject: [String: Bool]?) {
${startAcknowledgement[0]}
    }

${methods}
}

@main struct CompletionBadgeChecks {
    @MainActor static func runningService() -> CodexService {
        let service = CodexService()
        service.runningThreadIDs.insert("chat")
        service.activeTurnIdByThread["chat"] = "turn-a"
        service.runningThreadWatchByID["chat"] = CodexRunningThreadWatch(
            threadId: "chat", expiresAt: Date().addingTimeInterval(60))
        return service
    }
    @MainActor static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
    @MainActor static func main() async {
        for stage in ["refresh", "history"] {
            for action in ["view", "cancel", "replace"] {
                let service = runningService()
                let gate = Gate()
                if stage == "refresh" { service.refreshGate = gate } else { service.historyGate = gate }
                let task = Task { await service.refreshInactiveRunningBadgeThreads() }
                await gate.waitForEntry()
                var replacement: CodexRunningThreadWatch?
                if action == "view" {
                    service.activeThreadId = "chat"
                    service.markThreadAsViewed("chat")
                    service.activeThreadId = nil
                } else if action == "cancel" {
                    service.clearRunningThreadWatch("chat")
                } else {
                    replacement = CodexRunningThreadWatch(threadId: "chat", expiresAt: Date().addingTimeInterval(120))
                    service.runningThreadWatchByID["chat"] = replacement
                }
                gate.release()
                await task.value
                expect(service.readyThreadIDs.isEmpty && service.bannerCount == 0,
                       "\(stage) await / \(action): stale refresh restored a viewed badge")
                expect(service.runningThreadWatchByID["chat"] == replacement,
                       "\(stage) await / \(action): stale refresh consumed a replacement watch")
            }
        }

        let newerRun = runningService()
        let gate = Gate()
        newerRun.historyGate = gate
        let task = Task { await newerRun.refreshInactiveRunningBadgeThreads() }
        await gate.waitForEntry()
        newerRun.runningThreadIDs.insert("chat")
        newerRun.activeTurnIdByThread["chat"] = "turn-b"
        gate.release()
        await task.value
        expect(newerRun.threadHasActiveOrRunningTurn("chat"), "History catch-up erased the next live run")
        expect(newerRun.readyThreadIDs.isEmpty && newerRun.bannerCount == 0, "History catch-up readied the next live run")

        for refreshSucceeds in [false, true] {
            let running = runningService()
            running.refreshSucceeds = refreshSucceeds
            running.closesOnRefresh = false
            await running.refreshInactiveRunningBadgeThreads()
            expect(running.readyThreadIDs.isEmpty && running.bannerCount == 0,
                   "Unknown or still-running state became ready")
            expect(running.historyCalls == 0 && running.runningThreadWatchByID["chat"] != nil,
                   "Unknown or still-running state consumed its watch")
        }

        let completed = runningService()
        await completed.refreshInactiveRunningBadgeThreads()
        expect(completed.readyThreadIDs == ["chat"] && completed.bannerCount == 1,
               "Real off-screen completion did not become ready")
        expect(completed.historyCalls == 1 && completed.runningThreadWatchByID["chat"] == nil,
               "Real completion did not finish its watch")
        await completed.refreshInactiveRunningBadgeThreads()
        expect(completed.bannerCount == 1, "Completed watch notified twice")
        completed.markThreadAsViewed("chat")
        await completed.refreshInactiveRunningBadgeThreads()
        expect(completed.readyThreadIDs.isEmpty && completed.bannerCount == 1,
               "Viewed completion was restored")

        let expired = runningService()
        expired.runningThreadWatchByID["chat"] = CodexRunningThreadWatch(threadId: "chat", expiresAt: .distantPast)
        await expired.refreshInactiveRunningBadgeThreads()
        expect(expired.refreshCalls == 0 && expired.readyThreadIDs.isEmpty, "Expired watch was polled")

        let incoming = CodexService()
        let catchUp = ["remodexRolloutTerminalCatchUp": true]
        for receipt in [false, true] {
            expect(incoming.completionNeedsUnread(threadId: "chat", resolvedTurnID: "turn-a",
                   paramsObject: catchUp, wasAlreadyHandled: receipt),
                   "Unknown terminal catch-up was suppressed by notification metadata")
        }
        incoming.terminalStateByTurnID["turn-a"] = .completed
        incoming.latestTurnTerminalStateByThread["chat"] = .completed
        incoming.markThreadAsViewed("chat")
        for historical in [false, true] {
            expect(!incoming.completionNeedsUnread(threadId: "chat", resolvedTurnID: "turn-a",
                   paramsObject: ["remodexRolloutTerminalCatchUp": historical], wasAlreadyHandled: true),
                   "Already viewed terminal became unread again")
        }
        expect(incoming.completionNeedsUnread(threadId: "chat", resolvedTurnID: "turn-b",
               paramsObject: catchUp, wasAlreadyHandled: false),
               "An unseen next completion was suppressed by the prior turn")
        incoming.runningThreadIDs.insert("chat")
        incoming.activeTurnIdByThread["chat"] = "turn-b"
        incoming.terminalStateByTurnID["turn-b"] = .completed
        expect(incoming.completionNeedsUnread(threadId: "chat", resolvedTurnID: "turn-b",
               paramsObject: catchUp, wasAlreadyHandled: true),
               "Next live completion was suppressed after a racing history read")

        let projected = CodexService()
        projected.projectedTerminalStateByThreadID["chat"] = ["ipc-turn-0": .completed]
        projected.markThreadAsViewed("chat")
        expect(projected.viewedProjectedTurnIDsByThread["chat"]?.contains("ipc-turn-0") == true,
               "Viewing a projected completion did not acknowledge its turn")
        projected.projectedTerminalStateByThreadID.removeAll()
        projected.latestTurnTerminalStateByThread.removeAll()
        expect(!projected.completionNeedsUnread(threadId: "chat", resolvedTurnID: "ipc-turn-0",
               paramsObject: catchUp, wasAlreadyHandled: false),
               "A viewed projected completion returned after runtime cache replacement")
        projected.applyTurnStartAcknowledgement(threadId: "chat", turnID: "ipc-turn-0", paramsObject: catchUp)
        projected.applyTurnStartAcknowledgement(threadId: "chat", turnID: nil, paramsObject: nil)
        expect(projected.viewedProjectedTurnIDsByThread["chat"]?.contains("ipc-turn-0") == true,
               "A historical or unidentified start cleared the read acknowledgement")
        projected.applyTurnStartAcknowledgement(threadId: "chat", turnID: "ipc-turn-0", paramsObject: nil)
        expect(projected.completionNeedsUnread(threadId: "chat", resolvedTurnID: "ipc-turn-0",
               paramsObject: catchUp, wasAlreadyHandled: false),
               "A real new projected run could not notify after reusing its turn ID")

        for failed in [false, true] {
            let foreground = CodexService()
            foreground.activeThreadId = "chat"
            foreground.projectedTerminalStateByThreadID["chat"] = ["ipc-turn-0": failed ? .failed : .completed]
            if failed { foreground.markFailedIfUnread(threadId: "chat") }
            else { foreground.markReadyIfUnread(threadId: "chat") }
            foreground.activeThreadId = nil
            foreground.projectedTerminalStateByThreadID.removeAll()
            expect(foreground.readyThreadIDs.isEmpty && foreground.failedThreadIDs.isEmpty && foreground.bannerCount == 0,
                   "A foreground completion was marked unread")
            expect(!foreground.completionNeedsUnread(threadId: "chat", resolvedTurnID: "ipc-turn-0",
                   paramsObject: catchUp, wasAlreadyHandled: false),
                   "A completion viewed live returned after runtime cache replacement")
        }
        print("Swift completion badge checks passed")
    }
}
`;
}

test("iOS completion badges execute production Swift across async viewing races", { timeout: 120_000 }, (t) => {
  const compiler = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (compiler.error?.code === "ENOENT" && process.platform !== "darwin") {
    t.skip("Native Swift checks were not run: swiftc is unavailable on this platform");
    return;
  }
  assert.equal(compiler.status, 0, `macOS must execute Swift checks: ${compiler.error || compiler.stderr}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-completion-check-"));
  try {
    const source = path.join(temporary, "CompletionBadgeChecks.swift");
    const executable = path.join(temporary, process.platform === "win32" ? "checks.exe" : "checks");
    fs.writeFileSync(source, harness());
    const build = spawnSync("swiftc", ["-swift-version", "5", "-parse-as-library", source, "-o", executable], {
      encoding: "utf8", timeout: 90_000,
    });
    assert.equal(build.status, 0, `Swift check compilation failed:\n${build.error || ""}${build.stdout}${build.stderr}`);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 15_000 });
    assert.equal(run.status, 0, `Swift completion checks failed:\n${run.error || ""}${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Swift completion badge checks passed/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
