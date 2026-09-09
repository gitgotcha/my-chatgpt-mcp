$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'ReliableDriveSync'
$env:RELIABLE_DRIVE_SYNC_DEVICE_ROOT=$root
$env:RELIABLE_DRIVE_SYNC_WORKER_URL='https://reliable-drive-sync.qiaobingyuan886.workers.dev'
$env:RELIABLE_DRIVE_SYNC_WRITE_VERSION='v2'
$env:RELIABLE_DRIVE_SYNC_OUTBOX_PATH=Join-Path $root 'outbox-v2.sqlite'
$nodePath=[Environment]::GetEnvironmentVariable('RELIABLE_DRIVE_SYNC_NODE_PATH','User')
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) { $nodePath='node' }
try { & $nodePath (Join-Path $PSScriptRoot 'stdio-bridge.mjs'); exit $LASTEXITCODE }
finally { $env:RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET=$null }
