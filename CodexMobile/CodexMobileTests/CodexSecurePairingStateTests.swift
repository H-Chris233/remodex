// FILE: CodexSecurePairingStateTests.swift
// Purpose: Verifies fresh QR scans force bootstrap mode and secure pairing failures stay actionable in UI state.
// Layer: Unit Test
// Exports: CodexSecurePairingStateTests
// Depends on: Foundation, XCTest, CodexMobile

import Foundation
import CryptoKit
import XCTest
@testable import CodexMobile

@MainActor
final class CodexSecurePairingStateTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testComputerApprovalUsesTheSecureRouteOnPredecodedTransports() {
        let service = makeService()
        let wire = #"{"kind":"pairingApproved","protocolVersion":3,"sessionId":"pending","keyEpoch":1}"#
        let classification = WireMessagePreDecoder.classify(wire)
        XCTAssertTrue(classification.isSecure)
        XCTAssertNil(classification.rpcResult)
        service.processIncomingWireText(wire)
        XCTAssertEqual(service.bufferedSecureControlMessages["pairingApproved"], [wire])
        XCTAssertNil(service.secureSession)
    }

    func testPlaintextRelayNotificationsCannotChangeBusinessStateDuringPairing() {
        let service = makeService()
        let wire = #"{"method":"thread/name/updated","params":{"threadId":"relay-injected","name":"injected"}}"#
        let originalThreadIDs = service.threads.map(\.id)
        for state in [CodexSecureConnectionState.awaitingComputerApproval, .awaitingPhoneConfirmation, .encrypted] {
            service.secureConnectionState = state
            XCTAssertFalse(WireMessagePreDecoder.classify(wire).isSecure)
            service.processIncomingWireText(wire)
            XCTAssertEqual(service.threads.map(\.id), originalThreadIDs)
            XCTAssertNil(service.secureSession)
        }
    }

    func testPhoneConfirmationRequiresTheCurrentApprovedUnexpiredRequest() async throws {
        let service = makeService()
        service.pairingApproval = CodexPairingApprovalPresentation(
            requestId: "current", fingerprint: String(repeating: "a", count: 64), expiresAt: Date().addingTimeInterval(60)
        )
        try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
            service.pairingConfirmationContinuation = waiter
            service.confirmPairingOnPhone(requestId: "current")
            XCTAssertNotNil(service.pairingConfirmationContinuation)
            service.pairingApproval?.computerApproved = true
            service.confirmPairingOnPhone(requestId: "stale")
            XCTAssertNotNil(service.pairingConfirmationContinuation)
            service.confirmPairingOnPhone(requestId: "current")
        }
        XCTAssertNil(service.pairingConfirmationContinuation)
        XCTAssertEqual(service.pairingApproval?.phoneConfirmed, true)
        XCTAssertNil(service.secureSession)
    }

    func testDisconnectCleanupResumesTheHumanWaitAndDropsItsPresentation() async {
        let service = makeService()
        service.pairingApproval = CodexPairingApprovalPresentation(
            requestId: "pending", fingerprint: String(repeating: "a", count: 64), expiresAt: Date().addingTimeInterval(60)
        )
        do {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
                service.pairingConfirmationContinuation = waiter
                service.resetSecureTransportState()
            }
            XCTFail("An interrupted pairing must not be confirmed.")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertNil(service.pairingApproval)
        XCTAssertNil(service.pairingConfirmationContinuation)
        XCTAssertNil(service.pairingCancelMessage)
    }

    func testPairingV3MatchesNodeFixtureAndRejectsForgedApprovalAndReady() throws {
        let fixtureURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "pairing-v3", withExtension: "json"))
        let vector = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let input = try XCTUnwrap(vector["input"] as? [String: Any])
        func string(_ object: [String: Any], _ key: String) throws -> String { try XCTUnwrap(object[key] as? String) }
        let transcript = try codexSecureTranscriptBytes(
            sessionId: string(input, "sessionId"), protocolVersion: 3, handshakeMode: .qrBootstrap,
            keyEpoch: 7, macDeviceId: string(input, "macDeviceId"), phoneDeviceId: string(input, "phoneDeviceId"),
            macIdentityPublicKey: string(input, "macIdentityPublicKey"), phoneIdentityPublicKey: string(input, "phoneIdentityPublicKey"),
            macEphemeralPublicKey: string(input, "macEphemeralPublicKey"), phoneEphemeralPublicKey: string(input, "phoneEphemeralPublicKey"),
            clientNonce: XCTUnwrap(Data(base64Encoded: string(input, "clientNonce"))),
            serverNonce: XCTUnwrap(Data(base64Encoded: string(input, "serverNonce"))),
            expiresAtForTranscript: 1_900_000_000_000, pairingRequestId: string(input, "pairingRequestId")
        )
        XCTAssertEqual(transcript.base64EncodedString(), try string(vector, "transcriptBase64"))
        XCTAssertEqual(codexPairingFingerprint(transcript), try string(vector, "fingerprint"))
        let phoneKey = try Curve25519.Signing.PrivateKey(rawRepresentation: XCTUnwrap(Data(base64Encoded: string(vector, "phonePrivateSeed"))))
        let nonce = try string(vector, "approvalNonce")
        XCTAssertEqual(try phoneKey.signature(for: codexClientAuthTranscript(from: transcript)).base64EncodedString(), try string(vector, "phoneAuth"))
        XCTAssertEqual(try phoneKey.signature(for: codexPairingControlTranscript(transcript, label: "client-pairing-confirm", approvalNonce: nonce)).base64EncodedString(), try string(vector, "phoneConfirm"))
        XCTAssertEqual(try phoneKey.signature(for: codexPairingControlTranscript(transcript, label: "client-pairing-cancel")).base64EncodedString(), try string(vector, "phoneCancel"))

        var helloFields = input
        helloFields["kind"] = "serverHello"
        helloFields["macSignature"] = try string(vector, "macHandshake")
        let decoder = JSONDecoder()
        let hello = try decoder.decode(SecureServerHello.self, from: JSONSerialization.data(withJSONObject: helloFields))
        let approvedFields: [String: Any] = [
            "kind": "pairingApproved", "protocolVersion": 3, "sessionId": hello.sessionId, "keyEpoch": hello.keyEpoch,
            "requestId": hello.pairingRequestId ?? "", "expiresAt": hello.expiresAtForTranscript,
            "approvalNonce": nonce, "macSignature": try string(vector, "macApproval"),
        ]
        func approval(_ changes: [String: Any] = [:]) throws -> SecurePairingApproved {
            try decoder.decode(SecurePairingApproved.self, from: JSONSerialization.data(withJSONObject: approvedFields.merging(changes) { _, new in new }))
        }
        XCTAssertTrue(try approval().isValid(for: hello, transcriptBytes: transcript))
        let invalidApprovals: [[String: Any]] = [
            ["protocolVersion": 2], ["requestId": String(repeating: "f", count: 32)], ["sessionId": "other-session"],
            ["expiresAt": hello.expiresAtForTranscript + 1], ["approvalNonce": Data(repeating: 9, count: 32).base64EncodedString()],
            ["macSignature": try string(vector, "macReady")],
        ]
        for changes in invalidApprovals {
            XCTAssertFalse(try approval(changes).isValid(for: hello, transcriptBytes: transcript))
        }
        let readyFields: [String: Any] = [
            "kind": "secureReady", "protocolVersion": 3, "sessionId": hello.sessionId, "keyEpoch": hello.keyEpoch,
            "macDeviceId": hello.macDeviceId, "requestId": hello.pairingRequestId ?? "", "macSignature": try string(vector, "macReady"),
        ]
        let ready = try decoder.decode(SecureReadyMessage.self, from: JSONSerialization.data(withJSONObject: readyFields))
        XCTAssertTrue(ready.isValid(for: hello, transcriptBytes: transcript, approvalNonce: nonce))
        XCTAssertFalse(ready.isValid(for: hello, transcriptBytes: transcript, approvalNonce: ""))
        XCTAssertFalse(ready.isValid(for: hello, transcriptBytes: transcript + Data([0]), approvalNonce: nonce))
    }

    override func setUp() {
        super.setUp()
        clearStoredSecureRelayState()
    }

    override func tearDown() {
        clearStoredSecureRelayState()
        super.tearDown()
    }

    func testRememberRelayPairingForcesFreshQRBootstrapEvenForTrustedMac() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let originalPublicKey = Data(repeating: 1, count: 32).base64EncodedString()
        let freshQRPublicKey = Data(repeating: 2, count: 32).base64EncodedString()

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: originalPublicKey,
            lastPairedAt: Date()
        )

        service.rememberRelayPairing(
            CodexPairingQRPayload(
                v: codexPairingQRVersion,
                relay: "ws://relay.local/relay",
                sessionId: "session-\(UUID().uuidString)",
                macDeviceId: macDeviceID,
                macIdentityPublicKey: freshQRPublicKey,
                expiresAt: Int64(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
            )
        )

        XCTAssertTrue(service.shouldForceQRBootstrapOnNextHandshake)
        XCTAssertFalse(service.hasTrustedReconnectContext)
        XCTAssertEqual(service.secureConnectionState, .trustedMac)
        XCTAssertEqual(service.normalizedRelayMacIdentityPublicKey, freshQRPublicKey)
    }

    func testRememberRelayPairingShowsHandshakeStateForBrandNewMac() {
        let service = makeService()
        let freshQRPublicKey = Data(repeating: 4, count: 32).base64EncodedString()

        service.rememberRelayPairing(
            CodexPairingQRPayload(
                v: codexPairingQRVersion,
                relay: "ws://relay.local/relay",
                sessionId: "session-\(UUID().uuidString)",
                macDeviceId: "mac-\(UUID().uuidString)",
                macIdentityPublicKey: freshQRPublicKey,
                expiresAt: Int64(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
            )
        )

        XCTAssertTrue(service.shouldForceQRBootstrapOnNextHandshake)
        XCTAssertEqual(service.secureConnectionState, .handshaking)
        XCTAssertEqual(service.secureMacFingerprint, codexSecureFingerprint(for: freshQRPublicKey))
    }

    func testResetSecureTransportStatePreservesRePairRequiredState() {
        let service = makeService()
        service.relaySessionId = "session-\(UUID().uuidString)"
        service.relayUrl = "ws://relay.local/relay"
        service.secureConnectionState = .rePairRequired
        service.secureMacFingerprint = "ABC123"

        service.resetSecureTransportState()

        XCTAssertEqual(service.secureConnectionState, .rePairRequired)
        XCTAssertEqual(service.secureMacFingerprint, "ABC123")
    }

    func testApplyingResolvedTrustedSessionResetsReplayCursorWhenLiveSessionChanges() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"

        service.relaySessionId = "stale-session"
        service.relayUrl = "wss://relay.local/relay"
        service.relayMacDeviceId = macDeviceID
        service.lastAppliedBridgeOutboundSeq = 17
        SecureStore.writeString("17", for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)

        service.applyResolvedTrustedSession(
            CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: macDeviceID,
                macIdentityPublicKey: Data(repeating: 7, count: 32).base64EncodedString(),
                displayName: "Desk Mac",
                sessionId: "fresh-session"
            ),
            relayURL: "wss://relay.local/relay"
        )

        XCTAssertEqual(service.lastAppliedBridgeOutboundSeq, 0)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq),
            "0"
        )
    }

    func testApplyingResolvedTrustedSessionKeepsReplayCursorWhenLiveSessionIsUnchanged() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"

        service.relaySessionId = "same-session"
        service.relayUrl = "wss://relay.local/relay"
        service.relayMacDeviceId = macDeviceID
        service.lastAppliedBridgeOutboundSeq = 17
        SecureStore.writeString("17", for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)

        service.applyResolvedTrustedSession(
            CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: macDeviceID,
                macIdentityPublicKey: Data(repeating: 8, count: 32).base64EncodedString(),
                displayName: "Desk Mac",
                sessionId: "same-session"
            ),
            relayURL: "wss://relay.local/relay"
        )

        XCTAssertEqual(service.lastAppliedBridgeOutboundSeq, 17)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq),
            "17"
        )
    }

    func testTrustMacPromotesCurrentTrustedMacDeviceId() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"

        service.trustMac(
            deviceId: macDeviceID,
            publicKey: Data(repeating: 6, count: 32).base64EncodedString(),
            relayURL: "wss://relay.local/relay",
            displayName: "Desk Mac"
        )

        XCTAssertEqual(service.normalizedCurrentTrustedMacDeviceId, macDeviceID)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.currentTrustedMacDeviceId),
            macDeviceID
        )
    }

    func testInitializationMigratesCurrentTrustedMacDeviceIdFromRelayMacDeviceId() {
        let macDeviceID = "mac-\(UUID().uuidString)"
        let publicKey = Data(repeating: 12, count: 32).base64EncodedString()

        SecureStore.writeCodable(
            CodexTrustedMacRegistry(
                records: [
                    macDeviceID: CodexTrustedMacRecord(
                        macDeviceId: macDeviceID,
                        macIdentityPublicKey: publicKey,
                        lastPairedAt: Date()
                    )
                ]
            ),
            for: CodexSecureKeys.trustedMacRegistry
        )
        SecureStore.writeString(macDeviceID, for: CodexSecureKeys.relayMacDeviceId)

        let service = makeService()

        XCTAssertEqual(service.normalizedCurrentTrustedMacDeviceId, macDeviceID)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.currentTrustedMacDeviceId),
            macDeviceID
        )
    }

    func testInitializationDoesNotInventCurrentTrustedMacWhenLegacyPointersAreUnknown() {
        let knownMacDeviceID = "mac-\(UUID().uuidString)"

        SecureStore.writeCodable(
            CodexTrustedMacRegistry(
                records: [
                    knownMacDeviceID: CodexTrustedMacRecord(
                        macDeviceId: knownMacDeviceID,
                        macIdentityPublicKey: Data(repeating: 13, count: 32).base64EncodedString(),
                        lastPairedAt: Date()
                    )
                ]
            ),
            for: CodexSecureKeys.trustedMacRegistry
        )
        SecureStore.writeString("mac-missing", for: CodexSecureKeys.lastTrustedMacDeviceId)

        let service = makeService()

        XCTAssertNil(service.normalizedCurrentTrustedMacDeviceId)
        XCTAssertNil(SecureStore.readString(for: CodexSecureKeys.currentTrustedMacDeviceId))
    }

    func testInitializationMigratesCurrentTrustedMacDeviceIdFromLastTrustedMacDeviceId() {
        let macDeviceID = "mac-\(UUID().uuidString)"
        let publicKey = Data(repeating: 14, count: 32).base64EncodedString()

        SecureStore.writeCodable(
            CodexTrustedMacRegistry(
                records: [
                    macDeviceID: CodexTrustedMacRecord(
                        macDeviceId: macDeviceID,
                        macIdentityPublicKey: publicKey,
                        lastPairedAt: Date()
                    )
                ]
            ),
            for: CodexSecureKeys.trustedMacRegistry
        )
        SecureStore.writeString(macDeviceID, for: CodexSecureKeys.lastTrustedMacDeviceId)

        let service = makeService()

        XCTAssertEqual(service.normalizedCurrentTrustedMacDeviceId, macDeviceID)
        XCTAssertEqual(
            SecureStore.readString(for: CodexSecureKeys.currentTrustedMacDeviceId),
            macDeviceID
        )
    }

    func testClearSavedRelaySessionFallsBackToCurrentTrustedMacState() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let publicKey = Data(repeating: 15, count: 32).base64EncodedString()

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: publicKey,
            lastPairedAt: Date(),
            relayURL: "wss://relay.local/relay"
        )
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.local/relay"
        service.relayMacDeviceId = macDeviceID
        service.relayMacIdentityPublicKey = publicKey

        service.clearSavedRelaySession()

        XCTAssertEqual(service.secureConnectionState, .liveSessionUnresolved)
        XCTAssertEqual(service.secureMacFingerprint, codexSecureFingerprint(for: publicKey))
        XCTAssertNil(service.normalizedRelaySessionId)
    }

    func testInitializationMigratesLegacyMacScopedDefaultsIntoCurrentMacScope() throws {
        let macDeviceID = "mac-\(UUID().uuidString)"
        let suiteName = "CodexSecurePairingStateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)

        let legacyPlanSources = try JSONEncoder().encode(["thread-1": CodexPlanSessionSource.requested])
        let legacyWorktreePaths = try JSONEncoder().encode(["thread-1": "/tmp/worktree"])
        let legacyTurnTerminalStates = try JSONEncoder().encode(["turn-1": CodexTurnTerminalState.completed])
        defaults.set(legacyPlanSources, forKey: CodexService.planSessionSourcesDefaultsKey)
        defaults.set(legacyWorktreePaths, forKey: CodexService.associatedManagedWorktreePathsDefaultsKey)
        defaults.set(["deleted-thread"], forKey: CodexService.locallyDeletedThreadIDsKey)
        defaults.set(legacyTurnTerminalStates, forKey: CodexService.turnTerminalStatesDefaultsKey)

        SecureStore.writeCodable(
            CodexTrustedMacRegistry(
                records: [
                    macDeviceID: CodexTrustedMacRecord(
                        macDeviceId: macDeviceID,
                        macIdentityPublicKey: Data(repeating: 16, count: 32).base64EncodedString(),
                        lastPairedAt: Date()
                    )
                ]
            ),
            for: CodexSecureKeys.trustedMacRegistry
        )
        SecureStore.writeString(macDeviceID, for: CodexSecureKeys.currentTrustedMacDeviceId)

        let service = makeService(defaults: defaults)

        XCTAssertEqual(service.planSessionSourceByThread["thread-1"], .requested)
        XCTAssertEqual(service.associatedManagedWorktreePath(for: "thread-1"), "/tmp/worktree")
        XCTAssertEqual(service.locallyDeletedThreadIDs, Set(["deleted-thread"]))
        XCTAssertEqual(service.turnTerminalState(for: "turn-1"), .completed)
        XCTAssertNil(defaults.object(forKey: CodexService.planSessionSourcesDefaultsKey))
        XCTAssertNil(defaults.object(forKey: CodexService.associatedManagedWorktreePathsDefaultsKey))
        XCTAssertNil(defaults.object(forKey: CodexService.locallyDeletedThreadIDsKey))
        XCTAssertNil(defaults.object(forKey: CodexService.turnTerminalStatesDefaultsKey))
        XCTAssertNotNil(
            defaults.data(forKey: service.macScopedDefaultsKey(CodexService.planSessionSourcesDefaultsKey, macDeviceId: macDeviceID))
        )
        XCTAssertNotNil(
            defaults.data(forKey: service.macScopedDefaultsKey(CodexService.associatedManagedWorktreePathsDefaultsKey, macDeviceId: macDeviceID))
        )
        XCTAssertNotNil(
            defaults.array(forKey: service.macScopedDefaultsKey(CodexService.locallyDeletedThreadIDsKey, macDeviceId: macDeviceID))
        )
        XCTAssertNotNil(
            defaults.data(forKey: service.macScopedDefaultsKey(CodexService.turnTerminalStatesDefaultsKey, macDeviceId: macDeviceID))
        )
    }

    // Clears the persisted relay session keys touched by secure reconnect tests.
    private func clearStoredSecureRelayState() {
        SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayUrl)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacDeviceId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacIdentityPublicKey)
        SecureStore.deleteValue(for: CodexSecureKeys.relayProtocolVersion)
        SecureStore.deleteValue(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)
        SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
        SecureStore.deleteValue(for: CodexSecureKeys.currentTrustedMacDeviceId)
        SecureStore.deleteValue(for: CodexSecureKeys.lastTrustedMacDeviceId)
    }

    private func makeService(defaults: UserDefaults? = nil) -> CodexService {
        let resolvedDefaults: UserDefaults
        if let defaults {
            resolvedDefaults = defaults
        } else {
            let suiteName = "CodexSecurePairingStateTests.\(UUID().uuidString)"
            let isolatedDefaults = UserDefaults(suiteName: suiteName) ?? .standard
            isolatedDefaults.removePersistentDomain(forName: suiteName)
            resolvedDefaults = isolatedDefaults
        }

        let service = CodexService(defaults: resolvedDefaults)
        Self.retainedServices.append(service)
        return service
    }
}
