import Foundation

extension TurnViewModel {
    // Use the same send gate as the composer without consuming an unsent draft.
    func continueAfterStreamFailure(
        _ failure: CodexStreamFailure, codex: CodexService,
        threadID: String
    ) {
        guard !isSending, codex.recoverableStreamFailure(for: threadID)?.id == failure.id else { return }
        isSending = true
        Task { @MainActor in
            defer { isSending = false }
            do {
                try await codex.continueAfterStreamFailure(threadId: threadID, failureID: failure.id)
            } catch {
                guard codex.recoverableStreamFailuresByThread[threadID]?.id == failure.id else { return }
                codex.dismissStreamFailure(threadId: threadID, failureID: failure.id)
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }
}
