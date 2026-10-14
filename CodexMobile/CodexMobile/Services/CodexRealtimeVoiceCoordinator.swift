import AVFoundation
import Foundation
import Observation
import Security
import UIKit
@preconcurrency import WebRTC

@MainActor
@Observable
final class CodexRealtimeVoiceCoordinator: NSObject {
    private(set) var state = CodexRealtimeVoiceState()
    private(set) var threadID: String?
    private(set) var title = "Voice call"
    private(set) var errorMessage: String?
    private(set) var isSupported = false
    private(set) var usesSpeaker = true
    private(set) var isInterrupted = false
    var isPresented = false
    private(set) var transcripts: [CodexVoiceTranscript] = []
    private(set) var microphoneMeter = CodexVoiceAudioMeter()
    private(set) var assistantMeter = CodexVoiceAudioMeter()
    @ObservationIgnored private weak var codex: CodexService?
    @ObservationIgnored private var peer: RTCPeerConnection?
    @ObservationIgnored private var events: RTCDataChannel?
    @ObservationIgnored private var microphone: RTCAudioTrack?
    @ObservationIgnored private var delegateProxy: VoicePeerDelegate?
    @ObservationIgnored private var sessionID: String?
    @ObservationIgnored private var leaseToken: String?
    @ObservationIgnored private var audioOwner: UUID?
    @ObservationIgnored private var peerConnected = false
    @ObservationIgnored private var peerFailed = false
    @ObservationIgnored private var sessionClosed = false
    @ObservationIgnored private var hasRemoteDescription = false
    @ObservationIgnored private var isFinishing = false
    @ObservationIgnored private var isReplacingSession = false
    @ObservationIgnored private var controlRecoveryHint = false
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var operationExpiryTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var endTask: Task<Void, Never>?
    @ObservationIgnored private var operationDeadline: ContinuousClock.Instant?
    @ObservationIgnored private var graceTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private let reconnectModel = ContentViewModel()
    @ObservationIgnored private var hostID: String?
    @ObservationIgnored private var boundRelayURL: String?
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    var isLive: Bool { state.isLive }
    var needsTaskAction: Bool {
        guard let codex, let threadID else { return false }
        return codex.pendingApproval(for: threadID) != nil || codex.messages(for: threadID).contains {
            $0.structuredUserInputRequest != nil || $0.asyncUserInput?.status == .unanswered || $0.asyncUserInput?.status == .uncertain
        }
    }
    var statusText: String {
        if isInterrupted { return "Audio interrupted" }
        switch state.phase {
        case .idle: return "Ready to call"
        case .starting: return "Connecting…"
        case .active: return state.isMuted ? "Microphone muted" : "Connected"
        case .recovering: return "Restoring connection · microphone paused"
        case .ending: return "Ending call…"
        case .failed: return "Call ended"
        }
    }

    @discardableResult
    func probe(codex: CodexService, threadID: String) async -> Bool? {
        self.codex = codex
        guard codex.isConnected, codex.isInitialized else { isSupported = false; return nil }
        guard codex.thread(for: threadID)?.runtimeProvider != .opencode else { isSupported = false; return false }
        do {
            let result = try await codex.sendRequest(method: "remodex/realtime/status", params: .object(["threadId": .string(threadID)]), timeoutNanoseconds: 5_000_000_000).result?.objectValue
            isSupported = result?["supported"]?.boolValue == true && result?["protocolVersion"]?.intValue == 1
            return isSupported
        } catch CodexServiceError.rpcError(let error) where error.code == -32601 {
            isSupported = false
            return false
        } catch {
            isSupported = false
            return nil
        }
    }

