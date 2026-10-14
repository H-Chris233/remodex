import Foundation

extension CodexService {
    func handleRealtimeVoiceNotification(method: String, params: [String: JSONValue]) {
        realtimeVoice.handleNotification(method: method, params: params)
        guard let threadID = params["threadId"]?.stringValue else { return }
        switch method {
        case "thread/realtime/item/started", "thread/realtime/item/completed":
            if let item = params["item"]?.objectValue, let transcript = CodexVoiceTranscript(item: item) {
                upsertRealtimeTranscript(transcript, threadID: threadID)
            }
        case "thread/realtime/item/transcript/delta":
            guard let itemID = params["itemId"]?.stringValue,
                  let sessionID = params["remodexRealtimeSessionId"]?.stringValue,
                  let delta = params["delta"]?.stringValue,
                  var transcript = realtimeTranscriptByThread[threadID]?["realtime:\(sessionID):\(itemID)"] else { return }
            // Buffered reconnect replay already contains the canonical completed item.
            guard !isReplayedBridgeEvent(params) else { return }
            transcript.text += delta
            upsertRealtimeTranscript(transcript, threadID: threadID)
        default: break
        }
    }

    func upsertRealtimeTranscript(_ transcript: CodexVoiceTranscript, threadID: String, snapshotRevision: Int? = nil) {
        if let snapshotRevision, snapshotRevision != messageRevision(for: threadID),
           realtimeTranscriptByThread[threadID]?[transcript.messageID] != nil {
            return
        }
        realtimeTranscriptByThread[threadID, default: [:]][transcript.messageID] = transcript
        var messages = messagesByThread[threadID] ?? []
        if let index = messages.firstIndex(where: { $0.id == transcript.messageID }) {
            guard messages[index].text != transcript.text else { realtimeVoice.receiveTranscript(transcript); return }
            messages[index].text = transcript.text
        } else {
            // Voice streaming is independent of a coding turn; it must not set the task's running badge.
            messages.append(CodexMessage(id: transcript.messageID, threadId: threadID,
                role: transcript.role == "user" ? .user : .assistant,
                assistantPhase: transcript.role == "assistant" ? "voice" : nil,
                text: transcript.text, itemId: transcript.id, sourceItemKey: transcript.messageID))
        }
        messagesByThread[threadID] = messages
        persistMessages()
        updateCurrentOutput(for: threadID)
        realtimeVoice.receiveTranscript(transcript)
    }

    // This endpoint supplies turn-less canonical voice items; thread/turns/list cannot restore them.
    func syncRealtimeTimeline(threadID: String, force: Bool = false) {
        guard isConnected, isInitialized, supportsRealtimeTimeline,
              thread(for: threadID)?.runtimeProvider != .opencode,
              realtimeTimelineTasks[threadID] == nil,
              force || Date().timeIntervalSince(realtimeTimelineSyncedAt[threadID] ?? .distantPast) > 30 else { return }
        realtimeTimelineTasks[threadID] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.realtimeTimelineTasks[threadID] = nil }
            var cursor: String?
            var seenCursors: Set<String> = []
            var positions: [String: Int] = [:]
            do {
                repeat {
                    try Task.checkCancellation()
                    guard self.isConnected, self.activeThreadId == threadID || self.realtimeVoice.threadID == threadID else { return }
                    var params: [String: JSONValue] = ["threadId": .string(threadID), "limit": .integer(100)]
                    if let cursor { params["cursor"] = .string(cursor) }
                    let snapshotRevision = self.messageRevision(for: threadID)
                    let response = try await self.sendRequest(method: "thread/timeline/list", params: .object(params), timeoutNanoseconds: 8_000_000_000)
                    guard let result = response.result?.objectValue, let entries = result["data"]?.arrayValue else { return }
                    let snapshotIsCurrent = self.messageRevision(for: threadID) == snapshotRevision
                    for value in entries {
                        guard let entry = value.objectValue, let item = entry["item"]?.objectValue,
                              let position = entry["position"]?.intValue else { continue }
                        if entry["type"]?.stringValue == "realtime", let transcript = CodexVoiceTranscript(item: item) {
                            self.upsertRealtimeTranscript(transcript, threadID: threadID, snapshotRevision: snapshotIsCurrent ? nil : snapshotRevision)
                            positions[transcript.messageID] = position
                        } else if entry["type"]?.stringValue == "item", let itemID = item["id"]?.stringValue {
                            let turnID = entry["turnId"]?.stringValue
                            for message in self.messages(for: threadID) where message.itemId == itemID && message.turnId == turnID {
                                positions[message.id] = position
                            }
                        }
                    }
                    cursor = result["nextCursor"]?.stringValue
                    if let cursor, !seenCursors.insert(cursor).inserted { return }
                } while cursor != nil
                var messages = self.messagesByThread[threadID] ?? []
                messages.sort { $0.orderIndex < $1.orderIndex }
                let slots = messages.indices.filter { positions[messages[$0].id] != nil }
                let ordered = slots.map { messages[$0] }.sorted {
                    let left = positions[$0.id, default: 0], right = positions[$1.id, default: 0]
                    return left == right ? $0.orderIndex < $1.orderIndex : left < right
                }
                let orderIndices = slots.map { messages[$0].orderIndex }
                for (offset, slot) in slots.enumerated() {
                    messages[slot] = ordered[offset]
                    messages[slot].orderIndex = orderIndices[offset]
                }
                self.messagesByThread[threadID] = messages
                self.persistMessages()
                self.updateCurrentOutput(for: threadID)
                self.realtimeTimelineSyncedAt[threadID] = Date()
            } catch CodexServiceError.rpcError(let error) where error.code == -32601 {
                self.supportsRealtimeTimeline = false
            } catch { /* Keep cached/live voice rows when canonical history is temporarily unavailable. */ }
        }
    }
}
