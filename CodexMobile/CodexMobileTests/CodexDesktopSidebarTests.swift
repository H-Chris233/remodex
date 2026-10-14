import XCTest
@testable import CodexMobile

@MainActor
final class CodexDesktopSidebarTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    private func snapshot(scope: String = "account-a", revision: String = "r1") -> CodexDesktopSidebarSnapshot {
        CodexDesktopSidebarSnapshot(
            schemaVersion: 1, scopeKey: scope, revision: revision,
            projects: [
                CodexDesktopProject(id: "saved", name: "Friendly name", rootPaths: ["/work/repo", "/work/docs"], projectId: "native"),
                CodexDesktopProject(id: "other", name: "Other", rootPaths: ["/work/other"], projectId: "native-other"),
            ],
            sections: [CodexDesktopSidebarSection(id: "section", name: "Work", projectIds: ["saved"])],
            threadProjectIds: ["moved": "other"], excludedThreadIds: ["rootless"]
        )
    }

    private func service() -> CodexService {
        let name = "CodexDesktopSidebarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        let service = CodexService(defaults: defaults)
        service.isConnected = true
        service.isInitialized = true
        service.desktopSidebarSnapshot = nil
        Self.retainedServices.append(service)
        return service
    }

    private func response<T: Encodable>(_ value: T) throws -> RPCMessage {
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        return RPCMessage(id: .integer(1), result: json, includeJSONRPC: false)
    }

    private func page(scope: String = "account-a", ids: [String], cursor: String? = nil) -> RPCMessage {
        RPCMessage(id: .integer(1), result: .object([
            "scopeKey": .string(scope),
            "data": .array(ids.map { .object(["id": .string($0), "cwd": .string("/work/repo")]) }),
            "nextCursor": cursor.map(JSONValue.string) ?? .null,
        ]), includeJSONRPC: false)
    }

    func testOldThreadCacheStillDecodesAndNativeIdentityRoundTrips() throws {
        let old = try JSONDecoder().decode(CodexThread.self, from: Data(#"{"id":"old","cwd":"/work/repo"}"#.utf8))
        XCTAssertNil(old.projectId)
        let thread = CodexThread(id: "new", cwd: "/work/repo", projectId: "native")
        XCTAssertEqual(try JSONDecoder().decode(CodexThread.self, from: JSONEncoder().encode(thread)).projectId, "native")
    }

    func testCatalogProjectsExistBeforeThreadsLoadAndKeepDesktopNames() {
        let groups = SidebarThreadGrouping.makeGroups(from: [], scope: .projects, desktopSnapshot: snapshot())
        XCTAssertEqual(Set(groups.map(\.id)), ["desktop:saved", "desktop:other"])
        XCTAssertEqual(groups.first { $0.id == "desktop:saved" }?.label, "Friendly name")
        let choices = SidebarThreadGrouping.makeProjectChoices(from: [], desktopSnapshot: snapshot())
        XCTAssertEqual(choices.first { $0.id == "desktop:saved" }?.nativeProjectId, "native")
        XCTAssertEqual(choices.first { $0.id == "desktop:saved" }?.projectPath, "/work/repo")
    }

    func testProjectSectionsCollectUnassignedCatalogAndFallbackDirectories() {
        let desktop = snapshot()
        let rows = [
            CodexThread(id: "fallback", cwd: #"C:\Users\me\scratch"#),
            CodexThread(id: "rootless"),
            CodexThread(id: "pinned", cwd: "/work/repo"),
        ]
        let groups = SidebarThreadGrouping.makeGroups(from: rows, pinnedThreadIDs: ["pinned"], desktopSnapshot: desktop)
        let sections = SidebarThreadGrouping.makeProjectSections(from: groups, desktopSections: desktop.sections)

        XCTAssertEqual(sections.map(\.label), ["Work", "其他"])
        XCTAssertEqual(sections[0].groups.map(\.id), ["desktop:saved"])
        XCTAssertEqual(sections[1].id, SidebarThreadGrouping.otherProjectSectionID)
        XCTAssertEqual(Set(sections[1].groups.map(\.id)), ["desktop:other", #"project:C:\Users\me\scratch"#])
        XCTAssertEqual(sections.flatMap(\.groups).count, groups.filter { $0.kind == .project }.count)
        XCTAssertTrue(sections.flatMap(\.groups).allSatisfy { $0.kind == .project })
    }

    func testProjectSectionsPreserveDesktopOrderAndHideEmptySections() {
        let groups = SidebarThreadGrouping.makeGroups(from: [], scope: .projects, desktopSnapshot: snapshot())
        let desktopSections = [
            CodexDesktopSidebarSection(id: "empty", name: "Empty", projectIds: ["missing"]),
            CodexDesktopSidebarSection(id: "second", name: "Second", projectIds: ["other", "saved"]),
        ]
        let sections = SidebarThreadGrouping.makeProjectSections(from: groups, desktopSections: desktopSections)
        XCTAssertEqual(sections.map(\.id), ["second"])
        XCTAssertEqual(sections[0].groups.map(\.id), ["desktop:other", "desktop:saved"])

        let filtered = groups.filter { $0.id == "desktop:saved" }
        let filteredSections = SidebarThreadGrouping.makeProjectSections(from: filtered, desktopSections: snapshot().sections)
        XCTAssertEqual(filteredSections.map(\.id), ["section"])
        XCTAssertEqual(filteredSections[0].groups.map(\.id), ["desktop:saved"])
    }

    func testProjectSectionsWithoutCatalogUseOtherOnlyForDirectories() {
        let groups = SidebarThreadGrouping.makeGroups(from: [
            CodexThread(id: "local", cwd: "/work/local"),
            CodexThread(id: "chat"),
        ])
        let sections = SidebarThreadGrouping.makeProjectSections(from: groups)
        XCTAssertEqual(sections.map(\.id), [SidebarThreadGrouping.otherProjectSectionID])
        XCTAssertEqual(sections[0].groups.flatMap(\.threads).map(\.id), ["local"])
        XCTAssertTrue(SidebarThreadGrouping.makeProjectSections(from: groups.filter { $0.kind == .chat }).isEmpty)
        XCTAssertTrue(SidebarThreadGrouping.makeProjectSections(from: []).isEmpty)
    }

    func testProjectAndSectionBadgesIncludePinnedSubagentsAndIgnoreArchivedRuns() {
        let rows = [
            CodexThread(id: "root", cwd: "/work/repo"),
            CodexThread(id: "child", cwd: "/work/repo", parentThreadId: "root"),
            CodexThread(id: "idle", cwd: "/work/repo"),
            CodexThread(id: "archived", cwd: "/work/other", syncState: .archivedLocal),
        ]
        let groups = SidebarThreadGrouping.makeGroups(
            from: rows, pinnedThreadIDs: ["root"], desktopSnapshot: snapshot(),
            runBadgeStateByThreadID: ["child": .running, "idle": .waitingOnUser, "archived": .running]
        )
        XCTAssertEqual(groups.first { $0.kind == .pinned }?.runBadgeState, .running)
        let project = groups.first { $0.id == "desktop:saved" }!
        XCTAssertEqual(project.threads.map(\.id), ["idle"])
        XCTAssertEqual(project.runBadgeState, .running)
        XCTAssertNil(groups.first { $0.id == "desktop:other" }?.runBadgeState)
        let sections = SidebarThreadGrouping.makeProjectSections(from: groups, desktopSections: snapshot().sections)
        XCTAssertEqual(SidebarThreadGrouping.aggregateRunBadgeState(sections[0].groups.compactMap(\.runBadgeState)), .running)
    }

    func testMembershipPrecedenceAndWorktreesDoNotRewriteCwd() {
        let desktop = snapshot()
        XCTAssertEqual(desktop.project(for: CodexThread(id: "moved", cwd: "/work/repo"))?.id, "other")
        XCTAssertEqual(desktop.project(for: CodexThread(id: "moved", cwd: "/work/repo", projectId: "native"))?.id, "saved")
        XCTAssertNil(desktop.project(for: CodexThread(id: "rootless", cwd: "/work/repo")))
        let worktree = CodexThread(id: "tree", cwd: "/tmp/tree", worktreeOriginPath: "/work/repo")
        XCTAssertEqual(desktop.project(for: worktree)?.id, "saved")
        XCTAssertEqual(worktree.cwd, "/tmp/tree")
    }

    func testWindowsPathIdentityAndRootBoundary() {
        XCTAssertEqual(CodexDesktopSidebarSnapshot.pathKey(#"\\?\E:\Work\Repo\"#), "e:/work/repo")
        XCTAssertNil(snapshot().project(for: CodexThread(id: "x", cwd: "/work/repository")))
        XCTAssertEqual(snapshot().project(for: CodexThread(id: "x", cwd: "/work/docs"))?.id, "saved")
        XCTAssertNil(snapshot().project(for: CodexThread(id: "x", cwd: "/work/docs/chapter")))
    }

    func testPinsAndSubagentTreeRemainIndependentOfDesktopSections() {
        let rows = [CodexThread(id: "root", cwd: "/work/repo"), CodexThread(id: "child", cwd: "/work/repo", parentThreadId: "root")]
        let groups = SidebarThreadGrouping.makeGroups(from: rows, pinnedThreadIDs: ["root"], scope: .projects, desktopSnapshot: snapshot())
        XCTAssertEqual(groups.first?.kind, .pinned)
        XCTAssertEqual(groups.first?.threads.map(\.id), ["root", "child"])
        XCTAssertTrue(groups.first { $0.id == "desktop:saved" }!.threads.isEmpty)
        XCTAssertEqual(Set(SidebarThreadGrouping.liveThreadIDsForProjectGroup(groups.first { $0.id == "desktop:saved" }!, in: rows, desktopSnapshot: snapshot())), ["root", "child"])
    }

    func testSearchPreservesMatchingProjectOrSectionWithoutDeclaringItEmpty() {
        let groups = SidebarThreadGrouping.makeGroups(from: [], scope: .projects, desktopSnapshot: snapshot(), searchQuery: "Work")
        XCTAssertEqual(groups.map(\.id), ["desktop:saved"])
        XCTAssertTrue(SidebarThreadGrouping.makeGroups(from: [], scope: .projects, desktopSnapshot: snapshot(), searchQuery: "missing").isEmpty)
        var state = CodexDesktopProjectLoadState()
        XCTAssertFalse(state.isConfirmedEmpty)
        state.hasLoadedPage = true
        state.nextCursor = "more"
        XCTAssertFalse(state.isConfirmedEmpty)
        state.nextCursor = nil
        XCTAssertTrue(state.isConfirmedEmpty)
        state.threadIDs = ["pinned"]
        XCTAssertFalse(state.isConfirmedEmpty)
    }

    func testSubagentWithoutAssignmentFollowsMovedParent() {
        let rows = [
            CodexThread(id: "moved", cwd: "/work/repo"),
            CodexThread(id: "child", cwd: "/work/repo", parentThreadId: "moved"),
        ]
        let groups = SidebarThreadGrouping.makeGroups(from: rows, scope: .projects, desktopSnapshot: snapshot())
        XCTAssertEqual(Set(groups.first { $0.id == "desktop:other" }!.threads.map(\.id)), ["moved", "child"])
        XCTAssertTrue(groups.first { $0.id == "desktop:saved" }!.threads.isEmpty)
    }

    func testCatalogRefreshPersistsSnapshotAndKeepsLocalDisclosure() async throws {
        let service = service()
        service.defaults.set(#"["project:/work/repo"]"#, forKey: SidebarProjectExpansionState.collapsedProjectGroupIDsStorageKey)
        service.requestTransportOverride = { [self] _, _ in try response(snapshot()) }
        await service.refreshDesktopSidebar(force: true)
        XCTAssertTrue(service.desktopCollapsedProjectIDs.contains("desktop:saved"))
        service.setDesktopCollapsedSections(["section", SidebarThreadGrouping.otherProjectSectionID])
        service.loadDesktopSidebarCache(for: service.currentMacScopedPersistenceDeviceId)
        XCTAssertEqual(service.desktopSidebarSnapshot?.scopeKey, "account-a")
        XCTAssertEqual(service.desktopCollapsedSectionIDs, ["section", SidebarThreadGrouping.otherProjectSectionID])
        service.loadDesktopSidebarCache(for: "different-computer")
        XCTAssertNil(service.desktopSidebarSnapshot)
    }

    func testProjectPagingLoadsChatsOutsideRecentWindowAndPreservesExistingRows() async {
        let service = service()
        service.desktopSidebarSnapshot = snapshot()
        service.threads = (0..<70).map { CodexThread(id: "recent-\($0)", cwd: "/work/other") }
        service.requestTransportOverride = { [self] method, params in
            XCTAssertEqual(method, "desktop/sidebar/projectThreads/list")
            if params?.objectValue?["cursor"]?.stringValue == "more" { return page(ids: ["old-2"]) }
            return page(ids: ["old-1"], cursor: "more")
        }
        let loaded = await service.loadDesktopProjectThreads("saved")
        XCTAssertTrue(loaded)
        XCTAssertEqual(service.threads.count, 71)
        XCTAssertFalse(service.desktopProjectLoadStates["saved"]!.isComplete)
        let more = await service.loadDesktopProjectThreads("saved", loadMore: true)
        XCTAssertTrue(more)
        XCTAssertEqual(service.threads.count, 72)
        XCTAssertEqual(service.desktopProjectLoadStates["saved"]?.threadIDs, ["old-1", "old-2"])
        XCTAssertTrue(service.desktopProjectLoadStates["saved"]!.isComplete)
    }

    func testTransientFailureKeepsSnapshotAndConnection() async {
        let service = service()
        service.desktopSidebarSnapshot = snapshot()
        service.requestTransportOverride = { _, _ in throw URLError(.timedOut) }
        await service.refreshDesktopSidebar(force: true)
        XCTAssertEqual(service.desktopSidebarSnapshot?.scopeKey, "account-a")
        XCTAssertTrue(service.isConnected)
        let loaded = await service.loadDesktopProjectThreads("saved")
        XCTAssertFalse(loaded)
        XCTAssertNotNil(service.desktopProjectLoadStates["saved"]?.errorMessage)
        XCTAssertFalse(service.desktopProjectLoadStates["saved"]!.isConfirmedEmpty)
    }

    func testOldBridgeFallsBackWithoutRepeatedRequests() async {
        let service = service()
        service.desktopSidebarSnapshot = snapshot()
        var calls = 0
        service.requestTransportOverride = { _, _ in
            calls += 1
            throw CodexServiceError.rpcError(RPCError(code: -32601, message: "method not found"))
        }
        await service.refreshDesktopSidebar(force: true)
        await service.refreshDesktopSidebar(force: true)
        XCTAssertEqual(calls, 1)
        XCTAssertNil(service.desktopSidebarSnapshot)
    }

    func testOldAccountResponseCannotReplaceNewScope() async throws {
        let service = service()
        var pending: CheckedContinuation<RPCMessage, Error>?
        service.requestTransportOverride = { _, _ in try await withCheckedThrowingContinuation { pending = $0 } }
        let request = Task { await service.refreshDesktopSidebar(force: true) }
        while pending == nil { await Task.yield() }
        service.resetDesktopSidebarRequests(clearSnapshot: true)
        service.desktopSidebarSnapshot = snapshot(scope: "account-b", revision: "r2")
        pending?.resume(returning: try response(snapshot()))
        await request.value
        XCTAssertEqual(service.desktopSidebarSnapshot?.scopeKey, "account-b")
    }

    func testIncompleteProjectCannotBeBulkArchived() async {
        let service = service()
        service.desktopSidebarSnapshot = snapshot()
        service.requestTransportOverride = { [self] method, params in
            XCTAssertEqual(method, "desktop/sidebar/projectThreads/list")
            if params?.objectValue?["cursor"] != nil { throw URLError(.timedOut) }
            return page(ids: ["first"], cursor: "more")
        }
        do {
            _ = try await service.allDesktopProjectThreadIDs("saved")
            XCTFail("An incomplete project must not be archived")
        } catch {
            XCTAssertTrue(service.locallyArchivedThreadIDs.isEmpty)
        }
    }

    func testNewChatCarriesProjectIdentityWithoutChangingWorkingDirectory() {
        let params = CodexThreadStartProjectBinding.makeThreadStartParams(modelIdentifier: nil, preferredProjectPath: "/work/repo", serviceTier: nil, projectId: "native")
        XCTAssertEqual(params["cwd"]?.stringValue, "/work/repo")
        XCTAssertEqual(params["projectId"]?.stringValue, "native")
        XCTAssertNil(CodexThreadStartProjectBinding.makeThreadStartParams(modelIdentifier: nil, preferredProjectPath: nil, serviceTier: nil)["projectId"])
    }
}
