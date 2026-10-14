const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { invokeTask } = require("../src/windows-service");
const { writeDaemonConfig } = require("../src/daemon-state");

test("Windows scheduled task survives its launcher, starts once, and stops only its own process tree", {
  skip: process.platform !== "win32", timeout: 90_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex task 中文 & "));
  const env = { ...process.env, REMODEX_DEVICE_STATE_DIR: directory };
  const cliPath = path.join(directory, "fixture.js");
  const record = path.join(directory, "children.json");
  fs.writeFileSync(cliPath, `
    const fs = require('node:fs');
    const path = require('node:path');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {windowsHide:true,stdio:'ignore'});
    fs.appendFileSync(path.join(process.env.REMODEX_DEVICE_STATE_DIR,'starts.log'), 'started\\n');
    fs.writeFileSync(path.join(process.env.REMODEX_DEVICE_STATE_DIR,'children.json'), JSON.stringify([process.pid,child.pid]));
    console.log('fixture stdout 中文');
    console.error('fixture stderr 中文');
    setInterval(()=>{},1000);
  `);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function waitFor(check) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    const errorLog = path.join(directory, "logs", "bridge.stderr.log");
    assert.fail(`Timed out waiting for the scheduler-owned worker: ${JSON.stringify(invokeTask("Status", { env }))}; ${fs.existsSync(errorLog) ? fs.readFileSync(errorLog, "utf8") : "no worker log"}`);
  }
  t.after(() => {
    invokeTask("Uninstall", { env });
    // This directory was created by this test and contains no user files.
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  writeDaemonConfig({ nodePath: process.execPath, codexPath: process.execPath, cliPath }, { env });
  invokeTask("Install", { env });
  invokeTask("Start", { env });
  await waitFor(() => fs.existsSync(record));
  const pids = JSON.parse(fs.readFileSync(record, "utf8"));
  invokeTask("Start", { env });
  assert.equal(fs.readFileSync(path.join(directory, "starts.log"), "utf8"), "started\n");
  assert.equal(invokeTask("Status", { env }).running, true);
  assert.ok(pids.every(alive));
  for (const stream of ['stdout', 'stderr']) {
    const log = path.join(directory, 'logs', `bridge.${stream}.log`);
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`fixture ${stream} 中文`));
  }
  const consoleRecord = path.join(directory, "consoles.json");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
    using System.Runtime.InteropServices;
    public class ConsoleProbe {
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
      [DllImport("kernel32.dll")] public static extern bool FreeConsole();
      [DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
    }
'@
    $worker = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pids[0]}'
    $ids = @(${pids.join(",")}, $worker.ParentProcessId)
    [ConsoleProbe]::FreeConsole() | Out-Null
    $results = @(foreach ($targetId in $ids) {
      $attached = [ConsoleProbe]::AttachConsole($targetId)
      $errorCode = if ($attached) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
      $window = if ($attached) { [ConsoleProbe]::GetConsoleWindow() } else { [IntPtr]::Zero }
      if ($attached) { [ConsoleProbe]::FreeConsole() | Out-Null }
      @{ pid = $targetId; hasConsole = $attached; errorCode = $errorCode; window = $window.ToInt64() }
    })
    $results | ConvertTo-Json | Set-Content -LiteralPath '${consoleRecord.replace(/'/g, "''")}' -Encoding UTF8
  `], { windowsHide: true, timeout: 15_000, stdio: "pipe" });
  const consoles = JSON.parse(fs.readFileSync(consoleRecord, "utf8").replace(/^\uFEFF/, ""));
  assert.ok(consoles.every((entry) => entry.window === 0 && (entry.hasConsole || entry.errorCode === 6)),
    `The PowerShell supervisor and bridge tree must not have console windows: ${JSON.stringify(consoles)}`);
  invokeTask("Stop", { env });
  await waitFor(() => pids.every((pid) => !alive(pid)));
  assert.equal(alive(process.pid), true, "The CLI/test process must not be killed");
  const failureScript = path.join(directory, "exit.ps1");
  fs.writeFileSync(failureScript, "exit 17\n");
  assert.throws(() => execFileSync(path.join(directory, "windows-task-launcher.exe"),
    [failureScript, directory + path.sep, "fixture"], { windowsHide: true, timeout: 15_000 }),
  (error) => error.status === 17, "The GUI launcher must preserve PowerShell's exit code and quoted trailing backslashes");
  invokeTask("Install", { env });
  invokeTask("Start", { env });
  await waitFor(() => fs.readFileSync(path.join(directory, "starts.log"), "utf8") === "started\nstarted\n");
  const restartedPids = JSON.parse(fs.readFileSync(record, "utf8"));
  invokeTask("Stop", { env });
  await waitFor(() => restartedPids.every((pid) => !alive(pid)));
  invokeTask("Uninstall", { env });
  assert.equal(invokeTask("Status", { env }).installed, false);
  assert.ok(fs.existsSync(path.join(directory, "daemon-config.json")));
});
