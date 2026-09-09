param(
  [Parameter(Mandatory=$true)][ValidateSet('secret','pairingCode','confirm')][string]$Action,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$Prompt = '确认操作'
)

$ErrorActionPreference = 'Stop'
if ($Action -eq 'confirm') {
  $answer = Read-Host "$Prompt (yes/no)"
  if ($answer -notmatch '^(?i:yes|y)$') { exit 2 }
  [IO.File]::WriteAllText($OutputPath, 'confirmed', [Text.Encoding]::UTF8)
  exit 0
}

# Input remains visible only in the user-facing console. The file contains a
# DPAPI blob, never the plaintext secret or pairing code.
$secure = Read-Host $Prompt -AsSecureString
$encrypted = $secure | ConvertFrom-SecureString
[IO.File]::WriteAllText($OutputPath, $encrypted, [Text.Encoding]::UTF8)

