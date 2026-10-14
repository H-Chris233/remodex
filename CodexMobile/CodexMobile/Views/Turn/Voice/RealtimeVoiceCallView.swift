import SwiftUI

struct RealtimeVoiceCallView: View {
    @Environment(CodexService.self) private var codex
    let onOpenTask: () -> Void

    var body: some View {
        let call = codex.realtimeVoice
        NavigationStack {
            VStack(spacing: 22) {
                Text(call.title).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Text(call.statusText).font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityAddTraits(.updatesFrequently)
                RealtimeVoiceActivityView(call: call)
                if call.isInterrupted {
                    Button("Resume call") { call.resumeAfterInterruption() }.buttonStyle(.borderedProminent)
                }
                if let error = call.errorMessage {
                    Text(error).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(call.transcripts) { item in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.role == "user" ? "You" : "Codex").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    Text(item.text).textSelection(.enabled)
                                }.frame(maxWidth: .infinity, alignment: .leading).id(item.id)
                            }
                        }
                    }
                    .onChange(of: call.transcripts) { _, items in
                        if let last = items.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
                Button(action: onOpenTask) {
                    Label(call.needsTaskAction ? "Task needs your input" : "Open task", systemImage: call.needsTaskAction ? "exclamationmark.bubble" : "text.bubble")
                }.buttonStyle(.bordered).accessibilityHint("Keeps the call connected while opening its task and approval requests")
                HStack(spacing: 24) {
                    Button { call.setMuted(!call.state.isMuted) } label: {
                        Label(call.state.isMuted ? "Unmute" : "Mute", systemImage: call.state.isMuted ? "mic.slash.fill" : "mic.fill")
                    }.disabled(!call.state.wantsActiveCall)
                    Button { call.toggleSpeaker() } label: {
                        Label("Speaker", systemImage: call.usesSpeaker ? "speaker.wave.2.fill" : "ear")
                    }.disabled(!call.state.wantsActiveCall)
                    Button(role: .destructive) { call.end() } label: { Label("End", systemImage: "phone.down.fill") }
                        .disabled(!call.isLive || call.state.phase == .ending)
                }.buttonStyle(.bordered).labelStyle(.iconOnly).controlSize(.large)
                if !call.isLive, let threadID = call.threadID, let thread = codex.thread(for: threadID) {
                    Button("Call again") { call.start(codex: codex, thread: thread) }.buttonStyle(.borderedProminent)
                }
            }
            .padding(24)
            .navigationTitle("Voice call")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Minimize", systemImage: "chevron.down") { call.isPresented = false }
                }
            }
        }
    }
}

// Keep frequent meter updates out of the transcript and call controls' observation scope.
private struct RealtimeVoiceActivityView: View {
    let call: CodexRealtimeVoiceCoordinator
    @Environment(\.scenePhase) private var scenePhase

    private var isActive: Bool { scenePhase == .active && call.state.phase == .active && !call.isInterrupted }

    var body: some View {
        HStack(spacing: 12) {
            lane(title: call.state.isMuted ? "Muted" : "You",
                 symbol: call.state.isMuted ? "mic.slash.fill" : "mic.fill",
                 levels: call.microphoneMeter.levels,
                 tint: call.state.isMuted ? .secondary : .accentColor,
                 isAnimating: isActive && !call.state.isMuted)
            lane(title: "Codex", symbol: "speaker.wave.2.fill", levels: call.assistantMeter.levels,
                 tint: .teal, isAnimating: isActive)
        }
        .task(id: scenePhase == .active ? call.state.generation : nil) {
            if scenePhase == .active { await call.monitorAudioLevels() }
        }
    }

    private func lane(title: String, symbol: String, levels: [CGFloat], tint: Color, isAnimating: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold)).foregroundStyle(tint)
            ScrollingWaveformLane(levels: levels, barWidth: 3, barSpacing: 2, minHeight: 2, maxHeight: 44,
                                  tint: tint, isAnimating: isAnimating, sampleInterval: CodexVoiceAudioMeter.sampleInterval)
                .frame(height: 44)
                .accessibilityHidden(true)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(isAnimating && (levels.last ?? 0) > 0.05 ? "Audio detected" : "Quiet")
    }
}
