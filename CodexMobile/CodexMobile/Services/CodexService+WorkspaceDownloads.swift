// FILE: CodexService+WorkspaceDownloads.swift
// Purpose: Downloads original local files over the encrypted bridge and keeps offline copies.
// Layer: Service extension
// Exports: WorkspaceDownloadedFile, WorkspaceFileDownloadProgress, CodexService download APIs
// Depends on: Foundation, CodexService, JSONValue

import Foundation

nonisolated struct WorkspaceDownloadedFile: Sendable {
    let url: URL
    let fileName: String
    let byteLength: Int
    let mtimeMs: Double
    let sourcePath: String
    let isLocalCache: Bool
}

nonisolated struct WorkspaceFileDownloadProgress: Sendable {
    let bytesReceived: Int
    let totalBytes: Int

    var fractionCompleted: Double {
        totalBytes == 0 ? 1 : Double(bytesReceived) / Double(totalBytes)
    }
}

nonisolated private struct WorkspaceDownloadIdentity: Codable, Hashable, Sendable {
    let deviceID: String
    let publicKey: String
}

nonisolated private struct WorkspaceDownloadKey: Codable, Hashable, Sendable {
    let identity: WorkspaceDownloadIdentity
    let threadID: String
    let requestedPath: String
}

nonisolated private struct WorkspaceDownloadMetadata: Codable, Sendable {
    let sourcePath: String
    let fileName: String
    let byteLength: Int
    let mtimeMs: Double
    let chunkSize: Int
}

nonisolated private enum WorkspaceDownloadNetworkError: LocalizedError {
    case timedOut

    static let timeoutMessage = "The file download timed out. Retry when the computer is online."

    var errorDescription: String? { Self.timeoutMessage }

    static func allowsCachedCopy(_ error: Error) -> Bool {
        if error is WorkspaceDownloadNetworkError { return true }
        if case CodexServiceError.disconnected = error { return true }
        return false
    }
}

extension CodexService {
    private static let workspaceDownloadRequestTimeout: UInt64 = 30_000_000_000

    // A successful local copy remains usable while the selected computer is offline.
    func cachedWorkspaceFile(threadId: String, path: String) async -> WorkspaceDownloadedFile? {
        guard let identity = workspaceDownloadIdentity else { return nil }
        let key = WorkspaceDownloadKey(identity: identity, threadID: threadId, requestedPath: path)
        return try? await WorkspaceDownloadStore.shared.cachedFile(for: key)
    }

