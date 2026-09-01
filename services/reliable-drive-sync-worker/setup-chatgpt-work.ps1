[CmdletBinding()]
param(
  [string] $WorkerUrl = 'https://reliable-drive-sync.qiaobingyuan886.workers.dev'
)

$ErrorActionPreference = 'Stop'

if ($WorkerUrl -notmatch '^https://[A-Za-z0-9.-]+\.workers\.dev/?$') {
  throw 'WorkerUrl must be an https://*.workers.dev address.'
}

$randomBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($randomBytes)
} finally {
  $random.Dispose()
}
$token = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

Push-Location $PSScriptRoot
try {
  $token | & npx wrangler secret put MCP_URL_TOKEN
  if ($LASTEXITCODE -ne 0) {
    throw "wrangler secret put failed with exit code $LASTEXITCODE"
  }

  & npx wrangler deploy
  if ($LASTEXITCODE -ne 0) {
    throw "wrangler deploy failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$mcpUrl = $WorkerUrl.TrimEnd('/') + '/mcp/' + $token
Set-Clipboard -Value $mcpUrl
Write-Output 'Deployment complete. The ChatGPT Work MCP URL is in your clipboard. Keep it private.'
