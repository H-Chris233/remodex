// Reads the connected computer's sidebar catalog without changing Desktop preferences.
import Foundation

extension CodexService {
    func resetDesktopSidebarRequests(clearSnapshot: Bool = false) {
        desktopSidebarEpoch = UUID()
        desktopSidebarReadTask?.cancel()
        desktopSidebarReadTask = nil
        desktopProjectLoadTasks.values.forEach { $0.cancel() }
        desktopProjectLoadTasks.removeAll()
        desktopProjectLoadStates.removeAll()
        desktopSidebarLastReadAt = nil
        supportsDesktopSidebar = true
        if clearSnapshot {
            desktopSidebarSnapshot = nil
            desktopCollapsedProjectIDs = []
            desktopCollapsedSectionIDs = []
        }
    }

    func loadDesktopSidebarCache(for macDeviceId: String?) {
        resetDesktopSidebarRequests(clearSnapshot: true)
        legacySidebarCollapsedProjectIDsStorage = defaults.string(forKey: SidebarProjectExpansionState.collapsedProjectGroupIDsStorageKey) ?? ""
        let base = macScopedDefaultsKey("codex.desktopSidebar", macDeviceId: macDeviceId)
        guard let scope = defaults.string(forKey: base + ".scope"),
              let data = defaults.data(forKey: base + "." + scope),
              let snapshot = try? decoder.decode(CodexDesktopSidebarSnapshot.self, from: data),
              snapshot.isValid, snapshot.scopeKey == scope else { return }
        desktopSidebarSnapshot = snapshot
        loadDesktopSidebarDisclosures()
    }

