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
    -Argument $serverPath `
    -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Webhook server for remote Claude Code session launching" `
    -RunLevel Highest

Write-Host "Task '$taskName' registered. It will start at next login."
Write-Host "To start it now: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To check status: Get-ScheduledTask -TaskName '$taskName'"
