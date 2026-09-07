param(
  [string] $WorkerUrl = 'https://reliable-drive-sync.qiaobingyuan886.workers.dev',
  [string] $SharedSecret = $env:RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET,
  [ValidateSet('v1', 'v2')]
  [string] $WriteVersion = 'v1',
  [string] $OutboxPath = '',
  [string] $CodexConfigPath = (Join-Path $HOME '.codex\config.toml'),
  [string] $WorkBuddyConfigPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not [Uri]::IsWellFormedUriString($WorkerUrl, [UriKind]::Absolute) -or -not $WorkerUrl.StartsWith('https://')) {
  throw 'WorkerUrl must be an absolute HTTPS URL.'
}
if ([string]::IsNullOrWhiteSpace($SharedSecret)) {
  throw 'RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET is required.'
}

$startCmd = (Resolve-Path (Join-Path $PSScriptRoot 'start.cmd')).Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or newer is required.' }

[Environment]::SetEnvironmentVariable('RELIABLE_DRIVE_SYNC_INGRESS_URL', $WorkerUrl, 'User')
[Environment]::SetEnvironmentVariable('RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET', $SharedSecret, 'User')
# T10: the write version selects the delivery path (v1 legacy or v2 outbox),
# and the outbox path is an explicit parameter instead of an accident of the
# environment. Both are written for real; stdout only reports them.
[Environment]::SetEnvironmentVariable('RELIABLE_DRIVE_SYNC_WRITE_VERSION', $WriteVersion, 'User')
if (-not [string]::IsNullOrWhiteSpace($OutboxPath)) {
  [Environment]::SetEnvironmentVariable('RELIABLE_DRIVE_SYNC_OUTBOX_PATH', $OutboxPath, 'User')
}

$codexDirectory = Split-Path -Parent $CodexConfigPath
New-Item -ItemType Directory -Force -Path $codexDirectory | Out-Null
$existingToml = if (Test-Path $CodexConfigPath) { Get-Content -Raw $CodexConfigPath } else { '' }
$escapedCommand = $startCmd.Replace('\', '\\').Replace('"', '\"')
$section = "[mcp_servers.reliable_drive_sync]`r`ncommand = `"$escapedCommand`"`r`n"
$pattern = '(?ms)^\[mcp_servers\.reliable_drive_sync\]\r?\n.*?(?=^\[|\z)'
if ([regex]::IsMatch($existingToml, $pattern)) {
  $updatedToml = [regex]::Replace($existingToml, $pattern, $section + "`r`n")
} else {
  $updatedToml = $existingToml.TrimEnd() + "`r`n`r`n" + $section
}
Set-Content -Path $CodexConfigPath -Value $updatedToml -Encoding UTF8

if ([string]::IsNullOrWhiteSpace($WorkBuddyConfigPath)) {
  $workBuddyDirectory = Join-Path $env:LOCALAPPDATA 'ReliableDriveSync'
  $WorkBuddyConfigPath = Join-Path $workBuddyDirectory 'workbuddy-mcp.json'
} else {
  $workBuddyDirectory = Split-Path -Parent $WorkBuddyConfigPath
}
New-Item -ItemType Directory -Force -Path $workBuddyDirectory | Out-Null
$workBuddy = if (Test-Path $WorkBuddyConfigPath) {
  Get-Content -Raw $WorkBuddyConfigPath | ConvertFrom-Json
} else {
  [pscustomobject]@{}
}
if (-not $workBuddy.PSObject.Properties['mcpServers']) {
  $workBuddy | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{})
}
$server = [pscustomobject]@{ command = $startCmd; args = @() }
$workBuddy.mcpServers | Add-Member -MemberType NoteProperty -Name 'reliable-drive-sync' -Value $server -Force
$workBuddy | ConvertTo-Json -Depth 20 | Set-Content -Path $WorkBuddyConfigPath -Encoding UTF8

Write-Output 'Local setup complete.'
Write-Output "Write version: $WriteVersion"
if (-not [string]::IsNullOrWhiteSpace($OutboxPath)) {
  Write-Output "Outbox path: $OutboxPath"
}
Write-Output "Codex and ChatGPT desktop config: $CodexConfigPath"
Write-Output "WorkBuddy MCP config: $WorkBuddyConfigPath"
Write-Output 'Restart ChatGPT desktop, Codex, and WorkBuddy. The only tool must be submit_event.'
