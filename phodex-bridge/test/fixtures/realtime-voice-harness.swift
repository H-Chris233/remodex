import Foundation

@main
struct RealtimeVoiceChecks {
    static func main() async throws {
        checkAudioMeters()
        var call = CodexRealtimeVoiceState()
        call.start()
        let first = call.generation
        assert(call.isLive && !call.shouldTransmit)
        call.connected()
        assert(call.shouldTransmit)
        call.isMuted = true
        call.recover(at: 100)
        assert(!call.shouldTransmit)
        assert(!call.mayRebuild(at: 104.99, hasFailed: false))
        assert(call.mayRebuild(at: 105, hasFailed: false))
        assert(call.mayRebuild(at: 101, hasFailed: true))
        assert(!call.rebuild(ifCleaned: false))
        assert(call.rebuild(ifCleaned: true))
        assert(call.generation != first && !call.mayRebuild(at: 106, hasFailed: true))
        call.connected()
        assert(call.isMuted && !call.shouldTransmit)
        assert(call.closureDisposition(reason: "requested", replacingSession: false) == .end)
        assert(call.closureDisposition(reason: nil, replacingSession: false) == .end)
        assert(call.closureDisposition(reason: "requested", replacingSession: false, internalControlRecovery: true) == .recover)
        assert(call.closureDisposition(reason: nil, replacingSession: false, internalControlRecovery: true) == .recover)
        assert(call.closureDisposition(reason: "transport_closed", replacingSession: false) == .recover)
        call.recover(at: 110)
        assert(call.closureDisposition(reason: "requested", replacingSession: true) == .ignore)
        call.end()
        let endingGeneration = call.generation
        call.connected()
        assert(!call.rebuild(ifCleaned: true))
        assert(call.closureDisposition(reason: "transport_closed", replacingSession: false) == .ignore)
        assert(call.closureDisposition(reason: "requested", replacingSession: false, internalControlRecovery: true) == .ignore)
        assert(!call.wantsActiveCall && call.phase == .ending && call.generation == endingGeneration)
        call.finish(failed: false)
        assert(!call.isLive && call.generation != endingGeneration)
        call.start()
        call.recover(at: 200)
        assert(!call.mayRebuild(at: 230, hasFailed: true))

        let item: [String: JSONValue] = ["type": .string("transcriptSegment"), "id": .string("same-item"),
            "realtimeSessionId": .string("session-a"), "role": .string("user"), "text": .string("Hello")]
        let transcript = CodexVoiceTranscript(item: item)!
        var otherSession = item
        otherSession["realtimeSessionId"] = .string("session-b")
        assert(transcript.messageID != CodexVoiceTranscript(item: otherSession)!.messageID)
        var raw = item
        raw["type"] = .string("bemItemPromoted")
        assert(CodexVoiceTranscript(item: raw) == nil)
        raw = item; raw["role"] = .string("developer")
        assert(CodexVoiceTranscript(item: raw) == nil)
        raw = item; raw["realtimeSessionId"] = nil
        assert(CodexVoiceTranscript(item: raw) == nil)

        let canonical = CodexMessage(id: "realtime:session-a:user-1", threadId: "thread", role: .user, text: "Do it", realtimeSessionId: "session-a")
        let delegation = CodexMessage(threadId: "thread", role: .user, text: "Do it", itemId: "delegation-1", isRealtimeDelegation: true, realtimeSessionId: "session-a")
        assert(CodexVoiceTranscript.projectDelegations([delegation]).count == 1)
        assert(CodexVoiceTranscript.projectDelegations([delegation, canonical]).map(\.id) == [canonical.id])
        assert(CodexVoiceTranscript.projectDelegations([canonical, delegation]).map(\.id) == [canonical.id])
        var unknownSession = delegation
        unknownSession.realtimeSessionId = nil
        assert(CodexVoiceTranscript.projectDelegations([unknownSession, canonical]).count == 2)
        unknownSession.realtimeSessionId = "session-a"
        assert(CodexVoiceTranscript.projectDelegations([unknownSession, canonical]).count == 1)
        var otherCall = delegation
        otherCall.realtimeSessionId = "session-b"
        assert(CodexVoiceTranscript.projectDelegations([otherCall, canonical]).count == 2)
        let keyboard = CodexMessage(threadId: "thread", role: .user, text: "Do it", realtimeSessionId: "session-a")
        assert(CodexVoiceTranscript.projectDelegations([keyboard, canonical]).count == 2)
        var emptyCanonical = canonical
        emptyCanonical.text = ""
        assert(CodexVoiceTranscript.projectDelegations([delegation, emptyCanonical]).count == 2)
        var imageDelegation = delegation
        imageDelegation.attachments = [CodexImageAttachment(thumbnailBase64JPEG: "fixture-image", sourceURL: "/tmp/image.jpg")]
        imageDelegation.fileMentions = ["notes.txt"]
        let retained = CodexVoiceTranscript.projectDelegations([imageDelegation, canonical])
        assert(retained.count == 2 && retained[0].text.isEmpty)
        assert(retained[0].attachments == imageDelegation.attachments && retained[0].fileMentions == ["notes.txt"])
        assert(imageDelegation.text == "Do it")
        let encoded = try JSONEncoder().encode(imageDelegation)
        let decoded = try JSONDecoder().decode(CodexMessage.self, from: encoded)
        assert(decoded == imageDelegation)
        let legacy = Data(#"{"id":"legacy-keyboard","threadId":"thread","role":"user","text":"Do it","createdAt":0}"#.utf8)
        let legacyMessage = try JSONDecoder().decode(CodexMessage.self, from: legacy)
        assert(!legacyMessage.isRealtimeDelegation && legacyMessage.realtimeSessionId == nil)
        assert(CodexVoiceTranscript.projectDelegations([legacyMessage, canonical]).count == 2)
        let oldVoiceCache = Data(#"{"id":"realtime:session-a:legacy-item","threadId":"thread","role":"user","text":"Do it","createdAt":0}"#.utf8)
        let oldVoice = try JSONDecoder().decode(CodexMessage.self, from: oldVoiceCache)
        assert(oldVoice.realtimeSessionId == "session-a")

        var partial = transcript
        partial.text = "Hello"
        var completed = transcript
        completed.text = "Hello world"
        let captured = [partial.messageID: partial]
        assert(CodexVoiceTranscript.historySnapshotStillCurrent(completed, snapshot: captured, current: captured))
        var current = captured
        current[CodexVoiceTranscript(item: otherSession)!.messageID] = CodexVoiceTranscript(item: otherSession)!
        assert(CodexVoiceTranscript.historySnapshotStillCurrent(completed, snapshot: captured, current: current))
        current[partial.messageID] = completed
        assert(!CodexVoiceTranscript.historySnapshotStillCurrent(partial, snapshot: captured, current: current))
        assert(CodexVoiceTranscript.historySnapshotStillCurrent(CodexVoiceTranscript(item: otherSession)!, snapshot: [:], current: [:]))

        assert(RealtimeApprovalGuard.requiresHumanDecision(source: "desktopIpc"))
        assert(RealtimeApprovalGuard.requiresHumanDecision(source: "sharedRuntime"))
        assert(!RealtimeApprovalGuard.requiresHumanDecision(source: nil))
        assert(!RealtimeApprovalGuard.requiresHumanDecision(source: "phone"))

        let oldOwner = UUID(), newOwner = UUID()
        try await VoiceAudioSessionOwnership.acquire(oldOwner) {}
        do {
            try await VoiceAudioSessionOwnership.acquire(newOwner) {}
            fatalError("Two microphone owners were admitted")
        } catch VoiceAudioSessionOwnership.OwnershipError.busy {}
        VoiceAudioSessionOwnership.release(oldOwner) {}
        try await VoiceAudioSessionOwnership.acquire(newOwner) {}
        // A delayed old teardown must not release the new owner.
        VoiceAudioSessionOwnership.release(oldOwner) { fatalError("Stale teardown deactivated a new call") }
        try await VoiceAudioSessionOwnership.perform(newOwner) {}
        VoiceAudioSessionOwnership.release(newOwner) {}
        do {
            try await VoiceAudioSessionOwnership.perform(oldOwner) { fatalError("Expired route callback changed audio") }
            fatalError("Released ownership was reacquired by a callback")
        } catch is CancellationError {}
        print("realtime voice checks passed")
    }

    static func checkAudioMeters() {
        func sample(id: String = "mic", type: String = "media-source", timestamp: Double,
                    level: Double? = nil, energy: Double? = nil, duration: Double? = nil) -> CodexVoiceAudioSample {
            var values: [String: NSObject] = ["kind": "audio" as NSString]
            if let level { values["audioLevel"] = NSNumber(value: level) }
            if let energy { values["totalAudioEnergy"] = NSNumber(value: energy) }
            if let duration { values["totalSamplesDuration"] = NSNumber(value: duration) }
            return CodexVoiceAudioSample(id: id, type: type, timestamp: timestamp, values: values)!
        }
        func isLevel(_ meter: CodexVoiceAudioMeter, _ expected: Double) -> Bool {
            abs(Double(meter.levels.last ?? -1) - expected) < 0.000001
        }
        assert(sample(timestamp: 1).source == .microphone)
        assert(sample(type: "inbound-rtp", timestamp: 1).source == .assistant)
        for type in ["outbound-rtp", "remote-inbound-rtp", "codec"] {
            assert(CodexVoiceAudioSample(id: "ignored", type: type, timestamp: 1,
                values: ["kind": "audio" as NSString, "audioLevel": NSNumber(value: 1)]) == nil)
        }
        assert(CodexVoiceAudioSample(id: "video", type: "inbound-rtp", timestamp: 1,
            values: ["kind": "video" as NSString]) == nil)
        assert(CodexVoiceAudioSample(id: "invalid", type: "media-source", timestamp: .nan,
            values: ["kind": "audio" as NSString]) == nil)

        var microphone = CodexVoiceAudioMeter(), assistant = CodexVoiceAudioMeter()
        microphone.append(sample(timestamp: 1, level: 0.01))
        assistant.append(sample(id: "speaker", type: "inbound-rtp", timestamp: 1, level: 0.1))
        assert(isLevel(microphone, 0.2) && isLevel(assistant, 0.6))
        microphone.append(sample(timestamp: 2, level: 1), enabled: false)
        assert(isLevel(microphone, 0) && isLevel(assistant, 0.6))
        microphone.reset()
        assert(microphone.levels.isEmpty && !assistant.levels.isEmpty)

        var measured = CodexVoiceAudioMeter()
        measured.append(sample(timestamp: 1, energy: 0.2, duration: 5))
        assert(isLevel(measured, 0))
        measured.append(sample(timestamp: 2, energy: 0.201, duration: 5.1))
        assert(isLevel(measured, 0.6))
        // Stale levels cannot keep a remote waveform speaking after packets stop.
        measured.append(sample(timestamp: 3, level: 1, energy: 0.201, duration: 5.1))
        assert(isLevel(measured, 0))
        measured.append(sample(timestamp: 4, level: 1, energy: 0, duration: 0))
        assert(isLevel(measured, 0))
        measured.append(sample(id: "new-track", timestamp: 5, level: 0.1, energy: 3, duration: 20))
        assert(isLevel(measured, 0.6))
        measured.append(sample(id: "new-track", timestamp: 5, level: 1))
        assert(isLevel(measured, 0))
        measured.append(nil)
        assert(isLevel(measured, 0))
        for invalid in [Double.nan, Double.infinity, -1] {
            measured.reset()
            measured.append(sample(timestamp: 1, level: invalid))
            assert(isLevel(measured, 0))
        }
        measured.reset()
        for time in 0..<(CodexVoiceAudioMeter.capacity + 10) {
            measured.append(sample(timestamp: Double(time), level: 2))
        }
        assert(measured.levels.count == CodexVoiceAudioMeter.capacity)
        assert(measured.levels.allSatisfy { $0 == 1 })
    }
}