    func start(codex: CodexService, thread: CodexThread) {
        isPresented = true
        guard !isLive else { return }
        self.codex = codex
        threadID = thread.id
        title = thread.displayTitle
        hostID = codex.normalizedCurrentTrustedMacDeviceId
        boundRelayURL = codex.normalizedRelayURL
        errorMessage = nil
        transcripts = []
        isInterrupted = false
        usesSpeaker = true
        state.start()
        let generation = state.generation
        startTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                guard codex.isConnected, codex.isInitialized else {
                    throw CodexServiceError.invalidInput("Connect to your computer before starting a voice call.")
                }
                let supported = await self.probe(codex: codex, threadID: thread.id)
                try self.checkIntent(generation)
                guard let supported else {
                    throw CodexServiceError.invalidInput("The connection to your computer was interrupted. Reconnect Remodex and try again.")
                }
                guard supported else { throw CodexServiceError.invalidInput("Finish Voice setup on your computer, then reconnect Remodex.") }
                guard await AVAudioApplication.requestRecordPermission() else { throw CodexServiceError.invalidInput("Allow Microphone for Remodex in iPhone Settings to start a voice call.") }
                try self.checkIntent(generation)
                _ = self.armDeadline(message: "Voice connection timed out after 30 seconds. Try calling again.")
                self.beginGrace()
                try await self.acquireAudio()
                try self.checkIntent(generation)
                try await self.openSession(generation: generation)
                try self.checkIntent(generation)
                self.operationDeadline = nil
                self.operationExpiryTask?.cancel()
                self.endGrace()
                self.beginHeartbeat()
            } catch {
                guard self.state.generation == generation, self.state.wantsActiveCall else { return }
                await self.finish(error: error.localizedDescription)
            }
        }
    }

    private func acquireAudio() async throws {
        let token = UUID()
        audioOwner = token
        try await VoiceAudioSessionOwnership.acquire(token) {
            let audio = RTCAudioSession.sharedInstance()
            audio.useManualAudio = true
            audio.isAudioEnabled = false
            audio.lockForConfiguration()
            defer { audio.unlockForConfiguration() }
            let configuration = RTCAudioSessionConfiguration.webRTC()
            configuration.category = AVAudioSession.Category.playAndRecord.rawValue
            configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
            configuration.categoryOptions = [.allowBluetoothHFP, .defaultToSpeaker]
            RTCAudioSessionConfiguration.setWebRTC(configuration)
            try audio.setConfiguration(configuration, active: true)
        }
    }
    private func checkIntent(_ generation: Int) throws {
        guard state.wantsActiveCall, state.generation == generation, !Task.isCancelled,
              operationDeadline.map({ ContinuousClock.now < $0 }) ?? true else { throw CancellationError() }
    }
    private func credentials() throws -> JSONValue {
        guard let threadID, let sessionID, let leaseToken else { throw CancellationError() }
        return .object(["threadId": .string(threadID), "realtimeSessionId": .string(sessionID), "leaseToken": .string(leaseToken)])
    }

    private func openSession(generation: Int) async throws {
        guard let codex, let threadID else { throw CancellationError() }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CodexServiceError.invalidInput("Unable to create secure voice session credentials.") }
        sessionID = UUID().uuidString
        leaseToken = bytes.map { String(format: "%02x", $0) }.joined()
        peerConnected = false
        peerFailed = false
        sessionClosed = false
        controlRecoveryHint = false
        hasRemoteDescription = false
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let proxy = VoicePeerDelegate(owner: self, generation: generation)
        delegateProxy = proxy
        RTCAudioSession.sharedInstance().add(proxy)
        guard let connection = Self.factory.peerConnection(with: configuration, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: proxy) else { throw CodexServiceError.invalidInput("Unable to create the voice connection.") }
        peer = connection
        let track = Self.factory.audioTrack(withTrackId: "remodex-microphone")
        track.isEnabled = false
        microphone = track
        guard connection.add(track, streamIds: ["remodex-voice"]) != nil,
              let channel = connection.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration()) else { throw CodexServiceError.invalidInput("Unable to prepare the voice media channel.") }
        events = channel
        channel.delegate = proxy
        let offer = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            connection.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, error in
                if let error { continuation.resume(throwing: error) }
                else if let sdp { continuation.resume(returning: sdp) }
                else { continuation.resume(throwing: CodexServiceError.invalidResponse("Voice offer was empty")) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        // The app-server accepts one SDP offer, not a separate trickle-ICE API.
        let gatheringDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while connection.iceGatheringState != .complete && ContinuousClock.now < gatheringDeadline {
            try checkIntent(generation)
            try await Task.sleep(for: .milliseconds(100))
        }
        try checkIntent(generation)
        guard let sdp = connection.localDescription?.sdp else { throw CodexServiceError.invalidResponse("Voice SDP was empty") }
        var parameters = try credentials().objectValue ?? [:]
        parameters["version"] = .string("v3")
        parameters["outputModality"] = .string("audio")
        parameters["transport"] = .object(["type": .string("webrtc"), "sdp": .string(sdp)])
        parameters["clientManagedHandoffs"] = .bool(false)
        _ = try await codex.sendRequest(method: "remodex/realtime/start", params: .object(parameters), timeoutNanoseconds: 15_000_000_000)
        try checkIntent(generation)
        RTCAudioSession.sharedInstance().isAudioEnabled = true
        let readyDeadline = operationDeadline ?? ContinuousClock.now.advanced(by: .seconds(15))
        while !mediaIsReady && ContinuousClock.now < readyDeadline {
            try checkIntent(generation)
            if peerFailed { throw CodexServiceError.invalidInput("The voice media connection failed.") }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard mediaIsReady else { throw CodexServiceError.invalidInput("Voice connection timed out.") }
        state.connected()
        applyMicrophoneState()
        codex.startWebSocketKeepAliveLoop()
    }
    private var mediaIsReady: Bool { peerConnected && hasRemoteDescription && !sessionClosed && events?.readyState == .open }

    func handleNotification(method: String, params: [String: JSONValue]) {
        guard params["threadId"]?.stringValue == threadID,
              params["remodexRealtimeSessionId"]?.stringValue == sessionID else { return }
        let generation = state.generation
        switch method {
        case "remodex/realtime/recovering":
            guard state.wantsActiveCall, params["remodexRealtimeRecovery"]?.stringValue == "controlLost" else { return }
            controlRecoveryHint = true
            beginRecovery()
        case "thread/realtime/sdp":
            guard state.wantsActiveCall, !hasRemoteDescription, let sdp = params["sdp"]?.stringValue, let peer else { return }
            peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
                Task { @MainActor in
                    guard let self, self.state.generation == generation else { return }
                    if let error { await self.finish(error: error.localizedDescription) }
                    else { self.hasRemoteDescription = true }
                }
            }
        case "thread/realtime/error":
            guard state.wantsActiveCall else { return }
            Task {
                guard state.generation == generation, state.wantsActiveCall else { return }
                await finish(error: params["message"]?.stringValue ?? "Voice call failed.")
            }
        case "thread/realtime/closed":
            sessionClosed = true
            controlRecoveryHint = params["remodexRealtimeRecovery"]?.stringValue == "controlLost"
            handleClosure(reason: params["reason"]?.stringValue, internalControlRecovery: controlRecoveryHint)
        default: break
        }
    }
    func receiveTranscript(_ transcript: CodexVoiceTranscript) {
        guard transcript.sessionID == sessionID else { return }
        if let index = transcripts.firstIndex(where: { $0.id == transcript.id }) { transcripts[index] = transcript }
        else { transcripts.append(transcript) }
    }
    // The call sheet owns this task, so minimizing it or backgrounding stops visual metering only.
    func monitorAudioLevels() async {
        resetAudioMeters()
        while state.wantsActiveCall && !Task.isCancelled {
            if state.phase == .active, !isInterrupted, let peer {
                let generation = state.generation
                let samples = await withCheckedContinuation { (continuation: CheckedContinuation<[CodexVoiceAudioSample], Never>) in
                    peer.statistics { report in
                        let samples = report.statistics.values.compactMap { entry in
                            CodexVoiceAudioSample(id: entry.id, type: entry.type,
                                timestamp: entry.timestamp_us, values: entry.values)
                        }
                        continuation.resume(returning: samples)
                    }
                }
                guard !Task.isCancelled else { return }
                if self.peer === peer, state.generation == generation,
                   state.phase == .active, !isInterrupted {
                    microphoneMeter.append(samples.first { $0.source == .microphone }, enabled: state.shouldTransmit)
                    assistantMeter.append(samples.first { $0.source == .assistant })
                }
            } else {
                resetAudioMeters()
            }
            do { try await Task.sleep(for: .seconds(CodexVoiceAudioMeter.sampleInterval)) }
            catch { return }
        }
    }

    private func resetAudioMeters() {
        if !microphoneMeter.levels.isEmpty { microphoneMeter.reset() }
        if !assistantMeter.levels.isEmpty { assistantMeter.reset() }
    }

    func setMuted(_ muted: Bool) { state.isMuted = muted; applyMicrophoneState() }
    private func applyMicrophoneState() {
        microphone?.isEnabled = state.shouldTransmit && !isInterrupted
        if !state.shouldTransmit || isInterrupted { microphoneMeter.reset() }
        if state.phase != .active || isInterrupted { assistantMeter.reset() }
    }
    func toggleSpeaker() {
        guard let audioOwner else { return }
        usesSpeaker.toggle()
        let speaker = usesSpeaker
        let generation = state.generation
        Task {
            guard state.generation == generation, state.wantsActiveCall else { return }
            do {
                try await VoiceAudioSessionOwnership.perform(audioOwner) {
                    let audio = RTCAudioSession.sharedInstance()
                    audio.lockForConfiguration()
                    defer { audio.unlockForConfiguration() }
                    let configuration = RTCAudioSessionConfiguration.webRTC()
                    configuration.categoryOptions = speaker ? [.allowBluetoothHFP, .defaultToSpeaker] : [.allowBluetoothHFP]
                    RTCAudioSessionConfiguration.setWebRTC(configuration)
                    try audio.setConfiguration(configuration)
                    try audio.overrideOutputAudioPort(speaker ? .speaker : .none)
                }
            } catch {
                guard state.generation == generation else { return }
                errorMessage = error.localizedDescription
            }
        }
    }
    func resumeAfterInterruption() {
        guard isInterrupted, let codex, let threadID, let thread = codex.thread(for: threadID) else { return }
        Task { @MainActor in
            await finish(error: nil)
            start(codex: codex, thread: thread)
        }
    }
    private func beginHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { @MainActor [weak self] in
            while let self, self.state.wantsActiveCall, !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(CodexRealtimeVoiceState.heartbeatSeconds))
                    guard self.state.phase == .active, let codex = self.codex else { continue }
                    _ = try await codex.sendRequest(method: "remodex/realtime/heartbeat", params: self.credentials(), timeoutNanoseconds: 3_000_000_000)
                } catch {
                    guard !Task.isCancelled else { return }
                    if self.isTransientTransportError(error) { self.beginRecovery() }
                    else { await self.finish(error: error.localizedDescription) }
                }
            }
        }
    }
    func connectionLost(allowRecovery: Bool) {
        guard isLive else { return }
        isSupported = false
        if allowRecovery { beginRecovery() } else { end(graceful: false) }
    }
    private func armDeadline(message: String) -> ContinuousClock.Instant {
        let deadline = ContinuousClock.now.advanced(by: .seconds(CodexRealtimeVoiceState.recoverySeconds))
        operationDeadline = deadline
        operationExpiryTask?.cancel()
        operationExpiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(CodexRealtimeVoiceState.recoverySeconds))
            guard let self, !Task.isCancelled, self.operationDeadline == deadline, self.state.wantsActiveCall else { return }
            self.startTask?.cancel()
            self.recoveryTask?.cancel()
            await self.finish(error: message)
        }
        return deadline
    }
    private func beginRecovery() {
        guard state.wantsActiveCall, state.phase != .starting, recoveryTask == nil else { return }
        state.recover(at: ProcessInfo.processInfo.systemUptime)
        applyMicrophoneState()
        let deadline = armDeadline(message: "The call could not reconnect within 30 seconds. Start a new call when the connection is stable.")
        beginGrace()
        recoveryTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.recoveryTask = nil
                if self.operationDeadline == deadline {
                    self.operationDeadline = nil
                    self.operationExpiryTask?.cancel()
                    if self.state.phase != .ending { self.endGrace() }
                }
                if self.state.wantsActiveCall, self.state.phase == .active, !self.mediaIsReady { self.beginRecovery() }
            }
            var healthySince: ContinuousClock.Instant?
            while self.state.wantsActiveCall, ContinuousClock.now < deadline, !Task.isCancelled {
                do {
                    let generation = self.state.generation
                    try self.checkIntent(generation)
                    guard let codex = self.codex, codex.normalizedCurrentTrustedMacDeviceId == self.hostID,
                          codex.normalizedRelayURL == self.boundRelayURL else { throw CodexServiceError.invalidInput("The paired device changed. Start a new call.") }
                    if !codex.isConnected || !codex.isInitialized {
                        healthySince = nil
                        if !codex.isConnecting {
                            let url = await self.reconnectModel.preferredReconnectURL(codex: codex, targetMacDeviceId: self.hostID)
                            try self.checkIntent(generation)
                            if let url {
                                try await codex.connect(serverURL: url, token: "", role: "iphone", performInitialSync: false)
                                try self.checkIntent(generation)
                            }
                        }
                    } else if self.mediaIsReady {
                        _ = try await codex.sendRequest(method: "remodex/realtime/heartbeat", params: self.credentials(), timeoutNanoseconds: 3_000_000_000)
                        try self.checkIntent(generation)
                        if healthySince == nil { healthySince = .now }
                        if let healthySince, healthySince.duration(to: .now) >= .seconds(2) {
                            self.state.connected()
                            self.applyMicrophoneState()
                            self.beginHeartbeat()
                            codex.schedulePostConnectSyncPass(preferredThreadId: self.threadID)
                            return
                        }
                    } else if self.state.mayRebuild(at: ProcessInfo.processInfo.systemUptime, hasFailed: self.peerFailed || self.sessionClosed) {
                        self.isReplacingSession = true
                        self.closePeer()
                        try await self.waitForCleanedSession(generation: generation)
                        try self.checkIntent(generation)
                        guard self.state.rebuild(ifCleaned: true) else { throw CancellationError() }
                        self.isReplacingSession = false
                        try await self.openSession(generation: self.state.generation)
                        try self.checkIntent(self.state.generation)
                        self.beginHeartbeat()
                        codex.schedulePostConnectSyncPass(preferredThreadId: self.threadID)
                        return
                    }
                } catch {
                    guard self.state.wantsActiveCall, !Task.isCancelled else { return }
                    healthySince = nil
                    if !self.isTransientTransportError(error) {
                        await self.finish(error: error.localizedDescription)
                        return
                    }
                }
                try? await Task.sleep(for: .milliseconds(500))
            }
            if self.state.wantsActiveCall { await self.finish(error: "The call could not reconnect within 30 seconds. Start a new call when the connection is stable.") }
        }
    }

    private func isTransientTransportError(_ error: Error) -> Bool {
        guard let codex else { return false }
        if codex.isRecoverableTransientConnectionError(error) || codex.shouldTreatSendFailureAsDisconnect(error) || codex.isBenignBackgroundDisconnect(error) { return true }
        if let error = error as? CodexServiceError {
            switch error {
            case .disconnected: return true
            case .rpcError(let rpcError):
                let data = rpcError.data?.objectValue
                if data?["errorCode"]?.stringValue == "closing", data?["remodexRealtimeRecovery"]?.stringValue == "controlLost" {
                    controlRecoveryHint = true
                    return true
                }
                return data?["errorCode"]?.stringValue == "control_unavailable"
            case .invalidInput(let message): return message.contains("timed out")
            default: return false
            }
        }
        return false
    }

    private func waitForCleanedSession(generation: Int) async throws {
        guard let codex, let threadID, let oldSession = sessionID else { throw CancellationError() }
        var requestedStop = false
        while true {
            try checkIntent(generation)
            let result = try await codex.sendRequest(method: "remodex/realtime/status", params: .object(["threadId": .string(threadID)]), timeoutNanoseconds: 3_000_000_000).result?.objectValue
            try checkIntent(generation)
            if result?["state"]?.stringValue == "idle", result?["realtimeSessionId"]?.stringValue == nil { return }
            guard result?["realtimeSessionId"]?.stringValue == oldSession else { throw CodexServiceError.invalidInput("Another voice session replaced this call. Start a new call manually.") }
            if result?["state"]?.stringValue == "poisoned" { throw CodexServiceError.invalidInput("The paired bridge could not close its old voice session. Restart the bridge before calling again.") }
            // An internal control-recovery stop may already be queued or finished.
            if result?["state"]?.stringValue != "closing", !requestedStop {
                do {
                    _ = try await codex.sendRequest(method: "remodex/realtime/stop", params: credentials(), timeoutNanoseconds: 3_000_000_000)
                } catch CodexServiceError.rpcError(let error) where error.data?.objectValue?["errorCode"]?.stringValue == "closing" {}
                try checkIntent(generation)
                requestedStop = true
            }
            try await Task.sleep(for: .milliseconds(200))
        }
    }

    private func handleClosure(reason: String?, internalControlRecovery: Bool = false) {
        switch state.closureDisposition(reason: reason, replacingSession: isReplacingSession, internalControlRecovery: internalControlRecovery) {
        case .ignore: break
        case .recover: beginRecovery()
        case .end: end(graceful: false)
        }
    }
    func end(graceful: Bool = true) {
        guard isLive, state.phase != .ending else { return }
        state.end()
        resetAudioMeters()
        startTask?.cancel()
        recoveryTask?.cancel()
        operationExpiryTask?.cancel()
        heartbeatTask?.cancel()
        beginGrace()
        microphone?.isEnabled = false
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        endTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if graceful, let events = self.events, events.readyState == .open {
                let data = Data(#"{"type":"session.close"}"#.utf8)
                if events.sendData(RTCDataBuffer(data: data, isBinary: false)) {
                    let deadline = ContinuousClock.now.advanced(by: .seconds(CodexRealtimeVoiceState.closeSeconds))
                    while !self.sessionClosed && ContinuousClock.now < deadline && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
                }
            }
            await self.finish(error: nil)
        }
    }
    private func finish(error: String?) async {
        guard !isFinishing, state.phase != .idle && state.phase != .failed else { return }
        isFinishing = true
        defer { isFinishing = false }
        state.end()
        heartbeatTask?.cancel()
        microphone?.isEnabled = false
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        closePeer()
        if let codex, codex.isConnected, let params = try? credentials() {
            _ = try? await codex.sendRequest(method: "remodex/realtime/stop", params: params, timeoutNanoseconds: 5_000_000_000)
        }
        let oldThread = threadID
        sessionID = nil
        leaseToken = nil
        isReplacingSession = false
        controlRecoveryHint = false
        if let owner = audioOwner {
            VoiceAudioSessionOwnership.release(owner) {
                let audio = RTCAudioSession.sharedInstance()
                audio.lockForConfiguration()
                defer { audio.unlockForConfiguration() }
                try? audio.setActive(false)
            }
        }
        audioOwner = nil
        errorMessage = error
        state.finish(failed: error != nil)
        operationDeadline = nil
        operationExpiryTask?.cancel()
        endGrace()
        if let codex {
            if !codex.isAppInForeground { codex.stopWebSocketKeepAliveLoop() }
            if let oldThread { codex.syncRealtimeTimeline(threadID: oldThread, force: true) }
        }
    }
    private func closePeer() {
        resetAudioMeters()
        if let delegateProxy { RTCAudioSession.sharedInstance().remove(delegateProxy) }
        peer?.delegate = nil
        events?.delegate = nil
        events?.close()
        peer?.close()
        peer = nil
        events = nil
        microphone = nil
        delegateProxy = nil
        peerConnected = false
        hasRemoteDescription = false
    }
    private func beginGrace() {
        guard graceTask == .invalid else { return }
        let box = VoiceGraceIdentifier()
        let taskID = UIApplication.shared.beginBackgroundTask(withName: "RemodexVoiceCleanup") { [weak self, box] in
            let expired = box.taskID
            guard expired != .invalid else { return }
            UIApplication.shared.endBackgroundTask(expired)
            Task { @MainActor in
                guard let self, self.graceTask == expired else { return }
                self.graceTask = .invalid
                let wasRecovering = self.state.wantsActiveCall
                self.recoveryTask?.cancel()
                self.endTask?.cancel()
                await self.finish(error: wasRecovering ? "iOS paused call recovery. Return to Remodex to start a new call." : nil)
            }
        }
        box.taskID = taskID
        graceTask = taskID
    }
    private func endGrace() {
        guard graceTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(graceTask)
        graceTask = .invalid
    }
    fileprivate func peerState(_ connected: Bool, failed: Bool, generation: Int) {
        guard state.generation == generation else { return }
        peerConnected = connected
        peerFailed = failed
        if !connected, state.phase == .active { beginRecovery() }
    }
    fileprivate func audioInterrupted(shouldResume: Bool?, generation: Int) {
        guard state.generation == generation, state.wantsActiveCall else { return }
        isInterrupted = !(shouldResume ?? false)
        applyMicrophoneState()
    }
    fileprivate func audioReset(generation: Int) async {
        guard state.generation == generation, state.wantsActiveCall else { return }
        await finish(error: "iOS reset the audio service. Start a new call.")
    }
    fileprivate func eventChannelClosed(generation: Int) {
        guard state.generation == generation, state.wantsActiveCall, state.phase == .active else { return }
        peerFailed = true
        beginRecovery()
    }
    fileprivate func receivedEvent(_ data: Data, generation: Int) {
        guard state.generation == generation,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if object["type"] as? String == "session.closed" {
            sessionClosed = true
            handleClosure(reason: nil, internalControlRecovery: controlRecoveryHint)
        }
    }
}

