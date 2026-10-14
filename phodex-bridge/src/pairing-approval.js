// FILE: pairing-approval.js
// Purpose: Carries explicit local pairing decisions between the CLI and the live bridge.
// Layer: Local service
// Depends on: fs, path, crypto, child_process, ./daemon-state

const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { execFileSync } = require("child_process");
const { resolveRemodexStateDir } = require("./daemon-state");

function approvalPaths(env) {
  const directory = path.join(resolveRemodexStateDir({ env }), "pairing-approval");
  return { directory, request: path.join(directory, "request.json"), decision: path.join(directory, "decision.json"), response: path.join(directory, "response.json") };
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJSON(file, value) {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("The pairing approval directory must not be a symbolic link.");
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  // Node's POSIX modes do not restrict Windows ACLs; only this local account may decide.
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
    + "$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); "
    + "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); "
    + "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:REMODEX_APPROVAL_DIRECTORY -AclObject $acl";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, stdio: "pipe", env: { ...process.env, REMODEX_APPROVAL_DIRECTORY: directory }, timeout: 10_000,
  });
}

function readPendingPairingApproval({ env = process.env, now = () => Date.now() } = {}) {
  const request = readJSON(approvalPaths(env).request);
  if (!request || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now()
    || !Number.isSafeInteger(request.pid) || request.pid <= 0 || !/^[a-f0-9]{32}$/.test(request.instanceId)
    || !/^[a-f0-9]{32}$/.test(request.requestId)
    || !/^[a-f0-9]{64}$/.test(request.fingerprint)
    || !["awaitingComputer", "awaitingPhone"].includes(request.stage)) return null;
  try { process.kill(request.pid, 0); } catch { return null; }
  const { requestId, fingerprint, expiresAt, stage, instanceId, pid } = request;
  return { requestId, fingerprint, expiresAt, stage, instanceId, pid, replacesTrustedPhone: request.replacesTrustedPhone === true };
}

function createPairingApprovalService({ decide, env = process.env, now = () => Date.now(), onError = () => {}, secureDirectoryImpl = secureDirectory } = {}) {
  const paths = approvalPaths(env);
  const instanceId = randomBytes(16).toString("hex");
  let current = null;
  let timer = null;
  let prepared = false;
  const handledDecisions = new Set();

  function clear() {
    clearInterval(timer);
    timer = null;
    current = null;
    if (readJSON(paths.request)?.instanceId === instanceId) fs.rmSync(paths.request, { force: true });
  }

  function publish(request) {
    if (!request) { clear(); return; }
    if (!prepared) { secureDirectoryImpl(paths.directory); prepared = true; }
    if (current?.requestId !== request.requestId) {
      handledDecisions.clear();
      fs.rmSync(paths.decision, { force: true });
      fs.rmSync(paths.response, { force: true });
    }
    current = { ...request, instanceId, pid: process.pid };
    writeJSON(paths.request, current);
    if (!timer) {
      timer = setInterval(() => { try { poll(); } catch (error) { clear(); onError(error); } }, 250);
      timer.unref?.();
    }
  }

  function poll() {
    if (!current) return;
    if (current.expiresAt <= now()) { clear(); return; }
    const claimedPath = `${paths.decision}.${instanceId}.claimed`;
    try { fs.renameSync(paths.decision, claimedPath); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const decision = readJSON(claimedPath);
    fs.rmSync(claimedPath, { force: true });
    if (!decision) return;
    if (decision.instanceId !== instanceId || decision.requestId !== current.requestId
      || !/^[a-f0-9]{32}$/.test(decision.decisionId) || handledDecisions.has(decision.decisionId)) return;
    handledDecisions.add(decision.decisionId);
    let result;
    try {
      result = { ok: true, ...decide(decision) };
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    writeJSON(paths.response, { ...result, instanceId, requestId: decision.requestId, decisionId: decision.decisionId });
  }

  return { publish, poll, dispose: clear };
}

async function submitPairingDecision({ requestId, fingerprint = "", decision, env = process.env, now = () => Date.now(), timeoutMs = 5_000 } = {}) {
  const request = readPendingPairingApproval({ env, now });
  if (!request || request.requestId !== requestId) throw new Error("No matching live pairing request. Run remodex status --json.");
  const normalizedFingerprint = fingerprint.replace(/[\s-]/g, "").toLowerCase();
  if (!["approve", "reject"].includes(decision)) throw new Error("Unknown pairing decision.");
  if (decision === "approve" && (!/^[a-f0-9]{64}$/.test(normalizedFingerprint) || normalizedFingerprint !== request.fingerprint)) {
    throw new Error("The full fingerprint must match both the computer and iPhone.");
  }
  const paths = approvalPaths(env);
  const decisionId = randomBytes(16).toString("hex");
  writeJSON(paths.decision, { instanceId: request.instanceId, requestId, fingerprint: normalizedFingerprint, decision, decisionId });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const response = readJSON(paths.response);
    if (response?.instanceId === request.instanceId && response.decisionId === decisionId && response.requestId === requestId) {
      if (!response.ok) throw new Error(response.error || "The bridge rejected the pairing decision.");
      return { ok: true, requestId, stage: response.stage };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The bridge did not acknowledge the pairing decision. Refresh its status before retrying.");
}

module.exports = { createPairingApprovalService, readPendingPairingApproval, submitPairingDecision };
