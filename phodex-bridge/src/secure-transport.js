// FILE: secure-transport.js
// Purpose: Owns the bridge-side E2EE handshake, envelope crypto, and reconnect catch-up buffer.
// Layer: CLI helper
// Exports: createBridgeSecureTransport, SECURE_PROTOCOL_VERSION, PAIRING_QR_VERSION
// Depends on: crypto, ./secure-device-state

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} = require("crypto");
const {
  getTrustedPhonePublicKey,
  rememberTrustedPhone,
} = require("./secure-device-state");

const PAIRING_QR_VERSION = 3;
const SECURE_PROTOCOL_VERSION = 3;
const HANDSHAKE_TAG = "remodex-e2ee-v1";
const HANDSHAKE_MODE_QR_BOOTSTRAP = "qr_bootstrap";
const HANDSHAKE_MODE_TRUSTED_RECONNECT = "trusted_reconnect";
const SECURE_SENDER_MAC = "mac";
const SECURE_SENDER_IPHONE = "iphone";
const MAX_PAIRING_AGE_MS = 5 * 60 * 1000;
const MAX_BRIDGE_OUTBOUND_MESSAGES = 500;
const MAX_BRIDGE_OUTBOUND_BYTES = 10 * 1024 * 1024;

function createBridgeSecureTransport({
  sessionId,
  relayUrl,
  deviceState,
  displayName = "",
  onTrustedPhoneUpdate = null,
  onSecureSessionReady = null,
  onPairingApprovalChange = null,
  persistTrustedPhone = true,
  now = () => Date.now(),
  rememberTrustedPhoneImpl = rememberTrustedPhone,
}) {
  let currentDeviceState = deviceState;
  const bridgeDisplayName = normalizeNonEmptyString(displayName);
  let pendingHandshake = null;
  let activeSession = null;
  let liveSendWireMessage = null;
  // Tracks the highest bridge seq the phone has definitely acked, so replay
  // decisions never depend on best-effort local socket writes.
  let lastRelayedBridgeOutboundSeq = 0;
  let currentPairingExpiresAt = 0;
  let pairingGeneration = "";
  let pairingTimer = null;
  let completedPairing = null;
  let nextKeyEpoch = 1;
  // Sequence numbers restart at 1 with each bridge process. Namespace them so
  // a phone never mistakes new-process seq 1 for old-process seq 1.
  const bridgeReplayEpoch = randomBytes(16).toString("hex");
  let nextBridgeOutboundSeq = 1;
  let outboundBufferBytes = 0;
  const outboundBuffer = [];

  function createPairingPayload() {
    cancelPendingHandshake();
    pairingGeneration = randomBytes(16).toString("hex");
    currentPairingExpiresAt = now() + MAX_PAIRING_AGE_MS;
    return {
      v: PAIRING_QR_VERSION,
      relay: relayUrl,
      sessionId,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      expiresAt: currentPairingExpiresAt,
      displayName: bridgeDisplayName,
    };
  }

  function handleIncomingWireMessage(rawMessage, { sendControlMessage, onApplicationMessage }) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const kind = normalizeNonEmptyString(parsed.kind);
    if (!kind) {
      if (parsed.method || parsed.id != null) {
        sendControlMessage(createSecureError({
          code: "update_required",
          message: "This bridge requires the latest Remodex iPhone app for secure pairing.",
        }));
        return true;
      }
      return false;
    }

    switch (kind) {
    case "clientHello":
      handleClientHello(parsed, sendControlMessage);
      return true;
    case "clientAuth":
      handleClientAuth(parsed, sendControlMessage);
      return true;
    case "clientPairingConfirm":
      handleClientPairingConfirm(parsed, sendControlMessage);
      return true;
    case "clientPairingCancel":
      handleClientPairingCancel(parsed, sendControlMessage);
      return true;
    case "resumeState":
      handleResumeState(parsed);
      return true;
    case "encryptedEnvelope":
      return handleEncryptedEnvelope(parsed, sendControlMessage, onApplicationMessage);
    default:
      return false;
    }
  }

  function queueOutboundApplicationMessage(payloadText, sendWireMessage) {
    const normalizedPayload = normalizeNonEmptyString(payloadText);
    if (!normalizedPayload) {
      return;
    }

    const bufferEntry = {
      bridgeOutboundSeq: nextBridgeOutboundSeq,
      payloadText: normalizedPayload,
      sizeBytes: Buffer.byteLength(normalizedPayload, "utf8"),
    };
    nextBridgeOutboundSeq += 1;
    outboundBuffer.push(bufferEntry);
    outboundBufferBytes += bufferEntry.sizeBytes;
    trimOutboundBuffer();

    const liveSessionSender = activeSession?.sendWireMessage;
    const effectiveSendWireMessage = typeof liveSessionSender === "function"
      ? liveSessionSender
      : sendWireMessage;
    if (activeSession?.isResumed && typeof effectiveSendWireMessage === "function") {
      sendBufferedEntry(bufferEntry, effectiveSendWireMessage);
    }
  }

  function isSecureChannelReady() {
    return Boolean(activeSession?.isResumed);
  }

  function handleClientHello(message, sendControlMessage) {
    const protocolVersion = Number(message.protocolVersion);
    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const handshakeMode = normalizeNonEmptyString(message.handshakeMode);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const phoneIdentityPublicKey = normalizeNonEmptyString(message.phoneIdentityPublicKey);
    const phoneEphemeralPublicKey = normalizeNonEmptyString(message.phoneEphemeralPublicKey);
    const clientNonceBase64 = normalizeNonEmptyString(message.clientNonce);

    if (protocolVersion !== SECURE_PROTOCOL_VERSION || incomingSessionId !== sessionId) {
      sendControlMessage(createSecureError({
        code: "update_required",
        message: "The bridge and iPhone are not using the same secure transport version.",
      }));
      return;
    }

    if (!phoneDeviceId || !phoneIdentityPublicKey || !phoneEphemeralPublicKey || !clientNonceBase64) {
      sendControlMessage(createSecureError({
        code: "invalid_client_hello",
        message: "The iPhone handshake is missing required secure fields.",
      }));
      return;
    }

    if (handshakeMode !== HANDSHAKE_MODE_QR_BOOTSTRAP && handshakeMode !== HANDSHAKE_MODE_TRUSTED_RECONNECT) {
      sendControlMessage(createSecureError({
        code: "invalid_handshake_mode",
        message: "The iPhone requested an unknown secure pairing mode.",
      }));
      return;
    }

    if (handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP && (!currentPairingExpiresAt || now() >= currentPairingExpiresAt)) {
      sendControlMessage(createSecureError({
        code: "pairing_expired",
        message: "The pairing QR code has expired. Generate a new QR code from the bridge.",
      }));
      return;
    }

    if (pendingHandshake && pendingHandshake.phase !== "authenticating") {
      sendControlMessage(createSecureError({
        code: "pairing_busy",
        message: "A pairing request is already awaiting confirmation on the computer.",
      }));
      return;
    }

    const trustedPhonePublicKey = getTrustedPhonePublicKey(currentDeviceState, phoneDeviceId);
    if (handshakeMode === HANDSHAKE_MODE_TRUSTED_RECONNECT) {
      if (!trustedPhonePublicKey) {
        sendControlMessage(createSecureError({
          code: "phone_not_trusted",
          message: "This iPhone is not trusted by the current bridge session. Scan a fresh QR code to pair again.",
        }));
        return;
      }
      if (trustedPhonePublicKey !== phoneIdentityPublicKey) {
        sendControlMessage(createSecureError({
          code: "phone_identity_changed",
          message: "The trusted iPhone identity does not match this reconnect attempt.",
        }));
        return;
      }
    }

    const clientNonce = base64ToBuffer(clientNonceBase64);
    if (!clientNonce || clientNonce.length === 0) {
      sendControlMessage(createSecureError({
        code: "invalid_client_nonce",
        message: "The iPhone secure nonce could not be decoded.",
      }));
      return;
    }

    const ephemeral = generateKeyPairSync("x25519");
    const privateJwk = ephemeral.privateKey.export({ format: "jwk" });
    const publicJwk = ephemeral.publicKey.export({ format: "jwk" });
    const serverNonce = randomBytes(32);
    const keyEpoch = nextKeyEpoch;
    const pairingRequestId = handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP
      ? randomBytes(16).toString("hex")
      : "";
    const expiresAtForTranscript = handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP
      ? currentPairingExpiresAt
      : 0;
    const transcriptBytes = buildTranscriptBytes({
      sessionId,
      protocolVersion,
      handshakeMode,
      keyEpoch,
      macDeviceId: currentDeviceState.macDeviceId,
      phoneDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      phoneIdentityPublicKey,
      macEphemeralPublicKey: base64UrlToBase64(publicJwk.x),
      phoneEphemeralPublicKey,
      clientNonce,
      serverNonce,
      expiresAtForTranscript,
      pairingRequestId,
    });
    const macSignature = signTranscript(
      currentDeviceState.macIdentityPrivateKey,
      currentDeviceState.macIdentityPublicKey,
      transcriptBytes
    );
    debugSecureLog(
      `serverHello mode=${handshakeMode} session=${shortId(sessionId)} keyEpoch=${keyEpoch} `
      + `mac=${shortId(currentDeviceState.macDeviceId)} phone=${shortId(phoneDeviceId)} `
      + `macKey=${shortFingerprint(currentDeviceState.macIdentityPublicKey)} `
      + `phoneKey=${shortFingerprint(phoneIdentityPublicKey)} `
      + `transcript=${transcriptDigest(transcriptBytes)}`
    );

    pendingHandshake = {
      sessionId,
      handshakeMode,
      keyEpoch,
      phoneDeviceId,
      phoneIdentityPublicKey,
      phoneEphemeralPublicKey,
      macEphemeralPrivateKey: base64UrlToBase64(privateJwk.d),
      macEphemeralPublicKey: base64UrlToBase64(publicJwk.x),
      transcriptBytes,
      expiresAtForTranscript,
      pairingRequestId,
      pairingGeneration,
      phase: "authenticating",
      approvalNonce: "",
      sendControlMessage,
    };

    sendControlMessage({
      kind: "serverHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId,
      handshakeMode,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      macEphemeralPublicKey: pendingHandshake.macEphemeralPublicKey,
      serverNonce: serverNonce.toString("base64"),
      keyEpoch,
      bridgeReplayEpoch,
      expiresAtForTranscript,
      macSignature,
      clientNonce: clientNonceBase64,
      displayName: bridgeDisplayName,
      pairingRequestId,
    });
  }

  function handleClientAuth(message, sendControlMessage) {
    if (!pendingHandshake) {
      sendControlMessage(createSecureError({
        code: "unexpected_client_auth",
        message: "The bridge did not have a pending secure handshake to finalize.",
      }));
      return;
    }

    if (pendingHandshake.phase !== "authenticating") {
      sendControlMessage(createSecureError({ code: "pairing_busy", message: "Confirm the pending pairing on the computer and iPhone." }));
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const keyEpoch = Number(message.keyEpoch);
    const phoneSignature = normalizeNonEmptyString(message.phoneSignature);
    if (
      incomingSessionId !== pendingHandshake.sessionId
      || phoneDeviceId !== pendingHandshake.phoneDeviceId
      || keyEpoch !== pendingHandshake.keyEpoch
      || !phoneSignature
    ) {
      clearPendingHandshake();
      sendControlMessage(createSecureError({
        code: "invalid_client_auth",
        message: "The secure client authentication payload was invalid.",
      }));
      return;
    }

    const clientAuthTranscript = Buffer.concat([
      pendingHandshake.transcriptBytes,
      encodeLengthPrefixedUTF8("client-auth"),
    ]);
    const phoneVerified = verifyTranscript(
      pendingHandshake.phoneIdentityPublicKey,
      clientAuthTranscript,
      phoneSignature
    );
    if (!phoneVerified) {
      clearPendingHandshake();
      sendControlMessage(createSecureError({
        code: "invalid_phone_signature",
        message: "The iPhone secure signature could not be verified.",
      }));
      return;
    }

    if (pendingHandshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) {
      if (!isCurrentPairing(pendingHandshake)) {
        expirePairing(sendControlMessage);
        return;
      }
      pendingHandshake.phase = "awaitingComputer";
      pairingTimer = setTimeout(() => expirePairing(pendingHandshake?.sendControlMessage),
        Math.max(1, pendingHandshake.expiresAtForTranscript - now()));
      pairingTimer.unref?.();
      publishPairingApproval();
      return;
    }
    completeHandshake(sendControlMessage);
  }

  function isCurrentPairing(handshake) {
    return handshake && currentPairingExpiresAt > now()
      && handshake.expiresAtForTranscript === currentPairingExpiresAt
      && handshake.pairingGeneration === pairingGeneration;
  }

  function clearPendingHandshake() {
    clearTimeout(pairingTimer);
    pairingTimer = null;
    const hadApproval = pendingHandshake?.phase !== "authenticating" && pendingHandshake != null;
    pendingHandshake = null;
    if (hadApproval) onPairingApprovalChange?.(null);
  }

  function cancelPendingHandshake() {
    if (pendingHandshake?.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) currentPairingExpiresAt = 0;
    clearPendingHandshake();
    completedPairing = null;
  }

  function expirePairing(sendControlMessage) {
    currentPairingExpiresAt = 0;
    clearPendingHandshake();
    sendControlMessage?.(createSecureError({ code: "pairing_expired", message: "The pairing request expired. Generate a new QR code on the computer." }));
  }

  function getPendingPairingApproval() {
    if (!pendingHandshake || pendingHandshake.phase === "authenticating") return null;
    if (!isCurrentPairing(pendingHandshake)) {
      expirePairing(pendingHandshake.sendControlMessage);
      return null;
    }
    return {
      requestId: pendingHandshake.pairingRequestId,
      fingerprint: createHash("sha256").update(pendingHandshake.transcriptBytes).digest("hex"),
      expiresAt: pendingHandshake.expiresAtForTranscript,
      stage: pendingHandshake.phase,
      replacesTrustedPhone: Object.keys(currentDeviceState.trustedPhones || {}).length > 0,
    };
  }

  function publishPairingApproval() {
    onPairingApprovalChange?.(getPendingPairingApproval());
  }

  function decidePairingApproval({ requestId, fingerprint, decision }) {
    const request = getPendingPairingApproval();
    if (!request || request.requestId !== requestId || (decision === "approve" && fingerprint !== request.fingerprint)) {
      throw new Error("The pairing request or fingerprint no longer matches. Refresh the computer pairing request.");
    }
    if (decision === "reject") {
      const sender = pendingHandshake.sendControlMessage;
      currentPairingExpiresAt = 0;
      clearPendingHandshake();
      sender(createSecureError({ code: "pairing_rejected", message: "Pairing was rejected on the computer. Generate a new QR code to try again." }));
      return { requestId, stage: "rejected" };
    }
    if (decision !== "approve") throw new Error("Unknown pairing decision.");
    if (!pendingHandshake.approvalNonce) pendingHandshake.approvalNonce = randomBytes(32).toString("base64");
    pendingHandshake.phase = "awaitingPhone";
    const approved = {
      kind: "pairingApproved",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId,
      keyEpoch: pendingHandshake.keyEpoch,
      requestId,
      expiresAt: pendingHandshake.expiresAtForTranscript,
      approvalNonce: pendingHandshake.approvalNonce,
      macSignature: signTranscript(currentDeviceState.macIdentityPrivateKey, currentDeviceState.macIdentityPublicKey,
        buildPairingControlTranscript(pendingHandshake.transcriptBytes, "pairing-approved", pendingHandshake.approvalNonce)),
    };
    publishPairingApproval();
    pendingHandshake.sendControlMessage(approved);
    return { requestId, stage: "awaitingPhone" };
  }

  function matchesPairingMessage(message, handshake, label, nonce) {
    return message.sessionId === sessionId && message.keyEpoch === handshake.keyEpoch
      && message.requestId === handshake.pairingRequestId && message.phoneDeviceId === handshake.phoneDeviceId
      && message.approvalNonce === nonce
      && verifyTranscript(handshake.phoneIdentityPublicKey,
        buildPairingControlTranscript(handshake.transcriptBytes, label, nonce), message.phoneSignature);
  }

  function handleClientPairingConfirm(message, sendControlMessage) {
    if (completedPairing && completedPairing.expiresAtForTranscript > now()
      && activeSession?.keyEpoch === completedPairing.keyEpoch
      && matchesPairingMessage(message, completedPairing, "client-pairing-confirm", completedPairing.approvalNonce)) {
      sendControlMessage(completedPairing.ready);
      return;
    }
    if (!pendingHandshake || pendingHandshake.phase !== "awaitingPhone") {
      sendControlMessage(createSecureError({ code: "pairing_approval_required", message: "Approve this pairing on the computer first." }));
      return;
    }
    if (!isCurrentPairing(pendingHandshake)) {
      expirePairing(sendControlMessage);
      return;
    }
    if (!matchesPairingMessage(message, pendingHandshake, "client-pairing-confirm", pendingHandshake.approvalNonce)) {
      sendControlMessage(createSecureError({ code: "invalid_pairing_confirmation", message: "The phone pairing confirmation could not be verified." }));
      return;
    }
    completeHandshake(sendControlMessage);
  }

  function handleClientPairingCancel(message, sendControlMessage) {
    if (!pendingHandshake || pendingHandshake.handshakeMode !== HANDSHAKE_MODE_QR_BOOTSTRAP
      || !matchesPairingMessage(message, pendingHandshake, "client-pairing-cancel", "")) return;
    currentPairingExpiresAt = 0;
    clearPendingHandshake();
    sendControlMessage(createSecureError({ code: "pairing_cancelled", message: "Pairing was cancelled on the iPhone." }));
  }

  function completeHandshake(sendControlMessage) {
    const handshake = pendingHandshake;
    let nextSession;
    let nextDeviceState;
    let ready;
    const previousTrustedPhonePublicKey = getTrustedPhonePublicKey(currentDeviceState, handshake.phoneDeviceId);
    try {
      const sharedSecret = diffieHellman({
        privateKey: createPrivateKey({
          key: {
            crv: "X25519", kty: "OKP",
            d: base64ToBase64Url(handshake.macEphemeralPrivateKey),
            x: base64ToBase64Url(handshake.macEphemeralPublicKey),
          },
          format: "jwk",
        }),
        publicKey: createPublicKey({
          key: { crv: "X25519", kty: "OKP", x: base64ToBase64Url(handshake.phoneEphemeralPublicKey) },
          format: "jwk",
        }),
      });
      const salt = createHash("sha256").update(handshake.transcriptBytes).digest();
      const infoPrefix = [HANDSHAKE_TAG, handshake.sessionId, currentDeviceState.macDeviceId,
        handshake.phoneDeviceId, String(handshake.keyEpoch)].join("|");
      nextSession = {
        sessionId: handshake.sessionId,
        keyEpoch: handshake.keyEpoch,
        phoneDeviceId: handshake.phoneDeviceId,
        phoneIdentityPublicKey: handshake.phoneIdentityPublicKey,
        phoneToMacKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|phoneToMac`),
        macToPhoneKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|macToPhone`),
        lastInboundCounter: -1,
        nextOutboundCounter: 0,
        isResumed: false,
        sendWireMessage: liveSendWireMessage,
        firstOutboundSeq: nextBridgeOutboundSeq,
      };
      ready = {
        kind: "secureReady",
        protocolVersion: SECURE_PROTOCOL_VERSION,
        sessionId,
        keyEpoch: handshake.keyEpoch,
        macDeviceId: currentDeviceState.macDeviceId,
        requestId: handshake.pairingRequestId,
        macSignature: signTranscript(currentDeviceState.macIdentityPrivateKey, currentDeviceState.macIdentityPublicKey,
          buildPairingControlTranscript(handshake.transcriptBytes, "secure-ready", handshake.approvalNonce)),
      };
      // Lock the trusted phone identity so later reconnects can be verified cleanly.
      nextDeviceState = rememberTrustedPhoneImpl(currentDeviceState, handshake.phoneDeviceId,
        handshake.phoneIdentityPublicKey, { persist: persistTrustedPhone });
    } catch {
      if (handshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) currentPairingExpiresAt = 0;
      clearPendingHandshake();
      sendControlMessage(createSecureError({ code: "pairing_failed", message: "The bridge could not securely save or complete this pairing. Try a new pairing request." }));
      return;
    }

    currentDeviceState = nextDeviceState;
    activeSession = nextSession;
    nextKeyEpoch = handshake.keyEpoch + 1;
    if (handshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) {
      resetOutboundReplayState();
      activeSession.firstOutboundSeq = nextBridgeOutboundSeq;
      currentPairingExpiresAt = 0;
      completedPairing = {
        keyEpoch: handshake.keyEpoch,
        phoneDeviceId: handshake.phoneDeviceId,
        phoneIdentityPublicKey: handshake.phoneIdentityPublicKey,
        transcriptBytes: handshake.transcriptBytes,
        pairingRequestId: handshake.pairingRequestId,
        approvalNonce: handshake.approvalNonce,
        expiresAtForTranscript: handshake.expiresAtForTranscript,
        ready,
      };
    } else {
      completedPairing = null;
    }
    clearPendingHandshake();
    // Observer failures cannot roll back a trust record already committed to disk.
    try {
      if (previousTrustedPhonePublicKey !== handshake.phoneIdentityPublicKey) {
        onTrustedPhoneUpdate?.(currentDeviceState, {
          phoneDeviceId: handshake.phoneDeviceId,
          phoneIdentityPublicKey: handshake.phoneIdentityPublicKey,
        });
      }
      onSecureSessionReady?.({ phoneDeviceId: handshake.phoneDeviceId,
        handshakeMode: handshake.handshakeMode, keyEpoch: handshake.keyEpoch });
    } catch {
      debugSecureLog("secure session observer failed after trust was saved");
    }
    sendControlMessage(ready);
  }

  function handleResumeState(message) {
    if (!activeSession) {
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    if (incomingSessionId !== sessionId || keyEpoch !== activeSession.keyEpoch) {
      return;
    }

    const lastAppliedBridgeOutboundSeq = Number(message.lastAppliedBridgeOutboundSeq) || 0;
    const phoneReplayEpoch = normalizeNonEmptyString(message.bridgeReplayEpoch);
    let effectiveReplayCursor = lastAppliedBridgeOutboundSeq;
    activeSession.isResumed = true;
    if (phoneReplayEpoch !== bridgeReplayEpoch || lastAppliedBridgeOutboundSeq >= nextBridgeOutboundSeq) {
      // Sequence numbers are process-local. A trusted phone can reconnect after
      // the bridge restarted with any cursor from the previous process; the
      // explicit epoch catches overlap that numeric comparison cannot detect.
      effectiveReplayCursor = Math.max(0, activeSession.firstOutboundSeq - 1);
      sendBufferedReplayResetMarker(
        activeSession.sendWireMessage,
        effectiveReplayCursor,
        bridgeReplayEpoch
      );
    }
    lastRelayedBridgeOutboundSeq = effectiveReplayCursor;
    let missingEntries = replayableOutboundEntries(effectiveReplayCursor, {
      includeCurrentSessionEntries: true,
    });
    const replayGap = bufferedReplayGapAfter(effectiveReplayCursor);
    if (replayGap) {
      // A partial historical tail is worse than no replay: item-scoped maps no
      // longer exist after relaunch, so applying it can bind deltas/artifacts to
      // unrelated rows. Tell the phone to advance past the discarded history;
      // canonical thread history will rebuild it deterministically.
      sendBufferedReplayGapMarker(activeSession.sendWireMessage, replayGap);
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
      missingEntries = missingEntries.filter((entry) => (
        entry.bridgeOutboundSeq > replayGap.lastDiscardedBridgeOutboundSeq
      ));
    }
    let replayedHistoricalBacklog = false;
    for (const entry of missingEntries) {
      const outboundEntry = replayTaggedEntryIfHistorical(entry);
      if (!sendBufferedEntry(outboundEntry, activeSession.sendWireMessage)) {
        return;
      }
      if (outboundEntry !== entry) {
        replayedHistoricalBacklog = true;
      }
    }
    if (replayedHistoricalBacklog) {
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
    }
  }

  function handleEncryptedEnvelope(message, sendControlMessage, onApplicationMessage) {
    if (!activeSession) {
      sendControlMessage(createSecureError({
        code: "secure_channel_unavailable",
        message: "The secure channel is not ready yet on the bridge.",
      }));
      return true;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    const sender = normalizeNonEmptyString(message.sender);
    const counter = Number(message.counter);
    if (
      incomingSessionId !== sessionId
      || keyEpoch !== activeSession.keyEpoch
      || sender !== SECURE_SENDER_IPHONE
      || !Number.isInteger(counter)
      || counter <= activeSession.lastInboundCounter
    ) {
      sendControlMessage(createSecureError({
        code: "invalid_envelope",
        message: "The bridge rejected an invalid or replayed secure envelope.",
      }));
      return true;
    }

    const plaintextBuffer = decryptEnvelopeBuffer(message, activeSession.phoneToMacKey, SECURE_SENDER_IPHONE, counter);
    if (!plaintextBuffer) {
      sendControlMessage(createSecureError({
        code: "decrypt_failed",
        message: "The bridge could not decrypt the iPhone secure payload.",
      }));
      return true;
    }

    activeSession.lastInboundCounter = counter;
    const payloadObject = safeParseJSON(plaintextBuffer.toString("utf8"));
    const payloadText = normalizeNonEmptyString(payloadObject?.payloadText);
    if (!payloadText) {
      sendControlMessage(createSecureError({
        code: "invalid_payload",
        message: "The secure payload did not contain a usable application message.",
      }));
      return true;
    }

    onApplicationMessage(payloadText);
    return true;
  }

  function bindLiveSendWireMessage(sendWireMessage) {
    liveSendWireMessage = sendWireMessage;
    if (activeSession) {
      activeSession.sendWireMessage = sendWireMessage;
      replayBufferedOutboundMessages();
    }
  }

  function trimOutboundBuffer() {
    let removeCount = 0;
    let removedBytes = 0;
    while (
      (outboundBuffer.length - removeCount) > MAX_BRIDGE_OUTBOUND_MESSAGES
      || (outboundBufferBytes - removedBytes) > MAX_BRIDGE_OUTBOUND_BYTES
    ) {
      const entry = outboundBuffer[removeCount];
      if (!entry) {
        break;
      }
      removedBytes += entry.sizeBytes;
      removeCount += 1;
    }
    if (removeCount > 0) {
      outboundBuffer.splice(0, removeCount);
      outboundBufferBytes = Math.max(0, outboundBufferBytes - removedBytes);
    }
  }

  // Starts each fresh QR bootstrap with a clean catch-up window for the single trusted phone.
  function resetOutboundReplayState() {
    outboundBuffer.length = 0;
    outboundBufferBytes = 0;
    lastRelayedBridgeOutboundSeq = 0;
    nextBridgeOutboundSeq = 1;
  }

  function sendBufferedEntry(entry, sendWireMessage) {
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return false;
    }

    const envelope = encryptEnvelopePayload(
      {
        bridgeOutboundSeq: entry.bridgeOutboundSeq,
        payloadText: entry.payloadText,
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      sessionId,
      activeSession.keyEpoch
    );
    activeSession.nextOutboundCounter += 1;
    return sendWireMessage(JSON.stringify(envelope)) !== false;
  }

  function replayableOutboundEntries(
    lastAppliedBridgeOutboundSeq,
    { includeCurrentSessionEntries = false } = {}
  ) {
    return outboundBuffer.filter((entry) => {
      if (entry.bridgeOutboundSeq > lastAppliedBridgeOutboundSeq) {
        return true;
      }

      // Stale cursors from a previous Mac/session must not suppress responses
      // produced after this secure channel became active, including initialize.
      return includeCurrentSessionEntries
        && activeSession
        && entry.bridgeOutboundSeq >= activeSession.firstOutboundSeq;
    });
  }

  // Replays from the last phone ack instead of local socket writes, so a relay
  // flap cannot make the bridge skip output the phone never actually received.
  function replayBufferedOutboundMessages() {
    if (!activeSession?.isResumed || typeof activeSession.sendWireMessage !== "function") {
      return;
    }

    let replayEntries = replayableOutboundEntries(lastRelayedBridgeOutboundSeq);
    const replayGap = bufferedReplayGapAfter(lastRelayedBridgeOutboundSeq);
    if (replayGap) {
      sendBufferedReplayGapMarker(activeSession.sendWireMessage, replayGap);
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
      replayEntries = replayEntries.filter((entry) => (
        entry.bridgeOutboundSeq > replayGap.lastDiscardedBridgeOutboundSeq
      ));
    }

    let replayedHistoricalBacklog = false;
    for (const entry of replayEntries) {
      const outboundEntry = replayTaggedEntryIfHistorical(entry);
      if (!sendBufferedEntry(outboundEntry, activeSession.sendWireMessage)) {
        return;
      }
      if (outboundEntry !== entry) {
        replayedHistoricalBacklog = true;
      }
    }
    if (replayedHistoricalBacklog) {
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
    }
  }

  function bufferedReplayGapAfter(lastAppliedBridgeOutboundSeq) {
    const firstUnappliedEntry = outboundBuffer.find((entry) => (
      entry.bridgeOutboundSeq > lastAppliedBridgeOutboundSeq
    ));
    if (!firstUnappliedEntry
      || firstUnappliedEntry.bridgeOutboundSeq <= lastAppliedBridgeOutboundSeq + 1) {
      return null;
    }

    const lastAvailableBridgeOutboundSeq = outboundBuffer[outboundBuffer.length - 1]?.bridgeOutboundSeq
      || firstUnappliedEntry.bridgeOutboundSeq;
    const historicalBoundary = (activeSession?.firstOutboundSeq || firstUnappliedEntry.bridgeOutboundSeq) - 1;
    const lastDiscardedBridgeOutboundSeq = firstUnappliedEntry.bridgeOutboundSeq <= historicalBoundary
      ? historicalBoundary
      : lastAvailableBridgeOutboundSeq;
    return {
      expectedBridgeOutboundSeq: lastAppliedBridgeOutboundSeq + 1,
      firstAvailableBridgeOutboundSeq: firstUnappliedEntry.bridgeOutboundSeq,
      lastDiscardedBridgeOutboundSeq: Math.max(lastAppliedBridgeOutboundSeq, lastDiscardedBridgeOutboundSeq),
    };
  }

  function sendBufferedReplayGapMarker(sendWireMessage, replayGap) {
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function" || !replayGap) {
      return;
    }

    const envelope = encryptEnvelopePayload(
      {
        payloadText: JSON.stringify({
          method: "remodex/bufferedReplay/gap",
          params: {
            remodexBufferedReplayGap: true,
            ...replayGap,
          },
        }),
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      sessionId,
      activeSession.keyEpoch
    );
    activeSession.nextOutboundCounter += 1;
    sendWireMessage(JSON.stringify(envelope));
  }

  function sendBufferedReplayResetMarker(
    sendWireMessage,
    resetBridgeOutboundSeqTo,
    replayEpoch
  ) {
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return;
    }

    const envelope = encryptEnvelopePayload(
      {
        payloadText: JSON.stringify({
          method: "remodex/bufferedReplay/reset",
          params: {
            remodexBufferedReplayReset: true,
            resetBridgeOutboundSeqTo,
            bridgeReplayEpoch: replayEpoch,
          },
        }),
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      sessionId,
      activeSession.keyEpoch
    );
    activeSession.nextOutboundCounter += 1;
    sendWireMessage(JSON.stringify(envelope));
  }

  // Closes a replayed-backlog burst deterministically: the phone batches tagged
  // catch-up events and settles its timeline once on this marker instead of
  // waiting out a debounce. Sent transiently (no bridgeOutboundSeq, never
  // buffered) so it cannot occupy replay-buffer space or be replayed itself.
  function sendBufferedReplayCompleteMarker(sendWireMessage) {
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return;
    }

    const envelope = encryptEnvelopePayload(
      {
        payloadText: JSON.stringify({
          method: "remodex/bufferedReplay/completed",
          params: { remodexBufferedReplayComplete: true },
        }),
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      sessionId,
      activeSession.keyEpoch
    );
    activeSession.nextOutboundCounter += 1;
    sendWireMessage(JSON.stringify(envelope));
  }

  // Only prior secure-session backlog is catch-up history; same-session retries
  // may be the phone's first delivery of a still-live turn.
  function replayTaggedEntryIfHistorical(entry) {
    if (
      !activeSession
      || entry.bridgeOutboundSeq >= activeSession.firstOutboundSeq
    ) {
      return entry;
    }

    return replayTaggedEntry(entry);
  }

  // Marks replayed notifications so the phone applies them as catch-up content
  // instead of live activity; replay must never revive running/streaming UI.
  // RPC responses (id-bearing) and non-object params pass through untouched.
  function replayTaggedEntry(entry) {
    const parsed = safeParseJSON(entry.payloadText);
    if (
      !parsed
      || typeof parsed.method !== "string"
      || parsed.id !== undefined
      || !parsed.params
      || typeof parsed.params !== "object"
      || Array.isArray(parsed.params)
    ) {
      return entry;
    }

    parsed.params.remodexReplayedEvent = true;
    return {
      bridgeOutboundSeq: entry.bridgeOutboundSeq,
      payloadText: JSON.stringify(parsed),
      sizeBytes: entry.sizeBytes,
    };
  }

  return {
    PAIRING_QR_VERSION,
    SECURE_PROTOCOL_VERSION,
    bindLiveSendWireMessage,
    cancelPendingHandshake,
    createPairingPayload,
    decidePairingApproval,
    getPendingPairingApproval,
    handleIncomingWireMessage,
    isSecureChannelReady,
    queueOutboundApplicationMessage,
  };
}

function debugSecureLog(message) {
  console.log(`[remodex][secure] ${message}`);
}

function shortId(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 8) : "none";
}

