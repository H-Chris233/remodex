const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPairingApprovalService, readPendingPairingApproval, submitPairingDecision } = require("../src/pairing-approval");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-pairing-approval-"));
  const env = { REMODEX_DEVICE_STATE_DIR: root };
  const directory = path.join(root, "pairing-approval");
  const decisions = [];
  const service = createPairingApprovalService({ env,
    secureDirectoryImpl: (value) => fs.mkdirSync(value, { recursive: true, mode: 0o700 }),
    decide: (decision) => { decisions.push(decision); return { requestId: decision.requestId, stage: decision.decision === "approve" ? "awaitingPhone" : "rejected" }; },
    ...options,
  });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = { requestId: "a".repeat(32), fingerprint: "b".repeat(64), expiresAt: Date.now() + 60_000, stage: "awaitingComputer", replacesTrustedPhone: true };
  const write = (name, object) => fs.writeFileSync(path.join(directory, name), JSON.stringify(object));
  return { root, directory, env, service, request, decisions, write };
}

test("local approval waits for the bridge response and does not write trust", async (t) => {
  const f = fixture(t);
  f.service.publish(f.request);
  const pending = readPendingPairingApproval({ env: f.env });
  assert.equal(pending.fingerprint, f.request.fingerprint);
  const result = await submitPairingDecision({ env: f.env, requestId: f.request.requestId, fingerprint: f.request.fingerprint, decision: "approve" });
  assert.equal(result.stage, "awaitingPhone");
  assert.equal(f.decisions.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, "device-state.json")), false);
  assert.equal(fs.readdirSync(f.directory).some((name) => /tmp|claimed/.test(name)), false);
});

test("wrong fingerprints and unknown requests never reach the bridge", async (t) => {
  const f = fixture(t);
  f.service.publish(f.request);
  await assert.rejects(submitPairingDecision({ env: f.env, ...f.request, fingerprint: "0".repeat(64), decision: "approve" }), /fingerprint/);
  await assert.rejects(submitPairingDecision({ env: f.env, ...f.request, requestId: "c".repeat(32), decision: "reject" }), /matching/);
  f.service.poll();
  assert.equal(f.decisions.length, 0);
});

test("prewritten, previous-process, previous-request and replayed decisions are not authorization", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.directory);
  f.write("decision.json", { decision: "approve" });
  f.service.publish(f.request);
  assert.equal(fs.existsSync(path.join(f.directory, "decision.json")), false);
  const pending = readPendingPairingApproval({ env: f.env });
  const decision = { ...pending, decision: "approve", decisionId: "d".repeat(32) };
  for (const invalid of [{ ...decision, instanceId: "0".repeat(32) }, { ...decision, requestId: "0".repeat(32) }]) {
    f.write("decision.json", invalid);
    f.service.poll();
  }
  assert.equal(f.decisions.length, 0);
  f.write("decision.json", decision);
  f.service.poll();
  f.write("decision.json", decision);
  f.service.poll();
  assert.equal(f.decisions.length, 1);
});

test("expiry and disposal remove the request without deciding", (t) => {
  let clock = Date.now();
  const f = fixture(t, { now: () => clock });
  f.service.publish(f.request);
  clock = f.request.expiresAt;
  f.service.poll();
  assert.equal(readPendingPairingApproval({ env: f.env }), null);
  assert.equal(f.decisions.length, 0);
  f.service.publish({ ...f.request, expiresAt: clock + 60_000 });
  f.service.dispose();
  assert.equal(fs.existsSync(path.join(f.directory, "request.json")), false);
});

test("a written decision is not reported as approved without live acknowledgement", async (t) => {
  const f = fixture(t);
  f.service.publish(f.request);
  await assert.rejects(submitPairingDecision({ env: f.env, ...f.request, decision: "approve", timeoutMs: 1 }), /did not acknowledge/);
  assert.equal(f.decisions.length, 0);
});

test("approval files use the operating system's private local-account permissions", (t) => {
  const f = fixture(t, { secureDirectoryImpl: undefined });
  f.service.publish(f.request);
  assert.ok(readPendingPairingApproval({ env: f.env }));
  if (process.platform === "win32") {
    const { execFileSync } = require("node:child_process");
    const script = "$ProgressPreference='SilentlyContinue'; $a=Get-Acl -LiteralPath $env:REMODEX_APPROVAL_DIRECTORY; "
      + "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
      + "[bool]($a.AreAccessRulesProtected -and @($a.Access).Count -eq 1 -and "
      + "$a.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid)";
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, REMODEX_APPROVAL_DIRECTORY: f.directory } });
    assert.equal(output.trim(), "True");
  } else {
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.directory, "request.json")).mode & 0o777, 0o600);
  }
});
