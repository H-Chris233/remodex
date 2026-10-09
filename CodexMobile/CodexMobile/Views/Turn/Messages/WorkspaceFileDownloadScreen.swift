// FILE: WorkspaceFileDownloadScreen.swift
// Purpose: Saves original desktop files locally and opens system previews on demand.
// Layer: Turn UI
// Depends on: CodexService workspace downloads, QuickLook, SwiftUI

import QuickLook
import SwiftUI

struct WorkspaceFileDownloadScreen: View {
    let request: WorkspaceFilePreviewRequest
    let onDismiss: () -> Void

    @Environment(CodexService.self) private var codex
    @State private var progress: WorkspaceFileDownloadProgress?
    @State private var downloadedFile: WorkspaceDownloadedFile?
    @State private var errorMessage: String?
    @State private var attempt = 0
    @State private var previewURL: URL?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Spacer(minLength: 0)
                RemodexIcon.image(systemName: downloadedFile == nil ? "doc" : "doc.badge.checkmark")
                    .font(AppFont.system(size: 42, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(downloadedFile?.fileName ?? WorkspaceFileLinkResolver.displayFileName(for: request.path))
                    .font(AppFont.headline())
                    .multilineTextAlignment(.center)

                if let file = downloadedFile {
                    savedFileActions(file)
                } else if let errorMessage {
                    Text(errorMessage)
                        .font(AppFont.subheadline())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        self.errorMessage = nil
                        progress = nil
                        attempt += 1
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    if let progress, progress.totalBytes > 0 {
                        ProgressView(value: Double(progress.bytesReceived), total: Double(progress.totalBytes))
                        Text("\(Int(progress.fractionCompleted * 100))% · \(formattedSize(progress.bytesReceived)) of \(formattedSize(progress.totalBytes))")
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                    Text("Downloading file")
                        .font(AppFont.subheadline())
                    Button("Cancel", action: onDismiss)
                }
                Spacer(minLength: 0)
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemBackground))
            .navigationTitle("File")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
            }
        }
        .quickLookPreview($previewURL)
        .task(id: attempt) { await downloadFile() }
    }

    @ViewBuilder
    private func savedFileActions(_ file: WorkspaceDownloadedFile) -> some View {
        Text("Saved in Files · On My iPhone / Remodex / Downloads")
            .font(AppFont.subheadline())
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        Text(formattedSize(file.byteLength))
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
        if canPreview(file) {
            Button("Open preview") { previewURL = file.url }
                .buttonStyle(.borderedProminent)
        } else {
            Text("Preview isn't available for this format. You can open it in another app.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        ShareLink(item: file.url) {
            Label("Share file", systemImage: "square.and.arrow.up")
        }
        .buttonStyle(.bordered)
    }

    private func canPreview(_ file: WorkspaceDownloadedFile) -> Bool {
        QLPreviewController.canPreview(file.url as NSURL)
    }

    private func formattedSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    @MainActor
    private func downloadFile() async {
        guard downloadedFile == nil else { return }
        guard let threadId = request.threadId else {
            errorMessage = "Open the file from its chat to download it."
            return
        }
        do {
            let file = try await codex.downloadWorkspaceFile(
                threadId: threadId,
                turnId: request.turnId,
                path: request.path,
                progress: { progress = $0 }
            )
            try Task.checkCancellation()
            downloadedFile = file
            if canPreview(file) {
                previewURL = file.url
            }
        } catch is CancellationError {
            // Dismissing the screen cancels the transfer and keeps completed files intact.
        } catch {
            if case CodexServiceError.disconnected = error {
                errorMessage = "This computer is offline. Connect it and retry the download."
            } else if case CodexServiceError.rpcError(let rpcError) = error {
                errorMessage = rpcError.message
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// Shared by the existing image and code viewers; saving always fetches original bytes.
struct WorkspaceFileDownloadButton: View {
    @Environment(\.workspaceFileDownloadRequest) private var request
    @State private var isPresented = false

    var body: some View {
        if let request, request.threadId != nil {
            Button {
                isPresented = true
            } label: {
                RemodexIcon.image(systemName: "arrow.down.to.line")
            }
            .accessibilityLabel("Save original file")
            .fullScreenCover(isPresented: $isPresented) {
                WorkspaceFileDownloadScreen(request: request, onDismiss: { isPresented = false })
            }
        }
    }
}