    func downloadWorkspaceFile(
        threadId: String,
        turnId: String? = nil,
        path: String,
        progress: (@MainActor (WorkspaceFileDownloadProgress) -> Void)? = nil
    ) async throws -> WorkspaceDownloadedFile {
        try Task.checkCancellation()
        guard !threadId.isEmpty, !path.isEmpty else {
            throw CodexServiceError.invalidInput("A thread and file path are required to download a file.")
        }
        guard let identity = workspaceDownloadIdentity else {
            throw CodexServiceError.invalidInput("Pair this computer before downloading files.")
        }
        let key = WorkspaceDownloadKey(identity: identity, threadID: threadId, requestedPath: path)
        let cached = try await WorkspaceDownloadStore.shared.cachedFile(for: key)
        if !isConnected, workspaceDownloadIdentity == identity, let cached {
            try Task.checkCancellation()
            return cached
        }

        var params: [String: JSONValue] = ["threadId": .string(threadId), "path": .string(path)]
        if let turnId, !turnId.isEmpty { params["turnId"] = .string(turnId) }
        let response: RPCMessage
        do {
            try requireWorkspaceDownloadIdentity(identity)
            response = try await requestWorkspaceDownload(method: "workspace/startFileDownload", params: params)
        } catch {
            try Task.checkCancellation()
            if workspaceDownloadIdentity == identity, WorkspaceDownloadNetworkError.allowsCachedCopy(error), let cached {
                return cached
            }
            throw error
        }
        guard let result = response.result?.objectValue,
              let downloadID = result["downloadId"]?.stringValue, !downloadID.isEmpty else {
            throw CodexServiceError.invalidResponse("File download response was missing a download identifier.")
        }
        // Unstructured cleanup does not inherit cancellation from the view's download task.
        defer { closeWorkspaceDownload(downloadID, identity: identity) }
        try requireWorkspaceDownloadIdentity(identity)
        guard let sourcePath = result["path"]?.stringValue, !sourcePath.isEmpty,
              let fileName = result["fileName"]?.stringValue, !fileName.isEmpty,
              fileName != ".", fileName != "..",
              !fileName.contains("/"), !fileName.contains("\0"),
              let byteLength = result["byteLength"]?.intValue,
              (0...100 * 1024 * 1024).contains(byteLength),
              let mtimeMs = result["mtimeMs"]?.doubleValue, mtimeMs.isFinite,
              let chunkSize = result["chunkSize"]?.intValue,
              (1...256 * 1024).contains(chunkSize) else {
            throw CodexServiceError.invalidResponse("The computer returned invalid file download metadata.")
        }
        let metadata = WorkspaceDownloadMetadata(
            sourcePath: sourcePath, fileName: fileName, byteLength: byteLength,
            mtimeMs: mtimeMs, chunkSize: chunkSize
        )
        if let cached = try await WorkspaceDownloadStore.shared.cachedFile(for: key, matching: metadata) {
            try Task.checkCancellation()
            try requireWorkspaceDownloadIdentity(identity)
            progress?(WorkspaceFileDownloadProgress(bytesReceived: byteLength, totalBytes: byteLength))
            return cached
        }

        let localID = try await WorkspaceDownloadStore.shared.begin(metadata: metadata)
        do {
            var offset = 0
            progress?(WorkspaceFileDownloadProgress(bytesReceived: 0, totalBytes: byteLength))
            while true {
                try Task.checkCancellation()
                try requireWorkspaceDownloadIdentity(identity)
                let response = try await requestWorkspaceDownload(
                    method: "workspace/readFileChunk",
                    params: ["downloadId": .string(downloadID), "offset": .integer(offset)]
                )
                try Task.checkCancellation()
                try requireWorkspaceDownloadIdentity(identity)
                guard let chunk = response.result?.objectValue,
                      chunk["offset"]?.intValue == offset,
                      let bytesRead = chunk["bytesRead"]?.intValue,
                      let base64 = chunk["dataBase64"]?.stringValue,
                      let eof = chunk["eof"]?.boolValue else {
                    throw CodexServiceError.invalidResponse("The computer returned an invalid file chunk.")
                }
                offset = try await WorkspaceDownloadStore.shared.append(
                    localID, offset: offset, bytesRead: bytesRead, base64: base64, eof: eof
                )
                progress?(WorkspaceFileDownloadProgress(bytesReceived: offset, totalBytes: byteLength))
                if eof { break }
            }
            try Task.checkCancellation()
            try requireWorkspaceDownloadIdentity(identity)
            return try await WorkspaceDownloadStore.shared.finish(localID, key: key)
        } catch {
            await WorkspaceDownloadStore.shared.abort(localID)
            throw error
        }
    }

    private var workspaceDownloadIdentity: WorkspaceDownloadIdentity? {
        if let trustedMac = currentTrustedMacRecord {
            return WorkspaceDownloadIdentity(deviceID: trustedMac.macDeviceId, publicKey: trustedMac.macIdentityPublicKey)
        }
        guard let secureSession,
              normalizedCurrentTrustedMacDeviceId == nil || normalizedCurrentTrustedMacDeviceId == secureSession.macDeviceId else {
            return nil
        }
        return WorkspaceDownloadIdentity(deviceID: secureSession.macDeviceId, publicKey: secureSession.macIdentityPublicKey)
    }

    private func requireWorkspaceDownloadIdentity(_ identity: WorkspaceDownloadIdentity) throws {
        guard isConnected, let secureSession,
              secureSession.macDeviceId == identity.deviceID,
              secureSession.macIdentityPublicKey == identity.publicKey else {
            throw CodexServiceError.disconnected
        }
    }

