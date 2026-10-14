// Serializes the two microphone owners, including delayed dictation deactivation.
import Foundation

nonisolated enum VoiceAudioSessionOwnership {
    private static let queue = DispatchQueue(label: "com.remodex.voice.audio-session")
    private nonisolated(unsafe) static var owner: UUID?

    enum OwnershipError: LocalizedError {
        case busy
        var errorDescription: String? { "Finish voice recording or the current call before starting another microphone session." }
    }

    static func acquire<T: Sendable>(_ token: UUID, configure: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard owner == nil || owner == token else {
                    continuation.resume(throwing: OwnershipError.busy)
                    return
                }
                owner = token
                do { continuation.resume(returning: try configure()) }
                catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func perform(_ token: UUID, work: @escaping @Sendable () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard owner == token else { continuation.resume(throwing: CancellationError()); return }
                do { try work(); continuation.resume() }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    static func release(_ token: UUID, deactivate: @escaping @Sendable () -> Void) {
        queue.async {
            guard owner == token else { return }
            deactivate()
            owner = nil
        }
    }
}
