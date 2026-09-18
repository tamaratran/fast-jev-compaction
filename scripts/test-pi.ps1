[CmdletBinding()]
param(
  [switch]$ShowCompactionPrompt
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$extensionPath = Join-Path $repoRoot 'pi\extension.ts'
if (-not (Test-Path -LiteralPath $extensionPath -PathType Leaf)) {
  throw "Pi extension was not found at $extensionPath"
}

if ($ShowCompactionPrompt) {
  @'
Use only Pi's read, grep, find, and ls tools; do not edit files, run shell commands,
or call /compact yet. This is a compaction test. Read the full contents of README.md,
src/compact.ts, src/state.ts, pi/adapter.ts, pi/extension.ts, pi/checkpoint.ts,
tests/pi-adapter.test.ts, and tests/pi-extension.test.ts. Work through the files in
separate tool calls. When you finish, give a detailed explanation of how the Pi
checkpoint preserves retained messages and when Pi falls back to native summarization.
Then wait for my next command.
'@.Trim()
  return
}

$piCommand = Get-Command pi -ErrorAction Stop
$temporaryTypeSafeKey = [string]::IsNullOrWhiteSpace($env:TYPESAFE_API_KEY)

if ($temporaryTypeSafeKey) {
  $secureKey = Read-Host -Prompt 'TYPESAFE_API_KEY for this Pi test only' -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $env:TYPESAFE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  if ([string]::IsNullOrWhiteSpace($env:TYPESAFE_API_KEY)) {
    throw 'A non-empty TYPESAFE_API_KEY is required to exercise Jev compaction.'
  }
}

Push-Location -LiteralPath $repoRoot
try {
  # All options are process-local. Explicit -e still loads this extension when
  # --no-extensions disables discovery of installed/global extensions.
  & $piCommand.Source `
    '--provider' 'openai-codex' `
    '--model' 'gpt-6-astra' `
    '--thinking' 'xhigh' `
    '--no-extensions' `
    '-e' $extensionPath
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
  if ($temporaryTypeSafeKey) {
    Remove-Item -LiteralPath 'Env:\TYPESAFE_API_KEY' -ErrorAction SilentlyContinue
  }
}

if ($exitCode -ne 0) {
  throw "Pi exited with code $exitCode"
}
