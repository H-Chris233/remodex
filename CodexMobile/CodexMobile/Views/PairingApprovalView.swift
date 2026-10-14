// FILE: PairingApprovalView.swift
// Purpose: Requires an explicit comparison with the computer before trusting a new pairing.
// Layer: View
// Depends on: SwiftUI, CodexPairingApprovalPresentation

import SwiftUI

struct PairingApprovalView: View {
    let approval: CodexPairingApprovalPresentation
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "lock.shield")
                    .font(.largeTitle)
                    .accessibilityHidden(true)
                Text(approval.phoneConfirmed ? "Completing secure pairing" : (approval.computerApproved ? "Compare every group" : "Approve on your computer"))
                    .font(.title2.bold())
                Text("Open Remodex on your computer and compare this entire fingerprint. Approve only if every group matches.")
                    .multilineTextAlignment(.center)
                Text(groupedFingerprint)
                    .font(.system(.title3, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("Pairing fingerprint: \(groupedFingerprint)")
                Text(approval.expiresAt, style: .timer)
                    .monospacedDigit()
                    .accessibilityLabel("Time remaining")
                if !approval.computerApproved {
                    Text("In a terminal, run remodex status --json to find the pending request.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Button("Fingerprints match — confirm pairing", action: onConfirm)
                    .buttonStyle(.borderedProminent)
                    .disabled(!approval.computerApproved || approval.phoneConfirmed || approval.expiresAt <= Date())
                Button("Cancel pairing", role: .cancel, action: onCancel)
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
    }

    private var groupedFingerprint: String {
        let characters = Array(approval.fingerprint.uppercased())
        return stride(from: 0, to: characters.count, by: 8).map {
            String(characters[$0..<min($0 + 8, characters.count)])
        }.joined(separator: " ")
    }
}