    private func requestWorkspaceDownload(method: String, params: [String: JSONValue]) async throws -> RPCMessage {
        do {
            return try await sendRequest(
                method: method, params: .object(params),
                timeoutNanoseconds: Self.workspaceDownloadRequestTimeout,
                timeoutMessage: WorkspaceDownloadNetworkError.timeoutMessage
            )
        } catch let error as CodexServiceError {
            if case .invalidInput(let message) = error, message == WorkspaceDownloadNetworkError.timeoutMessage {
                throw WorkspaceDownloadNetworkError.timedOut
            }
            guard case .rpcError(let rpcError) = error else { throw error }
            let code = rpcError.data?.objectValue?["errorCode"]?.stringValue
            if rpcError.code == -32601 || code == "unknown_method"
                || (method == "workspace/startFileDownload" && code == "missing_working_directory"
                    && rpcError.message == "Workspace actions require a bound local working directory.") {
                throw CodexServiceError.invalidInput("Update the Remodex bridge on your computer to download files, then reconnect.")
            }
            throw CodexServiceError.invalidInput(rpcError.message)
        }
    }

    private func closeWorkspaceDownload(_ downloadID: String, identity: WorkspaceDownloadIdentity) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do { try self.requireWorkspaceDownloadIdentity(identity) } catch { return }
            _ = try? await self.sendRequest(
                method: "workspace/closeFileDownload",
                params: .object(["downloadId": .string(downloadID)]),
                timeoutNanoseconds: Self.workspaceDownloadRequestTimeout,
                timeoutMessage: "The computer did not acknowledge closing the file download."
            )
        }
    }
}

