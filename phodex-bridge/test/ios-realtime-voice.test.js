const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const project = path.resolve(__dirname, "../../CodexMobile");
const mobile = path.join(project, "CodexMobile");
const read = (file) => fs.readFileSync(path.join(mobile, file), "utf8");

test("voice media dependency, background mode, and distribution notice are present", () => {
  const resolved = JSON.parse(fs.readFileSync(path.join(project, "CodexMobile.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"), "utf8"));
  const pin = resolved.pins.find((entry) => entry.identity === "webrtc");
  assert.deepEqual(pin.state, { revision: "0c0ad84dac6c1941c16a414dfcfba94691866e4c", version: "154.0.0" });
  assert.equal(new Set(resolved.pins.map((entry) => entry.identity)).size, resolved.pins.length);
  const pbx = fs.readFileSync(path.join(project, "CodexMobile.xcodeproj/project.pbxproj"), "utf8");
  assert.match(pbx, /kind = exactVersion; version = 154\.0\.0/);
  assert.match(pbx, /E1B100000000000000000003 \/\* WebRTC in Frameworks \*\//);
  const plist = fs.readFileSync(path.join(project, "BuildSupport/CodexMobile-Info.plist"), "utf8");
  assert.match(plist, /<key>UIBackgroundModes<\/key>\s*<array>[\s\S]*?<string>audio<\/string>/);
  assert.match(read("Resources/WebRTC-LICENSE.txt"), /Copyright \(c\) 2011, The WebRTC project authors/);
});

test("voice consumes canonical item events and generation-scoped SDP", () => {
  const service = read("Services/CodexService+RealtimeVoice.swift");
  for (const method of ["item/started", "item/completed", "item/transcript/delta"]) {
    assert.ok(service.includes(`thread/realtime/${method}`));
  }
  assert.ok(!service.includes('case "thread/realtime/transcript/delta"'));
  const call = read("Services/CodexRealtimeVoiceCoordinator.swift");
  assert.match(call, /remodexRealtimeSessionId/);
  assert.match(call, /case "remodex\/realtime\/recovering"/);
  assert.match(call, /data\?\["remodexRealtimeRecovery"\]\?\.stringValue == "controlLost"/);
  assert.match(call, /SecRandomCopyBytes/);
  assert.match(call, /String\(format: "%02x", \$0\)/);
  assert.ok(!call.includes("appendAudio") && !call.includes('method: "turn/start"'));
  assert.ok(!call.includes("print(") && !call.includes("UserDefaults"));
  assert.match(service, /CodexVoiceTranscript\.historySnapshotStillCurrent/);
  assert.match(service, /sendRequest\(method: "thread\/timeline\/list"[^\n]+\n\s*try Task\.checkCancellation\(\)/);
  assert.match(read("Services/CodexService+History.swift"), /Ordinary turn pages cannot confirm, deduplicate, or delete turn-less voice items/);
});

test("delegation provenance and shared-runtime human approval survive each decode entry", () => {
  const incoming = read("Services/CodexService+Incoming.swift");
  assert.match(incoming, /\[desktopIpcActionSource, "sharedRuntime"\]\.contains/);
  assert.match(incoming, /selectedAccessMode == \.fullAccess && !requiresHumanApproval/);
  for (const file of ["Services/CodexService+IncomingAssistant.swift", "Services/CodexService+History.swift"]) {
    assert.ok(read(file).includes("remodexRealtimeDelegation"));
  }
  assert.ok(read("Services/CodexService+Messages.swift").includes("CodexVoiceTranscript.projectDelegations(messages)"));
  assert.ok(read("Services/CodexService+RealtimeVoice.swift").includes("activeRealtimeSessionAtPageStart"));
  assert.match(read("Models/CodexMessage.swift"), /decodeIfPresent\(Bool\.self, forKey: \.isRealtimeDelegation\) \?\? false/);
});

test("Swift call intent, canonical transcripts, audio meters, and microphone ownership handle races", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 60000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-realtime-voice-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "voice-check");
  const expression = read("Services/CodexService+Incoming.swift").match(/let requiresHumanApproval = ([^\r\n]+)/)?.[1];
  assert.ok(expression);
  const guard = path.join(directory, "ApprovalGuard.swift");
  fs.writeFileSync(guard, `import Foundation
nonisolated enum RealtimeApprovalGuard {
 static func requiresHumanDecision(source: String?) -> Bool {
 let desktopIpcActionSource = "desktopIpc"
 let paramsObject: [String: JSONValue]? = source.map { ["remodexActionSource": .string($0)] }
 return ${expression}
 }
}
`);
  execFileSync("xcrun", ["swiftc", "-default-isolation", "MainActor", "-module-cache-path", path.join(directory, "cache"), "-parse-as-library",
    ...["JSONValue.swift", "CodexMessage.swift", "CodexMessageOrderCounter.swift", "CodexCollaboration.swift", "CodexAsyncUserInput.swift", "CodexAutoApprovalReview.swift", "CodexImageAttachment.swift", "CodexTextContentFingerprint.swift", "CodexRealtimeVoiceState.swift", "CodexVoiceAudioMeter.swift"].map((file) => path.join(mobile, "Models", file)), guard,
    path.join(mobile, "Services/VoiceAudioSessionOwnership.swift"), path.join(__dirname, "fixtures/realtime-voice-harness.swift"), "-o", binary], { timeout: 45000 });
  assert.match(execFileSync(binary, { encoding: "utf8", timeout: 10000 }), /realtime voice checks passed/);
});
