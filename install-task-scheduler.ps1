# Run this in an elevated PowerShell to register the launcher as a Windows Task Scheduler job
# It will start automatically at login and restart on failure

$taskName = "ClaudeRemoteLauncher"
$nodePath = (Get-Command node).Source
$serverPath = "$env:USERPROFILE\DEVELOP\claude-remote-launcher\server.js"
$workDir = "$env:USERPROFILE\DEVELOP\claude-remote-launcher"

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "`"$serverPath`"" `
    -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Webhook server for remote Claude Code session launching"

# Start immediately
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Task '$taskName' registered and started." -ForegroundColor Green
Write-Host ""
Write-Host "Commands:"
Write-Host "  Check status:  Get-ScheduledTask -TaskName '$taskName'"
Write-Host "  Stop:          Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "  Start:         Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  Uninstall:     Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
