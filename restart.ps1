Stop-ScheduledTask -TaskName "ClaudeRemoteLauncher"
Start-ScheduledTask -TaskName "ClaudeRemoteLauncher"
Write-Host "Restarted." -ForegroundColor Green
