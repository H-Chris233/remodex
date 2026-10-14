import Foundation

@main
struct RealtimeVoiceChecks {
    static func main() async throws {
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
        assert(call.closureDisposition(reason: "transport_closed", replacingSession: false) == .recover)
        call.recover(at: 110)
        assert(call.closureDisposition(reason: "requested", replacingSession: true) == .ignore)
        call.end()
        let endingGeneration = call.generation
        call.connected()
        assert(!call.rebuild(ifCleaned: true))
        assert(call.closureDisposition(reason: "transport_closed", replacingSession: false) == .ignore)
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
}
