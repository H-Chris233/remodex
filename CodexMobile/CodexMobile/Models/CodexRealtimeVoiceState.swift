// Owns call intent separately from transport identity so ending a call can still receive its close acknowledgement.
import Foundation

nonisolated struct CodexRealtimeVoiceState: Equatable, Sendable {
    enum Phase: String, Sendable {
        case idle, starting, active, recovering, ending, failed
    }

    static let heartbeatSeconds: TimeInterval = 5
    static let leaseSeconds: TimeInterval = 45
    static let recoverySeconds: TimeInterval = 30
    static let nativeRecoverySeconds: TimeInterval = 5
    static let closeSeconds: TimeInterval = 15

    private(set) var phase: Phase = .idle
    private(set) var generation = 0
    private(set) var wantsActiveCall = false
    private(set) var recoveryStartedAt: TimeInterval?
    private(set) var hasRebuilt = false
    var isMuted = false

    var isLive: Bool { wantsActiveCall || phase == .ending }
    var shouldTransmit: Bool { wantsActiveCall && phase == .active && !isMuted }

    mutating func start() {
        generation += 1
        wantsActiveCall = true
        phase = .starting
        recoveryStartedAt = nil
        hasRebuilt = false
    }

    mutating func recover(at now: TimeInterval) {
        guard wantsActiveCall, phase != .recovering else { return }
        phase = .recovering
        recoveryStartedAt = now
        hasRebuilt = false
    }

    func mayRebuild(at now: TimeInterval, hasFailed: Bool) -> Bool {
        guard wantsActiveCall, phase == .recovering, !hasRebuilt, let started = recoveryStartedAt else { return false }
        return now - started < Self.recoverySeconds && (hasFailed || now - started >= Self.nativeRecoverySeconds)
    }

    mutating func rebuild(ifCleaned: Bool) -> Bool {
        guard wantsActiveCall, phase == .recovering, !hasRebuilt, ifCleaned else { return false }
        generation += 1
        hasRebuilt = true
        return true
    }

    enum ClosureDisposition: Equatable { case ignore, recover, end }
    func closureDisposition(reason: String?, replacingSession: Bool) -> ClosureDisposition {
        guard wantsActiveCall else { return .ignore }
        if replacingSession, phase == .recovering { return .ignore }
        return reason == "transport_closed" ? .recover : .end
    }

    mutating func connected() {
        guard wantsActiveCall else { return }
        phase = .active
        recoveryStartedAt = nil
    }

    mutating func end() {
        wantsActiveCall = false
        phase = .ending
        recoveryStartedAt = nil
    }

    mutating func finish(failed: Bool) {
        wantsActiveCall = false
        phase = failed ? .failed : .idle
        generation += 1
        recoveryStartedAt = nil
    }
}

nonisolated struct CodexVoiceTranscript: Identifiable, Equatable, Sendable {
    let id: String
    let sessionID: String
    let role: String
    var text: String

    init?(item: [String: JSONValue]) {
        guard item["type"]?.stringValue == "transcriptSegment",
              let id = item["id"]?.stringValue, !id.isEmpty,
              let sessionID = item["realtimeSessionId"]?.stringValue, !sessionID.isEmpty,
              let role = item["role"]?.stringValue, role == "user" || role == "assistant",
              let text = item["text"]?.stringValue else { return nil }
        self.id = id
        self.sessionID = sessionID
        self.role = role
        self.text = text
    }

    var messageID: String { "realtime:\(sessionID):\(id)" }

    static func sessionID(fromMessageID id: String) -> String? {
        guard id.hasPrefix("realtime:") else { return nil }
        let parts = id.dropFirst("realtime:".count).split(separator: ":", maxSplits: 1)
        return parts.count == 2 ? String(parts[0]) : nil
    }

    static func historySnapshotStillCurrent(_ transcript: CodexVoiceTranscript,
        snapshot: [String: CodexVoiceTranscript], current: [String: CodexVoiceTranscript]) -> Bool {
        snapshot[transcript.messageID] == current[transcript.messageID]
    }

    static func projectDelegations(_ messages: [CodexMessage]) -> [CodexMessage] {
        let canonicalSessions = Set(messages.compactMap { message -> String? in
            guard message.role == .user, !message.isRealtimeDelegation,
                  message.id.hasPrefix("realtime:"), !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return message.realtimeSessionId
        })
        return messages.compactMap { message in
            guard message.role == .user, message.isRealtimeDelegation,
                  let session = message.realtimeSessionId, canonicalSessions.contains(session) else { return message }
            guard !message.attachments.isEmpty || !message.fileMentions.isEmpty
                    || !message.skillMentions.isEmpty || !message.pluginMentions.isEmpty else { return nil }
            var attachmentRow = message
            attachmentRow.text = ""
            return attachmentRow
        }
    }
}
