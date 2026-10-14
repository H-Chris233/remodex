import SwiftUI

struct RealtimeVoiceCallView: View {
    @Environment(CodexService.self) private var codex
    let onOpenTask: () -> Void

    var body: some View {
        let call = codex.realtimeVoice
        NavigationStack {
            VStack(spacing: 22) {
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 64)).foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(call.title).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Text(call.statusText).font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityAddTraits(.updatesFrequently)
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
