param([string]$DisplayName=(-join ([char[]](0x4e54,0x70b3,0x6e90))),[string]$Profile='v2-client')
$ErrorActionPreference='Stop'
if ($Profile -notmatch '^[a-z0-9-]+$') { throw 'invalid_profile_name' }
$nameKey=$DisplayName.Normalize([Text.NormalizationForm]::FormKC).Trim()
if (-not $nameKey) { throw 'invalid_display_name' }
$sqlName=$nameKey.Replace("'","''")
$root=Join-Path $env:LOCALAPPDATA 'ReliableDriveSync'
$credentialPath=Join-Path $root "$Profile.credential.xml"
$identityPath=Join-Path $root "$Profile.identity.json"
if (Test-Path -LiteralPath $credentialPath) { throw 'credential_file_exists; inspect existing binding before rotating' }
$config=Join-Path $PSScriptRoot '../../services/reliable-drive-sync-worker/wrangler.toml'
function Query([string]$Sql) {
  $raw=(& npx.cmd --yes wrangler@4.129.1 d1 execute reliable-drive-sync --config $config --remote --json --command $Sql | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'remote_identity_query_failed' }
  return ($raw | ConvertFrom-Json)
}
$rows=(Query "SELECT user_id,display_name,status FROM rds2_users WHERE name_key='$sqlName';").results
if (@($rows).Count -gt 1) { throw 'ambiguous_identity' }
if ($rows -and $rows.status -ne 'active') { throw 'user_disabled' }
$userId=if ($rows) {$rows.user_id} else {[Guid]::NewGuid().ToString()}
$credential='rds2_'+[Guid]::NewGuid().ToString()+'_'+[Guid]::NewGuid().ToString()
$sha=[Security.Cryptography.SHA256]::Create()
try {$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($credential)))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
New-Item -ItemType Directory -Path $root -Force | Out-Null
# DPAPI encryption ties the secret to the current Windows user; stdout never carries it.
ConvertTo-SecureString $credential -AsPlainText -Force | Export-Clixml -LiteralPath $credentialPath
$now=[DateTime]::UtcNow.ToString('o')
$insert=if (-not $rows) {"INSERT INTO rds2_users(user_id,name_key,display_name,status,created_at) VALUES('$userId','$sqlName','$sqlName','active','$now');"} else {''}
Query ($insert+"INSERT INTO rds2_credentials(credential_hash,user_id,status,created_at) VALUES('$hash','$userId','active','$now');") | Out-Null
[pscustomobject]@{userId=$userId;displayName=$nameKey;storageVersion=2} | ConvertTo-Json | Set-Content -LiteralPath $identityPath -Encoding UTF8
$credential=$null
Write-Output "V2 identity: $userId ($nameKey); encrypted credential stored for current Windows user."
