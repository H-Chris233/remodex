// FILE: secure-transport.test.js
// Purpose: Verifies the bridge-side E2EE handshake rejects plaintext and round-trips encrypted payloads.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, crypto, ../src/secure-transport

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
} = require("crypto");
const {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  SECURE_PROTOCOL_VERSION,
  createBridgeSecureTransport,
  nonceForDirection,
  buildPairingControlTranscript,
} = require("../src/secure-transport");

// Keeps unit handshakes from mutating the real Mac pairing trust store.
function createTestBridgeSecureTransport(options) {
  return createBridgeSecureTransport({
    ...options,
    persistTrustedPhone: false,
  });
}

test("secure transport rejects plaintext JSON-RPC before the secure handshake", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-1",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-1",
      macIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
      macIdentityPublicKey: base64UrlToBase64(publicJwk.x),
      trustedPhones: {},
    },
  });

  const controlMessages = [];
  const handled = secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      id: "1",
      method: "initialize",
      params: {},
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("plaintext application payload should not be forwarded");
      },
    }
  );

  assert.equal(handled, true);
  assert.equal(controlMessages[0]?.kind, "secureError");
  assert.equal(controlMessages[0]?.code, "update_required");
});

test("secure transport round-trips encrypted payloads after a trusted reconnect handshake", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-2",
    relayUrl: "wss://relay.example/relay",
    displayName: "Desk Mac",
    deviceState: {
      macDeviceId: "mac-2",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {
        "phone-2": phoneIdentity.publicKey,
      },
    },
  });

  const controlMessages = [];
  const applicationMessages = [];
  const wireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    wireMessages.push(message);
  });

  const clientNonce = Buffer.alloc(32, 7);
  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId: "session-2",
      handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
      phoneDeviceId: "phone-2",
      phoneIdentityPublicKey: phoneIdentity.publicKey,
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      clientNonce: clientNonce.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(serverHello, "expected serverHello");
  assert.equal(serverHello.displayName, "Desk Mac");

  const transcriptBytes = buildTranscriptBytes({
    sessionId: "session-2",
    protocolVersion: SECURE_PROTOCOL_VERSION,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId: "mac-2",
    phoneDeviceId: "phone-2",
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: 0,
  });
  const phoneAuthTranscript = Buffer.concat([
    transcriptBytes,
    encodeLengthPrefixedUTF8("client-auth"),
  ]);
  const phoneSignature = sign(
    null,
    phoneAuthTranscript,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(phoneIdentity.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneIdentity.publicKey),
      },
      format: "jwk",
    })
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId: "session-2",
      phoneDeviceId: "phone-2",
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: phoneSignature.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(secureReady, "expected secureReady");

  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `remodex-e2ee-v1|session-2|mac-2|phone-2|${serverHello.keyEpoch}`;
  const phoneToMacKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|phoneToMac`, "utf8"), 32)
  );
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-2",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
      bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-1", result: { ok: true } }),
    (message) => {
      wireMessages.push(message);
    }
  );
  assert.equal(wireMessages.length, 1);

  const outboundEnvelope = JSON.parse(wireMessages[0]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "response-1", result: { ok: true } }));

  const inboundEnvelope = encryptEnvelope(
    {
      payloadText: JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
    },
    phoneToMacKey,
    "iphone",
    0,
    "session-2",
    serverHello.keyEpoch
  );
  secureTransport.handleIncomingWireMessage(
    JSON.stringify(inboundEnvelope),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  assert.deepEqual(applicationMessages, [
    JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
  ]);
});

test("qr bootstrap replaces the trusted iPhone only after both local confirmations", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const firstPhoneIdentity = createOkpKeyPair("ed25519");
  const firstPhoneEphemeral = createOkpKeyPair("x25519");
  const secondPhoneIdentity = createOkpKeyPair("ed25519");
  const secondPhoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-3",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-3",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-3",
    macDeviceId: "mac-3",
    phoneDeviceId: "phone-3a",
    macIdentity,
    phoneIdentity: firstPhoneIdentity,
    phoneEphemeral: firstPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-3",
    macDeviceId: "mac-3",
    phoneDeviceId: "phone-3b",
    macIdentity,
    phoneIdentity: secondPhoneIdentity,
    phoneEphemeral: secondPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });
});

test("qr bootstrap starts a fresh replay window instead of leaking buffered messages", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const firstEphemeral = createOkpKeyPair("x25519");
  const secondEphemeral = createOkpKeyPair("x25519");
  const wireMessages = [];
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-4",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-4",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });
  secureTransport.bindLiveSendWireMessage((message) => {
    wireMessages.push(message);
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: firstEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "stale-response", result: { ok: true } }),
    (message) => {
      wireMessages.push(message);
    }
  );
  assert.equal(wireMessages.length, 1);

  finishHandshake({
    secureTransport,
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: secondEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  assert.equal(wireMessages.length, 1);
});

test("rebinding the relay socket replays bridge output from the last phone ack", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-5",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-5",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-5",
    macDeviceId: "mac-5",
    phoneDeviceId: "phone-5",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `remodex-e2ee-v1|session-5|mac-5|phone-5|${serverHello.keyEpoch}`;
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  secureTransport.bindLiveSendWireMessage(() => false);
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-5", result: { ok: true } }),
    () => false
  );

  const firstRecoveryWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    firstRecoveryWireMessages.push(message);
    return true;
  });

  assert.equal(firstRecoveryWireMessages.length, 1);
  const outboundEnvelope = JSON.parse(firstRecoveryWireMessages[0]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "response-5", result: { ok: true } }));

  const liveWireMessages = [];
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-6", result: { ok: true } }),
    () => {
      throw new Error("expected active relay sender to handle resumed output");
    }
  );

  secureTransport.bindLiveSendWireMessage((message) => {
    liveWireMessages.push(message);
    return true;
  });

  assert.equal(liveWireMessages.length, 2);
  const replayedPayloads = liveWireMessages.map((message) => {
    const envelope = JSON.parse(message);
    return decryptEnvelope(envelope, macToPhoneKey);
  });
  assert.deepEqual(
    replayedPayloads.map((payload) => payload.bridgeOutboundSeq),
    [1, 2]
  );
});

test("same-session relay replays keep live notifications untagged", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-replay-tag",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-replay-tag",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-replay-tag",
    macDeviceId: "mac-replay-tag",
    phoneDeviceId: "phone-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-replay-tag",
    macDeviceId: "mac-replay-tag",
    phoneDeviceId: "phone-replay-tag",
    phoneEphemeral,
    serverHello,
    transcriptBytes,
  });

  const liveWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    liveWireMessages.push(message);
    return true;
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ method: "turn/started", params: { threadId: "thread-live" } }),
    () => false
  );
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-live", result: { ok: true } }),
    () => false
  );

  assert.equal(liveWireMessages.length, 2);
  const livePayload = decryptEnvelope(JSON.parse(liveWireMessages[0]), macToPhoneKey);
  assert.equal(
    JSON.parse(livePayload.payloadText).params.remodexReplayedEvent,
    undefined
  );

  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    replayWireMessages.push(message);
    return true;
  });

  assert.equal(replayWireMessages.length, 2);
  const replayedNotification = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const replayedNotificationPayload = JSON.parse(replayedNotification.payloadText);
  assert.equal(replayedNotificationPayload.method, "turn/started");
  assert.equal(replayedNotificationPayload.params.threadId, "thread-live");
  assert.equal(replayedNotificationPayload.params.remodexReplayedEvent, undefined);

  const replayedResponse = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  assert.equal(
    replayedResponse.payloadText,
    JSON.stringify({ id: "response-live", result: { ok: true } })
  );
});

test("previous-session replayed notifications are tagged as catch-up history", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-previous-replay-tag",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-previous-replay-tag",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  let captureReplay = false;
  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    if (captureReplay) {
      replayWireMessages.push(message);
    }
    return true;
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ method: "turn/started", params: { threadId: "thread-previous-session" } }),
    () => false
  );

  const reconnectEphemeral = createOkpKeyPair("x25519");
  captureReplay = true;
  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: reconnectEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
  });

  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    phoneEphemeral: reconnectEphemeral,
    serverHello,
    transcriptBytes,
  });
  // Historical backlog replay closes with a transient completion marker so the
  // phone can settle its catch-up burst deterministically.
  assert.equal(replayWireMessages.length, 2);
  const replayedNotification = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const replayedNotificationPayload = JSON.parse(replayedNotification.payloadText);
  assert.equal(replayedNotificationPayload.method, "turn/started");
  assert.equal(replayedNotificationPayload.params.threadId, "thread-previous-session");
  assert.equal(replayedNotificationPayload.params.remodexReplayedEvent, true);

  const completionMarker = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  // Transient marker: no bridgeOutboundSeq, so it never advances the phone ack
  // cursor and is never re-replayed from the buffer.
  assert.equal(completionMarker.bridgeOutboundSeq, undefined);
  const completionMarkerPayload = JSON.parse(completionMarker.payloadText);
  assert.equal(completionMarkerPayload.method, "remodex/bufferedReplay/completed");
  assert.equal(completionMarkerPayload.params.remodexBufferedReplayComplete, true);
});

test("truncated resume replay discards the partial tail and declares a canonical-history gap", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-truncated-replay",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-truncated-replay",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });
  let captureReplay = false;
  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    if (captureReplay) {
      replayWireMessages.push(message);
    }
    return true;
  });
  for (let index = 1; index <= 501; index += 1) {
    secureTransport.queueOutboundApplicationMessage(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-truncated-replay", itemId: `item-${index}` },
      }),
      () => false
    );
  }

  const reconnectEphemeral = createOkpKeyPair("x25519");
  captureReplay = true;
  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: reconnectEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
  });
  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    phoneEphemeral: reconnectEphemeral,
    serverHello,
    transcriptBytes,
  });

  assert.equal(replayWireMessages.length, 2);
  const gapPayload = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const gapMessage = JSON.parse(gapPayload.payloadText);
  assert.equal(gapPayload.bridgeOutboundSeq, undefined);
  assert.equal(gapMessage.method, "remodex/bufferedReplay/gap");
  assert.deepEqual(gapMessage.params, {
    remodexBufferedReplayGap: true,
    expectedBridgeOutboundSeq: 1,
    firstAvailableBridgeOutboundSeq: 2,
    lastDiscardedBridgeOutboundSeq: 501,
  });
  const completionPayload = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  assert.equal(
    JSON.parse(completionPayload.payloadText).params.remodexBufferedReplayComplete,
    true
  );
});

test("resume replay does not advance the replay watermark before a phone ack", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-6",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-6",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const initialReplayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    initialReplayWireMessages.push(message);
    return true;
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-6",
    macDeviceId: "mac-6",
    phoneDeviceId: "phone-6",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    skipResumeState: true,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-6", result: { ok: true } }),
    () => {
      throw new Error("expected bound sender to stay attached after secureReady");
    }
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-6",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
      bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
    }),
    {
      sendControlMessage() {},
      onApplicationMessage() {},
    }
  );

  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `remodex-e2ee-v1|session-6|mac-6|phone-6|${serverHello.keyEpoch}`;
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  assert.equal(initialReplayWireMessages.length, 1);

  const reboundWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    reboundWireMessages.push(message);
    return true;
  });

  assert.equal(reboundWireMessages.length, 1);
  const reboundEnvelope = JSON.parse(reboundWireMessages[0]);
  const reboundPayload = decryptEnvelope(reboundEnvelope, macToPhoneKey);
  assert.equal(reboundPayload.bridgeOutboundSeq, 1);
  assert.equal(reboundPayload.payloadText, JSON.stringify({ id: "response-6", result: { ok: true } }));
});

test("resume replay resets overlapping sequence numbers from a previous bridge epoch", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "session-7",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-7",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {
        "phone-7": phoneIdentity.publicKey,
      },
    },
  });

  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    replayWireMessages.push(message);
    return true;
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-7",
    macDeviceId: "mac-7",
    phoneDeviceId: "phone-7",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
    skipResumeState: true,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "initialize", result: { ok: true } }),
    () => {
      throw new Error("expected buffered initialize response to wait for resumeState");
    }
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-7",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 1,
      bridgeReplayEpoch: "previous-bridge-process",
    }),
    {
      sendControlMessage() {},
      onApplicationMessage() {},
    }
  );

  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-7",
    macDeviceId: "mac-7",
    phoneDeviceId: "phone-7",
    phoneEphemeral,
    serverHello,
    transcriptBytes,
  });
  assert.equal(replayWireMessages.length, 2);
  const resetEnvelope = JSON.parse(replayWireMessages[0]);
  const resetPayload = decryptEnvelope(resetEnvelope, macToPhoneKey);
  const resetMessage = JSON.parse(resetPayload.payloadText);
  assert.equal(resetPayload.bridgeOutboundSeq, undefined);
  assert.equal(resetMessage.method, "remodex/bufferedReplay/reset");
  assert.deepEqual(resetMessage.params, {
    remodexBufferedReplayReset: true,
    resetBridgeOutboundSeqTo: 0,
    bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
  });

  const outboundEnvelope = JSON.parse(replayWireMessages[1]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(resetEnvelope.counter < outboundEnvelope.counter, true);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "initialize", result: { ok: true } }));
});

function finishHandshake({
  secureTransport,
  sessionId,
  macDeviceId,
  phoneDeviceId,
  macIdentity,
  phoneIdentity,
  phoneEphemeral,
  handshakeMode,
  lastAppliedBridgeOutboundSeq,
  skipResumeState = false,
  pauseBeforeApproval = false,
  pauseBeforeAuth = false,
}) {
  const controlMessages = [];
  const applicationMessages = [];
  const clientNonce = Buffer.alloc(32, 7);
  if (handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) secureTransport.createPairingPayload();

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId,
      handshakeMode,
      phoneDeviceId,
      phoneIdentityPublicKey: phoneIdentity.publicKey,
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      clientNonce: clientNonce.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(serverHello, "expected serverHello");

  const transcriptBytes = buildTranscriptBytes({
    sessionId,
    protocolVersion: SECURE_PROTOCOL_VERSION,
    handshakeMode,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId,
    phoneDeviceId,
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: serverHello.expiresAtForTranscript,
    pairingRequestId: serverHello.pairingRequestId,
  });
  const phoneAuthTranscript = Buffer.concat([
    transcriptBytes,
    encodeLengthPrefixedUTF8("client-auth"),
  ]);
  const phoneSignature = sign(
    null,
    phoneAuthTranscript,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(phoneIdentity.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneIdentity.publicKey),
      },
      format: "jwk",
    })
  );

  const clientAuth = { kind: "clientAuth", sessionId, phoneDeviceId, keyEpoch: serverHello.keyEpoch, phoneSignature: phoneSignature.toString("base64") };
  if (pauseBeforeAuth) return { applicationMessages, controlMessages, serverHello, transcriptBytes, clientAuth };

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId,
      phoneDeviceId,
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: phoneSignature.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  let approvalNonce = "";
  if (handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) {
    assert.equal(controlMessages.some((message) => message.kind === "secureReady"), false);
    const request = secureTransport.getPendingPairingApproval();
    assert.ok(request);
    assert.equal(request.fingerprint, createHash("sha256").update(transcriptBytes).digest("hex"));
    if (pauseBeforeApproval) return { applicationMessages, controlMessages, serverHello, transcriptBytes, request };
    secureTransport.decidePairingApproval({ ...request, decision: "approve" });
    const approved = controlMessages.find((message) => message.kind === "pairingApproved");
    approvalNonce = approved.approvalNonce;
    assert.equal(controlMessages.some((message) => message.kind === "secureReady"), false);
    secureTransport.handleIncomingWireMessage(JSON.stringify({
      kind: "clientPairingConfirm", sessionId, phoneDeviceId, keyEpoch: serverHello.keyEpoch,
      requestId: request.requestId, approvalNonce,
      phoneSignature: signIdentity(phoneIdentity, buildPairingControlTranscript(transcriptBytes, "client-pairing-confirm", approvalNonce)),
    }), { sendControlMessage: (message) => controlMessages.push(message), onApplicationMessage: (message) => applicationMessages.push(message) });
  }
  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(secureReady, "expected secureReady");
  assert.equal(verify(null, buildPairingControlTranscript(transcriptBytes, "secure-ready", approvalNonce),
    createPublicKey({ key: { crv: "Ed25519", kty: "OKP", x: base64ToBase64Url(macIdentity.publicKey) }, format: "jwk" }),
    Buffer.from(secureReady.macSignature, "base64")), true);

  if (!skipResumeState) {
    secureTransport.handleIncomingWireMessage(
      JSON.stringify({
        kind: "resumeState",
        sessionId,
        keyEpoch: serverHello.keyEpoch,
        lastAppliedBridgeOutboundSeq,
        bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
      }),
      {
        sendControlMessage(message) {
          controlMessages.push(message);
        },
        onApplicationMessage(message) {
          applicationMessages.push(message);
        },
      }
    );
  }

  return { applicationMessages, controlMessages, serverHello, transcriptBytes };
}

function createOkpKeyPair(type) {
  const { privateKey, publicKey } = generateKeyPairSync(type);
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateKey: base64UrlToBase64(privateJwk.d),
    publicKey: base64UrlToBase64(publicJwk.x),
  };
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
    encodeLengthPrefixedUTF8("remodex-e2ee-v1"),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(Buffer.from(macIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(macEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
    encodeLengthPrefixedUTF8(pairingRequestId),
  ]);
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedBuffer(Buffer.from(value, "utf8"));
}

function encodeLengthPrefixedBuffer(buffer) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

function encryptEnvelope(payloadObject, key, sender, counter, sessionId, keyEpoch) {
  const nonce = nonceForDirection(sender, counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);
  return {
    kind: "encryptedEnvelope",
    v: 1,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptEnvelope(envelope, key) {
  const nonce = nonceForDirection(envelope.sender, envelope.counter);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function deriveMacToPhoneKey({
  sessionId,
  macDeviceId,
  phoneDeviceId,
  phoneEphemeral,
  serverHello,
  transcriptBytes,
}) {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `remodex-e2ee-v1|${sessionId}|${macDeviceId}|${phoneDeviceId}|${serverHello.keyEpoch}`;
  return Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );
}

function base64UrlToBase64(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToBase64Url(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function signIdentity(identity, bytes) {
  return sign(null, bytes, createPrivateKey({
    key: { crv: "Ed25519", kty: "OKP", d: base64ToBase64Url(identity.privateKey), x: base64ToBase64Url(identity.publicKey) }, format: "jwk",
  })).toString("base64");
}

function pendingPairing(options = {}) {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const updates = [];
  const secureTransport = createTestBridgeSecureTransport({
    sessionId: "approval-session", relayUrl: "ws://127.0.0.1/relay",
    deviceState: { macDeviceId: "approval-mac", macIdentityPrivateKey: macIdentity.privateKey, macIdentityPublicKey: macIdentity.publicKey, trustedPhones: {} },
    onTrustedPhoneUpdate: (state) => updates.push(state), ...options,
  });
  const exchange = finishHandshake({ secureTransport, macIdentity, phoneIdentity, phoneEphemeral,
    sessionId: "approval-session", macDeviceId: "approval-mac", phoneDeviceId: "approval-phone",
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP, pauseBeforeApproval: true, pauseBeforeAuth: options.pauseBeforeAuth === true });
  const send = (message) => secureTransport.handleIncomingWireMessage(JSON.stringify(message), {
    sendControlMessage: (response) => exchange.controlMessages.push(response),
    onApplicationMessage: (payload) => exchange.applicationMessages.push(payload),
  });
  const confirm = (nonce, overrides = {}) => ({
    kind: "clientPairingConfirm", sessionId: "approval-session", phoneDeviceId: "approval-phone",
    keyEpoch: exchange.serverHello.keyEpoch, requestId: exchange.request.requestId, approvalNonce: nonce,
    phoneSignature: signIdentity(phoneIdentity, buildPairingControlTranscript(exchange.transcriptBytes, "client-pairing-confirm", nonce)), ...overrides,
  });
  const approve = () => {
    secureTransport.decidePairingApproval({ ...exchange.request, decision: "approve" });
    return exchange.controlMessages.findLast((message) => message.kind === "pairingApproved").approvalNonce;
  };
  return { ...exchange, secureTransport, updates, phoneIdentity, phoneEphemeral, macIdentity, send, confirm, approve };
}

test("relay-selected keys cannot gain a session or invoke RPC before both approvals", () => {
  const h = pendingPairing();
  h.send(h.confirm(Buffer.alloc(32, 1).toString("base64")));
  h.send({ kind: "resumeState", sessionId: "approval-session", keyEpoch: h.serverHello.keyEpoch });
  h.send({ kind: "encryptedEnvelope", sessionId: "approval-session", keyEpoch: h.serverHello.keyEpoch });
  assert.equal(h.secureTransport.isSecureChannelReady(), false);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.applicationMessages, []);
  const nonce = h.approve();
  h.send({ kind: "encryptedEnvelope", sessionId: "approval-session", keyEpoch: h.serverHello.keyEpoch });
  assert.equal(h.controlMessages.at(-1).code, "secure_channel_unavailable");
  assert.deepEqual(h.updates, []);
  h.send(h.confirm(nonce));
  assert.equal(h.controlMessages.at(-1).kind, "secureReady");
  assert.equal(h.updates.length, 1);
  h.secureTransport.cancelPendingHandshake();
});

test("fingerprint, nonce, signature and request mismatches cannot finalize pairing", () => {
  const h = pendingPairing();
  assert.throws(() => h.secureTransport.decidePairingApproval({ ...h.request, decision: "approve", fingerprint: "0".repeat(64) }), /fingerprint/);
  const nonce = h.approve();
  const invalid = [h.confirm(Buffer.alloc(32, 2).toString("base64")), h.confirm(nonce, { requestId: "0".repeat(32) }),
    h.confirm(nonce, { sessionId: "other-session" }), h.confirm(nonce, { phoneSignature: Buffer.alloc(64).toString("base64") })];
  for (const message of invalid) {
    h.send(message);
    assert.equal(h.controlMessages.at(-1).code, "invalid_pairing_confirmation");
    assert.equal(h.updates.length, 0);
  }
  h.secureTransport.cancelPendingHandshake();
});

test("late confirmations and old local decisions fail after expiry, rejection, rotation or disconnect", () => {
  for (const reason of ["expiry", "reject", "rotate", "disconnect"]) {
    let clock = Date.now();
    const h = pendingPairing({ now: () => clock });
    const nonce = h.approve();
    if (reason === "expiry") clock = h.request.expiresAt;
    if (reason === "reject") h.secureTransport.decidePairingApproval({ requestId: h.request.requestId, decision: "reject" });
    if (reason === "rotate") h.secureTransport.createPairingPayload();
    if (reason === "disconnect") h.secureTransport.cancelPendingHandshake();
    h.send(h.confirm(nonce));
    assert.equal(h.updates.length, 0, reason);
    assert.notEqual(h.controlMessages.at(-1).kind, "secureReady", reason);
    assert.throws(() => h.secureTransport.decidePairingApproval({ ...h.request, decision: "approve" }), /no longer matches/);
    h.secureTransport.cancelPendingHandshake();
  }
});

test("concurrent hello cannot replace the fingerprint being approved", () => {
  const h = pendingPairing();
  h.send({ kind: "clientHello", protocolVersion: 3, sessionId: "approval-session", handshakeMode: "qr_bootstrap",
    phoneDeviceId: "another-phone", phoneIdentityPublicKey: h.phoneIdentity.publicKey,
    phoneEphemeralPublicKey: h.phoneEphemeral.publicKey, clientNonce: Buffer.alloc(32, 9).toString("base64") });
  assert.equal(h.controlMessages.at(-1).code, "pairing_busy");
  assert.deepEqual(h.secureTransport.getPendingPairingApproval(), h.request);
  h.secureTransport.cancelPendingHandshake();
});

test("duplicate confirmations return the same receipt without installing or persisting twice", () => {
  const h = pendingPairing();
  const wire = [];
  h.secureTransport.bindLiveSendWireMessage((message) => wire.push(JSON.parse(message)));
  const nonce = h.approve();
  assert.equal(h.approve(), nonce);
  const message = h.confirm(nonce);
  h.send(message);
  const ready = h.controlMessages.at(-1);
  h.send({ kind: "resumeState", sessionId: "approval-session", keyEpoch: ready.keyEpoch, bridgeReplayEpoch: h.serverHello.bridgeReplayEpoch, lastAppliedBridgeOutboundSeq: 0 });
  h.secureTransport.queueOutboundApplicationMessage('{"id":1,"result":"first"}');
  h.send(message);
  assert.deepEqual(h.controlMessages.at(-1), ready);
  h.secureTransport.queueOutboundApplicationMessage('{"id":2,"result":"second"}');
  assert.deepEqual(wire.map((envelope) => envelope.counter), [0, 1]);
  assert.equal(h.updates.length, 1);
  assert.equal(h.secureTransport.getPendingPairingApproval(), null);
  h.secureTransport.cancelPendingHandshake();
});

test("a failed trust write never installs the proposed session", () => {
  const h = pendingPairing({ rememberTrustedPhoneImpl: () => { throw new Error("disk full"); } });
  h.send(h.confirm(h.approve()));
  assert.equal(h.controlMessages.at(-1).code, "pairing_failed");
  h.send({ kind: "encryptedEnvelope" });
  assert.equal(h.controlMessages.at(-1).code, "secure_channel_unavailable");
  assert.equal(h.updates.length, 0);
});

test("signed phone cancellation closes the window and cannot be confused with confirmation", () => {
  const h = pendingPairing();
  h.send({ ...h.confirm(""), kind: "clientPairingCancel" });
  assert.ok(h.secureTransport.getPendingPairingApproval());
  h.send({ ...h.confirm(""), kind: "clientPairingCancel", phoneSignature: signIdentity(h.phoneIdentity,
    buildPairingControlTranscript(h.transcriptBytes, "client-pairing-cancel")) });
  assert.equal(h.controlMessages.at(-1).code, "pairing_cancelled");
  assert.equal(h.secureTransport.getPendingPairingApproval(), null);
  assert.equal(h.updates.length, 0);
});

test("v3 transcript, full fingerprint and signatures match the cross-platform fixture", () => {
  const vector = require("./fixtures/pairing-v3.json");
  const { buildTranscriptBytes: bridgeTranscript } = require("../src/secure-transport");
  const input = { ...vector.input, clientNonce: Buffer.from(vector.input.clientNonce, "base64"), serverNonce: Buffer.from(vector.input.serverNonce, "base64") };
  const transcript = bridgeTranscript(input);
  assert.equal(transcript.toString("base64"), vector.transcriptBase64);
  assert.equal(createHash("sha256").update(transcript).digest("hex"), vector.fingerprint);
  const mac = { publicKey: vector.input.macIdentityPublicKey, privateKey: vector.macPrivateSeed };
  const phone = { publicKey: vector.input.phoneIdentityPublicKey, privateKey: vector.phonePrivateSeed };
  assert.equal(signIdentity(mac, transcript), vector.macHandshake);
  assert.equal(signIdentity(phone, Buffer.concat([transcript, encodeLengthPrefixedUTF8("client-auth")])), vector.phoneAuth);
  for (const [label, owner, expected, nonce] of [
    ["pairing-approved", mac, vector.macApproval, vector.approvalNonce],
    ["client-pairing-confirm", phone, vector.phoneConfirm, vector.approvalNonce],
    ["client-pairing-cancel", phone, vector.phoneCancel, ""],
    ["secure-ready", mac, vector.macReady, vector.approvalNonce],
  ]) assert.equal(signIdentity(owner, buildPairingControlTranscript(transcript, label, nonce)), expected);
});

test("v2 and bootstrap without an issued local pairing window are rejected", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const transport = createTestBridgeSecureTransport({ sessionId: "closed", relayUrl: "ws://127.0.0.1/relay",
    deviceState: { macDeviceId: "closed-mac", macIdentityPrivateKey: macIdentity.privateKey, macIdentityPublicKey: macIdentity.publicKey, trustedPhones: {} } });
  const responses = [];
  const hello = { kind: "clientHello", sessionId: "closed", handshakeMode: "qr_bootstrap", phoneDeviceId: "new-phone",
    phoneIdentityPublicKey: phoneIdentity.publicKey, phoneEphemeralPublicKey: createOkpKeyPair("x25519").publicKey, clientNonce: Buffer.alloc(32, 1).toString("base64") };
  for (const [protocolVersion, code] of [[2, "update_required"], [3, "pairing_expired"]]) {
    transport.handleIncomingWireMessage(JSON.stringify({ ...hello, protocolVersion }), { sendControlMessage: (message) => responses.push(message), onApplicationMessage: () => assert.fail("Unexpected RPC") });
    assert.equal(responses.at(-1).code, code);
  }
});

test("clientAuth cannot extend a pairing window that expired after serverHello", () => {
  let clock = Date.now();
  const h = pendingPairing({ now: () => clock, pauseBeforeAuth: true });
  clock = h.serverHello.expiresAtForTranscript;
  h.send(h.clientAuth);
  assert.equal(h.controlMessages.at(-1).code, "pairing_expired");
  assert.equal(h.secureTransport.getPendingPairingApproval(), null);
  assert.equal(h.updates.length, 0);
});

test("pending and rejected replacements preserve the already trusted active phone", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const firstPhone = createOkpKeyPair("ed25519");
  const secondPhone = createOkpKeyPair("ed25519");
  const updates = [];
  const secureTransport = createTestBridgeSecureTransport({ sessionId: "retain-session", relayUrl: "ws://127.0.0.1/relay",
    deviceState: { macDeviceId: "retain-mac", macIdentityPrivateKey: macIdentity.privateKey, macIdentityPublicKey: macIdentity.publicKey, trustedPhones: {} },
    onTrustedPhoneUpdate: (state) => updates.push(state),
  });
  const first = { secureTransport, sessionId: "retain-session", macDeviceId: "retain-mac", phoneDeviceId: "first-phone",
    macIdentity, phoneIdentity: firstPhone, phoneEphemeral: createOkpKeyPair("x25519"), handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP, lastAppliedBridgeOutboundSeq: 0 };
  finishHandshake(first);
  const second = finishHandshake({ ...first, phoneDeviceId: "second-phone", phoneIdentity: secondPhone,
    phoneEphemeral: createOkpKeyPair("x25519"), pauseBeforeApproval: true });
  assert.equal(secureTransport.isSecureChannelReady(), true);
  secureTransport.decidePairingApproval({ requestId: second.request.requestId, decision: "reject" });
  assert.equal(secureTransport.isSecureChannelReady(), true);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].trustedPhones, { "first-phone": firstPhone.publicKey });
  finishHandshake({ ...first, handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT, phoneEphemeral: createOkpKeyPair("x25519") });
  assert.equal(secureTransport.isSecureChannelReady(), true);
  assert.equal(secureTransport.getPendingPairingApproval(), null);
});