    func refreshDesktopSidebar(force: Bool = false) async {
        guard isConnected, isInitialized, supportsDesktopSidebar else { return }
        if let task = desktopSidebarReadTask { await task.value; return }
        if !force, let date = desktopSidebarLastReadAt, Date().timeIntervalSince(date) < 8 { return }
        desktopSidebarLastReadAt = Date()
        let epoch = desktopSidebarEpoch
        let deviceId = currentMacScopedPersistenceDeviceId
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response = try await sendRequest(method: "desktop/sidebar/read", params: .object([:]))
                guard desktopSidebarEpoch == epoch, currentMacScopedPersistenceDeviceId == deviceId, !Task.isCancelled else { return }
                guard let value = response.result,
                      let snapshot = decodeModel(CodexDesktopSidebarSnapshot.self, from: value), snapshot.isValid else {
                    throw CodexServiceError.invalidResponse("Desktop sidebar response is invalid.")
                }
                let changedScope = desktopSidebarSnapshot?.scopeKey != snapshot.scopeKey
                let previousSnapshot = desktopSidebarSnapshot
                if let previous = previousSnapshot, previous.scopeKey != snapshot.scopeKey || previous.revision != snapshot.revision {
                    desktopSidebarEpoch = UUID()
                    desktopSidebarReadTask = nil
                    desktopProjectLoadTasks.values.forEach { $0.cancel() }
                    desktopProjectLoadTasks.removeAll()
                    desktopProjectLoadStates.removeAll()
                }
                desktopSidebarSnapshot = snapshot
                if changedScope { loadDesktopSidebarDisclosures() }
                else if let previousSnapshot {
                    var collapsed = desktopCollapsedProjectIDs
                    for old in previousSnapshot.projects where collapsed.contains("desktop:" + old.id) {
                        if let nativeId = old.projectId,
                           let current = snapshot.projects.first(where: { $0.projectId == nativeId }), current.id != old.id {
                            collapsed.remove("desktop:" + old.id)
                            collapsed.insert("desktop:" + current.id)
                        }
                    }
                    if collapsed != desktopCollapsedProjectIDs { setDesktopCollapsedProjects(collapsed) }
                }
                let base = macScopedDefaultsKey("codex.desktopSidebar")
                if let data = try? encoder.encode(snapshot) {
                    defaults.set(data, forKey: base + "." + snapshot.scopeKey)
                    defaults.set(snapshot.scopeKey, forKey: base + ".scope")
                }
            } catch {
                guard desktopSidebarEpoch == epoch else { return }
                let code = desktopSidebarErrorCode(error)
                if ["sidebar_unsupported", "sidebar_format_unsupported", "unknown_method"].contains(code) {
                    supportsDesktopSidebar = false
                    desktopSidebarSnapshot = nil
                    desktopProjectLoadStates.removeAll()
                    defaults.removeObject(forKey: macScopedDefaultsKey("codex.desktopSidebar") + ".scope")
                } else if code == "sidebar_identity_unavailable" || code == "sidebar_scope_changed" {
                    desktopSidebarSnapshot = nil
                    desktopProjectLoadStates.removeAll()
                    defaults.removeObject(forKey: macScopedDefaultsKey("codex.desktopSidebar") + ".scope")
                }
                // Transient catalog failures retain the last snapshot and never reset pairing.
            }
        }
        desktopSidebarReadTask = task
        await task.value
        if desktopSidebarEpoch == epoch { desktopSidebarReadTask = nil }
    }

    @discardableResult
    func loadDesktopProjectThreads(_ projectId: String, refresh: Bool = false, loadMore: Bool = false) async -> Bool {
        guard isConnected, isInitialized, let snapshot = desktopSidebarSnapshot,
              snapshot.projects.contains(where: { $0.id == projectId }) else { return false }
        if let task = desktopProjectLoadTasks[projectId] { return await task.value }
        let previous = desktopProjectLoadStates[projectId] ?? CodexDesktopProjectLoadState()
        if !refresh, previous.hasLoadedPage, (!loadMore || previous.nextCursor == nil), previous.errorMessage == nil { return true }
        let epoch = desktopSidebarEpoch
        let deviceId = currentMacScopedPersistenceDeviceId
        let cursor = refresh ? nil : previous.nextCursor
        var loading = previous
        loading.isLoading = true
        loading.errorMessage = nil
        desktopProjectLoadStates[projectId] = loading
        let task = Task { @MainActor [weak self] () -> Bool in
            guard let self else { return false }
            do {
                var params: RPCObject = ["projectId": .string(projectId), "scopeKey": .string(snapshot.scopeKey)]
                if let cursor { params["cursor"] = .string(cursor) }
                let response = try await sendRequest(method: "desktop/sidebar/projectThreads/list", params: .object(params))
                guard desktopSidebarEpoch == epoch, currentMacScopedPersistenceDeviceId == deviceId,
                      desktopSidebarSnapshot?.scopeKey == snapshot.scopeKey, !Task.isCancelled else { return false }
                guard let value = response.result,
                      let page = decodeModel(CodexDesktopProjectThreadPage.self, from: value), page.scopeKey == snapshot.scopeKey,
                      page.nextCursor == nil || page.nextCursor != cursor else {
                    throw CodexServiceError.invalidResponse("Desktop project page is invalid.")
                }
                var state = cursor == nil ? CodexDesktopProjectLoadState() : previous
                state.hasLoadedPage = true
                state.nextCursor = page.nextCursor
                state.errorMessage = nil
                state.isLoading = false
                state.threadIDs.formUnion(page.data.map(\.id))
                let deleted = locallyDeletedThreadIDs
                let archived = locallyArchivedThreadIDs
                for var thread in page.data where !deleted.contains(thread.id) {
                    if archived.contains(thread.id) { thread.syncState = .archivedLocal }
                    upsertThread(thread, treatAsServerState: true)
                }
                desktopProjectLoadStates[projectId] = state
                return true
            } catch {
                guard desktopSidebarEpoch == epoch, desktopSidebarSnapshot?.scopeKey == snapshot.scopeKey else { return false }
                var state = previous
                state.isLoading = false
                state.errorMessage = userFacingTurnErrorMessageForFooter(from: error) ?? "Could not load chats. Try again."
                if desktopSidebarErrorCode(error) == "sidebar_cursor_expired" {
                    state.nextCursor = nil
                    state.hasLoadedPage = false
                }
                desktopProjectLoadStates[projectId] = state
                if desktopSidebarErrorCode(error) == "sidebar_scope_changed" {
                    resetDesktopSidebarRequests(clearSnapshot: true)
                    await refreshDesktopSidebar(force: true)
                }
                return false
            }
        }
        desktopProjectLoadTasks[projectId] = task
        let success = await task.value
        if desktopSidebarEpoch == epoch { desktopProjectLoadTasks.removeValue(forKey: projectId) }
        return success
    }

    func allDesktopProjectThreadIDs(_ projectId: String) async throws -> [String] {
        let scope = desktopSidebarSnapshot?.scopeKey
        let revision = desktopSidebarSnapshot?.revision
        guard await loadDesktopProjectThreads(projectId, refresh: true) else {
            throw CodexServiceError.invalidInput(desktopProjectLoadStates[projectId]?.errorMessage ?? "Could not load this project.")
        }
        while desktopProjectLoadStates[projectId]?.nextCursor != nil {
            guard desktopSidebarSnapshot?.scopeKey == scope,
                  await loadDesktopProjectThreads(projectId, loadMore: true) else {
                throw CodexServiceError.invalidInput("Could not load every chat. Nothing was archived.")
            }
        }
        guard desktopSidebarSnapshot?.scopeKey == scope, desktopSidebarSnapshot?.revision == revision,
              let state = desktopProjectLoadStates[projectId], state.isComplete else {
            throw CodexServiceError.invalidInput("The project changed. Refresh it before archiving.")
        }
        return Array(state.threadIDs)
    }

    func desktopSidebarErrorCode(_ error: Error) -> String {
        guard case CodexServiceError.rpcError(let rpcError) = error else { return "" }
        if rpcError.code == -32601 { return "unknown_method" }
        return rpcError.data?.objectValue?["errorCode"]?.stringValue ?? ""
    }

    private var desktopDisclosureKey: String {
        macScopedDefaultsKey("codex.desktopSidebar.disclosure") + "." + (desktopSidebarSnapshot?.scopeKey ?? "")
    }

    var sidebarCollapsedProjectIDsStorage: String {
        get {
            desktopSidebarSnapshot == nil ? legacySidebarCollapsedProjectIDsStorage
                : SidebarProjectExpansionState.encodePersistedGroupIDs(desktopCollapsedProjectIDs)
        }
        set {
            if desktopSidebarSnapshot == nil {
                legacySidebarCollapsedProjectIDsStorage = newValue
                defaults.set(newValue, forKey: SidebarProjectExpansionState.collapsedProjectGroupIDsStorageKey)
            } else {
                setDesktopCollapsedProjects(SidebarProjectExpansionState.decodePersistedGroupIDs(newValue))
            }
        }
    }

    func setDesktopCollapsedProjects(_ ids: Set<String>) {
        desktopCollapsedProjectIDs = ids
        defaults.set(Array(ids), forKey: desktopDisclosureKey + ".projects")
    }

    func setDesktopCollapsedSections(_ ids: Set<String>) {
        desktopCollapsedSectionIDs = ids
        defaults.set(Array(ids), forKey: desktopDisclosureKey + ".sections")
    }

    private func loadDesktopSidebarDisclosures() {
        desktopCollapsedSectionIDs = Set(defaults.stringArray(forKey: desktopDisclosureKey + ".sections") ?? [])
        if let saved = defaults.stringArray(forKey: desktopDisclosureKey + ".projects") {
            desktopCollapsedProjectIDs = Set(saved)
        } else {
            let legacy = SidebarProjectExpansionState.decodePersistedGroupIDs(
                defaults.string(forKey: SidebarProjectExpansionState.collapsedProjectGroupIDsStorageKey) ?? ""
            )
            var migrated = legacy
            for project in desktopSidebarSnapshot?.projects ?? [] {
                if legacy.contains(where: { id in
                    id.hasPrefix("project:") && project.rootPaths.contains(where: {
                        CodexDesktopSidebarSnapshot.pathKey($0) == CodexDesktopSidebarSnapshot.pathKey(String(id.dropFirst(8)))
                    })
                }) { migrated.insert("desktop:" + project.id) }
            }
            setDesktopCollapsedProjects(migrated)
        }
    }
}