function shortFingerprint(publicKeyBase64) {
  const bytes = base64ToBuffer(publicKeyBase64);
  if (!bytes || bytes.length === 0) {
    return "invalid";
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function transcriptDigest(transcriptBytes) {
  return createHash("sha256").update(transcriptBytes).digest("hex").slice(0, 16);
}

function encryptEnvelopePayload(payloadObject, key, sender, counter, sessionId, keyEpoch) {
  const nonce = nonceForDirection(sender, counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    kind: "encryptedEnvelope",
    v: SECURE_PROTOCOL_VERSION,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptEnvelopeBuffer(envelope, key, sender, counter) {
  try {
    const nonce = nonceForDirection(sender, counter);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(base64ToBuffer(envelope.tag));
    return Buffer.concat([
      decipher.update(base64ToBuffer(envelope.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

function deriveAesKey(sharedSecret, salt, infoLabel) {
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(infoLabel, "utf8"), 32));
}

function signTranscript(privateKeyBase64, publicKeyBase64, transcriptBytes) {
  const signature = sign(
    null,
    transcriptBytes,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(privateKeyBase64),
        kty: "OKP",
        x: base64ToBase64Url(publicKeyBase64),
      },
      format: "jwk",
    })
  );
  return signature.toString("base64");
}

function verifyTranscript(publicKeyBase64, transcriptBytes, signatureBase64) {
  try {
    return verify(
      null,
      transcriptBytes,
      createPublicKey({
        key: {
          crv: "Ed25519",
          kty: "OKP",
          x: base64ToBase64Url(publicKeyBase64),
        },
        format: "jwk",
      }),
      base64ToBuffer(signatureBase64)
    );
  } catch {
    return false;
  }
}

function buildTranscriptBytes({
  sessionId,
  protocolVersion,
  handshakeMode,
  keyEpoch,
  macDeviceId,
  phoneDeviceId,
  macIdentityPublicKey,
  phoneIdentityPublicKey,
  macEphemeralPublicKey,
  phoneEphemeralPublicKey,
  clientNonce,
  serverNonce,
  expiresAtForTranscript,
  pairingRequestId = "",
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8(HANDSHAKE_TAG),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(base64ToBuffer(macIdentityPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneIdentityPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(macEphemeralPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneEphemeralPublicKey)),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
    encodeLengthPrefixedUTF8(pairingRequestId),
  ]);
}

function buildPairingControlTranscript(transcriptBytes, label, approvalNonce = "") {
  return Buffer.concat([transcriptBytes, encodeLengthPrefixedUTF8(label), encodeLengthPrefixedBuffer(Buffer.from(approvalNonce, "base64"))]);
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedBuffer(Buffer.from(String(value), "utf8"));
}

function encodeLengthPrefixedBuffer(buffer) {
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([lengthBuffer, buffer]);
}

function nonceForDirection(sender, counter) {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeUInt8(sender === SECURE_SENDER_MAC ? 1 : 2, 0);
  let value = BigInt(counter);
  for (let index = 11; index >= 1; index -= 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

function createSecureError({ code, message }) {
  return {
    kind: "secureError",
    code,
    message,
  };
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function safeParseJSON(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function base64ToBuffer(value) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToBase64Url(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

module.exports = {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  PAIRING_QR_VERSION,
  SECURE_PROTOCOL_VERSION,
  createBridgeSecureTransport,
  buildTranscriptBytes,
  buildPairingControlTranscript,
  nonceForDirection,
};
