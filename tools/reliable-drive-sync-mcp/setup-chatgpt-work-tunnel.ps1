[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9]+$')]
  [string] $TunnelId,

  [string] $TunnelClientPath = 'tunnel-client',
  [string] $Profile = 'reliable-drive-sync',
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $DryRun -and [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  throw 'CONTROL_PLANE_API_KEY must be set for tunnel-client.'
}

$launcher = Join-Path $PSScriptRoot 'start.cmd'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "MCP launcher not found: $launcher"
}

$mcpCommand = 'cmd.exe /d /s /c ""' + $launcher + '""'
$initArgs = @(
  'init',
  '--sample', 'sample_mcp_stdio_local',
  '--profile', $Profile,
  '--tunnel-id', $TunnelId,
  '--mcp-command', $mcpCommand
)
$doctorArgs = @('doctor', '--profile', $Profile, '--explain')

function Format-Command([string] $Executable, [string[]] $Arguments) {
  $quoted = $Arguments | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_.Replace('"', '\"')) + '"' } else { $_ }
  }
  return "$Executable $($quoted -join ' ')"
}

if ($DryRun) {
  Write-Output (Format-Command $TunnelClientPath $initArgs)
  Write-Output (Format-Command $TunnelClientPath $doctorArgs)
  Write-Output (Format-Command $TunnelClientPath @('run', '--profile', $Profile))
  exit 0
}

& $TunnelClientPath @initArgs
if ($LASTEXITCODE -ne 0) { throw "tunnel-client init failed with exit code $LASTEXITCODE" }

& $TunnelClientPath @doctorArgs
if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE" }

Write-Output 'Tunnel profile is ready. Keep this process running while testing ChatGPT Work:'
Write-Output (Format-Command $TunnelClientPath @('run', '--profile', $Profile))
