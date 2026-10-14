import Foundation

extension CodexService {
    func handleRealtimeVoiceNotification(method: String, params: [String: JSONValue]) {
        realtimeVoice.handleNotification(method: method, params: params)
        guard let threadID = params["threadId"]?.stringValue else { return }
        if let item = params["item"]?.objectValue,
           let session = item["realtimeSessionId"]?.stringValue,
           method == "thread/realtime/item/started" || method == "thread/realtime/item/completed" {
            if item["type"]?.stringValue == "bemItemPromoted",
               let turn = item["turn_id"]?.stringValue, let itemID = item["item_id"]?.stringValue {
                associateRealtimeDelegation(threadID: threadID, turnID: turn, sessionID: session, itemID: itemID)
            }
        }
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

    func upsertRealtimeTranscript(_ transcript: CodexVoiceTranscript, threadID: String) {
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
                text: transcript.text, itemId: transcript.id, sourceItemKey: transcript.messageID, realtimeSessionId: transcript.sessionID))
        }
        messagesByThread[threadID] = messages
        persistMessages()
        updateCurrentOutput(for: threadID)
        realtimeVoice.receiveTranscript(transcript)
        if messages.contains(where: { $0.isRealtimeDelegation && $0.realtimeSessionId == nil }) {
            syncRealtimeTimeline(threadID: threadID, force: true)
        }
    }

    // A BEM promotion or canonical rollout position links a delegation by turn/item identity, never by text.
    func associateRealtimeDelegation(threadID: String, turnID: String, sessionID: String?, itemID: String, isMarkedItem: Bool = false) {
        let key = [turnID, itemID]
        if let sessionID { realtimeSessionByDelegatedItem[threadID, default: [:]][key] = sessionID }
        guard var messages = messagesByThread[threadID] else { return }
        var changed = false
        for index in messages.indices where messages[index].role == .user && messages[index].turnId == turnID && messages[index].itemId == itemID {
            if isMarkedItem, !messages[index].isRealtimeDelegation {
                messages[index].isRealtimeDelegation = true
                changed = true
            }
            if messages[index].isRealtimeDelegation, let sessionID, messages[index].realtimeSessionId != sessionID {
                messages[index].realtimeSessionId = sessionID
                changed = true
            }
        }
        if changed {
            messagesByThread[threadID] = messages
            persistMessages()
            updateCurrentOutput(for: threadID)
        }
    }

    // This endpoint supplies turn-less canonical voice items; thread/turns/list cannot restore them.
    func syncRealtimeTimeline(threadID: String, force: Bool = false) {
        guard isConnected, isInitialized, supportsRealtimeTimeline,
              thread(for: threadID)?.runtimeProvider != .opencode,
              realtimeTimelineTasks[threadID] == nil,
              force || Date().timeIntervalSince(realtimeTimelineSyncedAt[threadID] ?? .distantPast) > 30 else { return }
        realtimeTimelineTasks[threadID] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if !Task.isCancelled { self.realtimeTimelineTasks[threadID] = nil }
            }
            var cursor: String?
            var seenCursors: Set<String> = []
            var positions: [String: Int] = [:]
            do {
                repeat {
                    try Task.checkCancellation()
                    guard self.isConnected, self.activeThreadId == threadID || self.realtimeVoice.threadID == threadID else { return }
                    var params: [String: JSONValue] = ["threadId": .string(threadID), "limit": .integer(100)]
                    if let cursor { params["cursor"] = .string(cursor) }
                    let transcriptSnapshot = self.realtimeTranscriptByThread[threadID] ?? [:]
                    let response = try await self.sendRequest(method: "thread/timeline/list", params: .object(params), timeoutNanoseconds: 8_000_000_000)
                    try Task.checkCancellation()
                    guard let result = response.result?.objectValue, let entries = result["data"]?.arrayValue else { return }
                    let liveTranscriptsAtResponse = self.realtimeTranscriptByThread[threadID] ?? [:]
                    var activeSession = result["activeRealtimeSessionAtPageStart"]?.stringValue
                    for value in entries {
                        guard let entry = value.objectValue, let item = entry["item"]?.objectValue,
                              let position = entry["position"]?.intValue else { continue }
                        if entry["type"]?.stringValue == "realtime" {
                            switch item["type"]?.stringValue {
                            case "realtimeSessionStarted": activeSession = item["realtimeSessionId"]?.stringValue
                            case "realtimeSessionClosed":
                                if activeSession == item["realtimeSessionId"]?.stringValue { activeSession = nil }
                            case "bemItemPromoted":
                                if let turn = item["turn_id"]?.stringValue, let session = item["realtimeSessionId"]?.stringValue,
                                   let itemID = item["item_id"]?.stringValue {
                                    self.associateRealtimeDelegation(threadID: threadID, turnID: turn, sessionID: session, itemID: itemID)
                                }
                            default: break
                            }
                            if let transcript = CodexVoiceTranscript(item: item) {
                                if CodexVoiceTranscript.historySnapshotStillCurrent(transcript, snapshot: transcriptSnapshot,
                                    current: liveTranscriptsAtResponse) {
                                    self.upsertRealtimeTranscript(transcript, threadID: threadID)
                                }
                                positions[transcript.messageID] = position
                            }
                        } else if entry["type"]?.stringValue == "item", let itemID = item["id"]?.stringValue {
                            let turnID = entry["turnId"]?.stringValue
                            if item["remodexRealtimeDelegation"]?.boolValue == true, let turnID {
                                let session = activeSession ?? self.realtimeSessionByDelegatedItem[threadID]?[[turnID, itemID]]
                                self.associateRealtimeDelegation(threadID: threadID, turnID: turnID, sessionID: session, itemID: itemID, isMarkedItem: true)
                            }
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