// Disk I/O and Base64 decoding stay off MainActor, even when called from a SwiftUI task.
private actor WorkspaceDownloadStore {
    static let shared = WorkspaceDownloadStore()

    nonisolated private struct Record: Codable, Sendable {
        let key: WorkspaceDownloadKey
        let metadata: WorkspaceDownloadMetadata
        let localFileName: String
    }

    nonisolated private struct Partial {
        let url: URL
        let handle: FileHandle
        let metadata: WorkspaceDownloadMetadata
        var offset = 0
        var reachedEOF = false
    }

    private let files = FileManager.default
    private let downloads: URL
    private let support: URL
    private var records: [WorkspaceDownloadKey: Record]?
    private var partials: [UUID: Partial] = [:]

    init(documentsDirectory: URL? = nil, supportDirectory: URL? = nil) {
        let files = FileManager.default
        let documents = documentsDirectory ?? files.urls(for: .documentDirectory, in: .userDomainMask).first!
        let applicationSupport = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        downloads = documents.appendingPathComponent("Downloads", isDirectory: true)
        support = supportDirectory ?? applicationSupport
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.codexmobile.app", isDirectory: true)
            .appendingPathComponent("WorkspaceDownloads", isDirectory: true)
    }

    private func load() throws {
        guard records == nil else { return }
        try files.createDirectory(at: downloads, withIntermediateDirectories: true)
        try files.createDirectory(at: support, withIntermediateDirectories: true)
        let manifest = support.appendingPathComponent("manifest.json")
        if let data = try? Data(contentsOf: manifest),
           let saved = try? JSONDecoder().decode([Record].self, from: data) {
            records = Dictionary(saved.map { ($0.key, $0) }, uniquingKeysWith: { _, latest in latest })
        } else {
            records = [:]
        }
        // Only our incomplete transfers are removed after an app restart.
        for url in try files.contentsOfDirectory(at: support, includingPropertiesForKeys: nil)
            where url.pathExtension == "part" {
            try? files.removeItem(at: url)
        }
    }

    func cachedFile(
        for key: WorkspaceDownloadKey,
        matching metadata: WorkspaceDownloadMetadata? = nil
    ) throws -> WorkspaceDownloadedFile? {
        try load()
        guard let record = records?[key],
              record.localFileName == (record.localFileName as NSString).lastPathComponent,
              record.localFileName != ".", record.localFileName != ".." else { return nil }
        if let metadata,
           metadata.sourcePath != record.metadata.sourcePath
            || metadata.byteLength != record.metadata.byteLength
            || metadata.mtimeMs != record.metadata.mtimeMs { return nil }
        let url = downloads.appendingPathComponent(record.localFileName)
        guard let attributes = try? files.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue == record.metadata.byteLength else { return nil }
        return downloadedFile(record, url: url, isLocalCache: true)
    }

    func begin(metadata: WorkspaceDownloadMetadata) throws -> UUID {
        try Task.checkCancellation()
        try load()
        let id = UUID()
        let url = support.appendingPathComponent("\(id.uuidString).part")
        guard files.createFile(atPath: url.path, contents: nil) else {
            throw CodexServiceError.invalidInput("Unable to create a temporary download file. Check available storage.")
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            partials[id] = Partial(url: url, handle: handle, metadata: metadata)
            return id
        } catch {
            try? files.removeItem(at: url)
            throw error
        }
    }

    func append(_ id: UUID, offset: Int, bytesRead: Int, base64: String, eof: Bool) throws -> Int {
        try Task.checkCancellation()
        guard var partial = partials[id], !partial.reachedEOF,
              offset == partial.offset,
              bytesRead >= 0, bytesRead <= partial.metadata.chunkSize,
              bytesRead <= partial.metadata.byteLength - offset,
              bytesRead > 0 || eof,
              base64.utf8.count <= ((partial.metadata.chunkSize + 2) / 3) * 4,
              let data = Data(base64Encoded: base64), data.count == bytesRead,
              eof == (offset + bytesRead == partial.metadata.byteLength) else {
            throw CodexServiceError.invalidResponse("The downloaded file chunk failed validation. Retry the download.")
        }
        try partial.handle.write(contentsOf: data)
        partial.offset += bytesRead
        partial.reachedEOF = eof
        partials[id] = partial
        return partial.offset
    }

    func finish(_ id: UUID, key: WorkspaceDownloadKey) throws -> WorkspaceDownloadedFile {
        try Task.checkCancellation()
        guard let partial = partials[id], partial.reachedEOF,
              partial.offset == partial.metadata.byteLength else {
            throw CodexServiceError.invalidResponse("The downloaded file is incomplete.")
        }
        try partial.handle.synchronize()
        try partial.handle.close()
        let originalName = partial.metadata.fileName as NSString
        let extensionPart = originalName.pathExtension
        let stem = originalName.deletingPathExtension
        var sequence = 0
        var destination: URL
        while true {
            let name = sequence == 0 ? partial.metadata.fileName
                : "\(stem) (\(sequence))" + (extensionPart.isEmpty ? "" : ".\(extensionPart)")
            destination = downloads.appendingPathComponent(name)
            if files.fileExists(atPath: destination.path) {
                sequence += 1
                continue
            }
            do {
                try files.moveItem(at: partial.url, to: destination)
                break
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                sequence += 1
            }
        }
        partials.removeValue(forKey: id)
        let record = Record(key: key, metadata: partial.metadata, localFileName: destination.lastPathComponent)
        let previous = records?[key]
        records?[key] = record
        do {
            let data = try JSONEncoder().encode(Array(records!.values))
            try data.write(to: support.appendingPathComponent("manifest.json"), options: [.atomic])
        } catch {
            records?[key] = previous
            try? files.removeItem(at: destination)
            throw error
        }
        return downloadedFile(record, url: destination, isLocalCache: false)
    }

    func abort(_ id: UUID) {
        guard let partial = partials.removeValue(forKey: id) else { return }
        try? partial.handle.close()
        try? files.removeItem(at: partial.url)
    }

    private func downloadedFile(_ record: Record, url: URL, isLocalCache: Bool) -> WorkspaceDownloadedFile {
        WorkspaceDownloadedFile(
            url: url, fileName: record.localFileName,
            byteLength: record.metadata.byteLength, mtimeMs: record.metadata.mtimeMs,
            sourcePath: record.metadata.sourcePath, isLocalCache: isLocalCache
        )
    }
}
