// Desktop organization is read-only; disclosure and pin preferences remain phone-local.
import Foundation

struct CodexDesktopProject: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let rootPaths: [String]
    let projectId: String?
}

struct CodexDesktopSidebarSection: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let projectIds: [String]
}

struct CodexDesktopSidebarSnapshot: Codable, Hashable, Sendable {
    let schemaVersion: Int
    let scopeKey: String
    let revision: String
    let projects: [CodexDesktopProject]
    let sections: [CodexDesktopSidebarSection]
    let threadProjectIds: [String: String]
    let excludedThreadIds: [String]

    var isValid: Bool {
        schemaVersion == 1 && !scopeKey.isEmpty && !revision.isEmpty
            && Set(projects.map(\.id)).count == projects.count
            && Set(sections.map(\.id)).count == sections.count
            && projects.allSatisfy { !$0.id.isEmpty && !$0.rootPaths.isEmpty && $0.rootPaths.allSatisfy { !Self.pathKey($0).isEmpty } }
    }

    func project(for thread: CodexThread, threadsByID: [String: CodexThread] = [:]) -> CodexDesktopProject? {
        resolveProject(for: thread, threadsByID: threadsByID, visited: [])
    }

    private func resolveProject(for thread: CodexThread, threadsByID: [String: CodexThread], visited: Set<String>) -> CodexDesktopProject? {
        guard !visited.contains(thread.id) else { return nil }
        if let projectId = thread.projectId {
            return projects.first { $0.projectId == projectId || $0.id == projectId }
        }
        if excludedThreadIds.contains(thread.id) { return nil }
        if let projectId = threadProjectIds[thread.id] {
            return projects.first { $0.id == projectId }
        }
        // Children without their own assignment stay with their parent after a desktop move.
        if let parentID = thread.parentThreadId, let parent = threadsByID[parentID],
           let inherited = resolveProject(for: parent, threadsByID: threadsByID, visited: visited.union([thread.id])) {
            return inherited
        }
        let cwd = Self.pathKey(thread.worktreeOriginPath ?? thread.cwd ?? "")
        guard !cwd.isEmpty else { return nil }
        // Keep membership consistent with the host's exact cwd pagination filter.
        let matches = projects.filter { project in project.rootPaths.contains { Self.pathKey($0) == cwd } }
        return matches.count == 1 ? matches.first : nil
    }

    static func pathKey(_ path: String) -> String {
        var result = path.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
        if result.hasPrefix("//?/UNC/") { result = "//" + result.dropFirst(8) }
        else if result.hasPrefix("//?/") { result = String(result.dropFirst(4)) }
        while result.hasSuffix("/") && result.count > 1 { result.removeLast() }
        let isWindows = result.hasPrefix("//") || (result.count > 1 && result.dropFirst().first == ":")
        return isWindows ? result.lowercased() : result
    }
}

struct CodexDesktopProjectLoadState: Equatable {
    var isLoading = false
    var hasLoadedPage = false
    var nextCursor: String?
    var errorMessage: String?
    var threadIDs: Set<String> = []

    var isComplete: Bool { hasLoadedPage && nextCursor == nil && errorMessage == nil }
    var isConfirmedEmpty: Bool { isComplete && threadIDs.isEmpty }
}

struct CodexDesktopProjectThreadPage: Decodable {
    let scopeKey: String
    let data: [CodexThread]
    let nextCursor: String?
}
