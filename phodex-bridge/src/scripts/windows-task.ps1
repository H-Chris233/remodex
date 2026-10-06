param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall', 'Run')]
    [string]$Action,
    [Parameter(Mandatory = $true)][string]$StateDir,
    [Parameter(Mandatory = $true)][string]$TaskName
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$StateDir = [IO.Path]::GetFullPath($StateDir)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$description = "Remodex per-user bridge: $StateDir"
$workerRecord = Join-Path $StateDir 'windows-worker.json'

if ($Action -eq 'Run') {
    $env:REMODEX_DEVICE_STATE_DIR = $StateDir
    $config = Get-Content -LiteralPath (Join-Path $StateDir 'daemon-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($file in @($config.nodePath, $config.cliPath, $config.codexPath)) {
        if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw 'A recorded executable or checkout no longer exists. Run remodex start to reinstall the task.'
        }
    }
    $logs = Join-Path $StateDir 'logs'
    [IO.Directory]::CreateDirectory($logs) | Out-Null
    $stdout = Join-Path $logs 'bridge.stdout.log'
    $stderr = Join-Path $logs 'bridge.stderr.log'
    foreach ($log in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination "$log.previous" -Force }
    }
    # Task Scheduler may terminate only PowerShell. Record the exact child identity
    # so stop can also terminate its tree without ever trusting a recycled PID.
    $child = Start-Process -FilePath $config.nodePath -WindowStyle Hidden -PassThru `
        -ArgumentList @(('"{0}"' -f $config.cliPath), 'run-service') `
        -WorkingDirectory (Split-Path -Parent $config.cliPath) `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    @{ taskName = $TaskName; pid = $child.Id; startedAtTicks = $child.StartTime.ToUniversalTime().Ticks.ToString(); nodePath = $config.nodePath } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $workerRecord -Encoding UTF8
    $child.WaitForExit()
    exit $child.ExitCode
}

function Stop-OwnedWorker {
    if (-not (Test-Path -LiteralPath $workerRecord)) { return }
    $worker = Get-Content -LiteralPath $workerRecord -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($worker.taskName -ne $TaskName) { throw 'Worker record belongs to another installation.' }
    $process = $null
    try { $process = [Diagnostics.Process]::GetProcessById([int]$worker.pid) } catch [ArgumentException] { }
    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $worker.startedAtTicks) {
        if ($process.MainModule.FileName -ne $worker.nodePath) { throw 'Worker executable identity changed; refusing to stop it.' }
        & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $worker.pid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw 'Unable to stop the Remodex worker tree.' }
        if (-not $process.WaitForExit(5000)) { throw 'Remodex worker did not exit.' }
    }
    Remove-Item -LiteralPath $workerRecord -Force
}

function Get-OwnedTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        $owner = $existing.Principal.UserId
        $ownerSid = if ($owner -like 'S-1-*') { $owner } else {
            [Security.Principal.NTAccount]::new($owner).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($existing.Description -ne $description -or $ownerSid -ne $identity.User.Value) {
            throw 'A task with this name is not owned by this Remodex installation.'
        }
    }
    return $existing
}

function Stop-OwnedTask($existing) {
    if ($existing -and $existing.State -eq 'Running') {
        Stop-ScheduledTask -InputObject $existing
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 100
            $existing = Get-OwnedTask
        } while ($existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
        if ($existing.State -eq 'Running') { throw 'The scheduled task did not stop.' }
    }
    Stop-OwnedWorker
}

$task = Get-OwnedTask
switch ($Action) {
    'Install' {
        if ($task -and $task.State -eq 'Running') { throw 'Stop the task before changing its configuration.' }
        # Files contain the relay configuration and local pairing material.
        $directoryInfo = [IO.DirectoryInfo]::new($StateDir)
        $acl = $directoryInfo.GetAccessControl()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.SetAccessRule($rule)
        }
        $directoryInfo.SetAccessControl($acl)
        $scriptArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Action Run -StateDir "{1}" -TaskName "{2}"' -f $PSCommandPath, $StateDir, $TaskName
        $taskAction = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $scriptArgs
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
        $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal `
            -Settings $settings -Description $description -Force | Out-Null
    }
    'Start' {
        if (-not $task) { throw 'The Remodex task is not installed.' }
        if ($task.State -ne 'Running') { Start-ScheduledTask -InputObject $task }
    }
    'Stop' { Stop-OwnedTask $task }
    'Uninstall' {
        Stop-OwnedTask $task
        if ($task) { Unregister-ScheduledTask -InputObject $task -Confirm:$false }
    }
    'Status' {
        $info = if ($task) { Get-ScheduledTaskInfo -InputObject $task } else { $null }
        @{ installed = [bool]$task; running = [bool]($task -and $task.State -eq 'Running'); lastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Compress
        exit 0
    }
}
@{ ok = $true } | ConvertTo-Json -Compress
