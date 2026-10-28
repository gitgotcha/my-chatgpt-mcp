$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $scriptDirectory "..\..")).Path
$secretFile = Join-Path $repositoryRoot "services\rds-jbryon\.dev.vars"

if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
  [Console]::Error.WriteLine("RDS-JBryon local secret file is missing.")
  exit 2
}

$secretText = [System.IO.File]::ReadAllText($secretFile)
$tokenMatch = [regex]::Match($secretText, "(?m)^RDS_TOKEN=([0-9a-f]{64})\r?$")
if (-not $tokenMatch.Success) {
  [Console]::Error.WriteLine("RDS-JBryon local secret file is malformed.")
  exit 2
}

$env:RDS_URL = "https://rds-jbryon.qiaobingyuan886.workers.dev/rds"
$env:RDS_TOKEN = $tokenMatch.Groups[1].Value
if (-not $env:RDS_OUTBOX) {
  $outboxDirectory = Join-Path $env:LOCALAPPDATA "ReliableDriveSync"
  $env:RDS_OUTBOX = Join-Path $outboxDirectory "rds-jbryon-outbox.sqlite"
}

$node = Get-Command "node.exe" -ErrorAction SilentlyContinue
if (-not $node) {
  [Console]::Error.WriteLine("Node.js was not found on PATH.")
  exit 2
}

& $node.Source (Join-Path $scriptDirectory "server.mjs")
$exitCode = $LASTEXITCODE
Remove-Item Env:RDS_TOKEN -ErrorAction SilentlyContinue
exit $exitCode