// Native delegate callbacks enter the app actor through a generation-bound proxy.
nonisolated private final class VoicePeerDelegate: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, RTCAudioSessionDelegate, @unchecked Sendable {
    private weak var owner: CodexRealtimeVoiceCoordinator?
    private let generation: Int
    init(owner: CodexRealtimeVoiceCoordinator, generation: Int) { self.owner = owner; self.generation = generation }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.owner?.peerState(newState == .connected, failed: newState == .failed, generation: self.generation)
        }
    }
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        let closed = dataChannel.readyState == .closed || dataChannel.readyState == .closing
        guard closed else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.owner?.eventChannelClosed(generation: self.generation)
        }
    }
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.owner?.receivedEvent(data, generation: self.generation)
        }
    }
}

extension VoicePeerDelegate {
    nonisolated func audioSessionDidBeginInterruption(_ session: RTCAudioSession) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.owner?.audioInterrupted(shouldResume: nil, generation: self.generation)
        }
    }
    nonisolated func audioSessionDidEndInterruption(_ session: RTCAudioSession, shouldResumeSession: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.owner?.audioInterrupted(shouldResume: shouldResumeSession, generation: self.generation)
        }
    }
    nonisolated func audioSessionMediaServerReset(_ session: RTCAudioSession) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.owner?.audioReset(generation: self.generation)
        }
    }
}

nonisolated private final class VoiceGraceIdentifier: @unchecked Sendable {
    nonisolated(unsafe) var taskID: UIBackgroundTaskIdentifier = .invalid
}
