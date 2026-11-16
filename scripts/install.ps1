param([string]$Source = 'Chamoouske/fast-laya-plugin')

$ErrorActionPreference = 'Stop'
$Plugin = 'fast-laya-plugin'

function Step([string]$Text) { Write-Host "`n==> $Text" }

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'claude not found on PATH. Install Claude Code first: https://claude.com/claude-code'
}

Step 'laya-serve'
$laya = Get-Command laya-serve -ErrorAction SilentlyContinue
if ($laya) {
    Write-Host "already installed: $($laya.Source)"
} elseif (Get-Command uv -ErrorAction SilentlyContinue) {
    Invoke-Native 'uv' @('tool', 'install', 'laya[serve]')
} else {
    throw 'laya-serve and uv not found. Install uv (https://docs.astral.sh/uv/), then run this script again.'
}

Step 'laya-serve service (start at login, restart if it dies)'
if ($env:FAST_LAYA_NO_SERVICE -eq '1') {
    Write-Host 'skipped (FAST_LAYA_NO_SERVICE=1)'
} else {
    & (Join-Path $PSScriptRoot 'service.ps1') install
}

Step "marketplace $Plugin ($Source)"
$marketplaces = (& claude plugin marketplace list) -join "`n"
if ($marketplaces -match [regex]::Escape($Plugin)) {
    Invoke-Native 'claude' @('plugin', 'marketplace', 'update', $Plugin)
} else {
    Invoke-Native 'claude' @('plugin', 'marketplace', 'add', $Source)
}

Step "plugin $Plugin@$Plugin"
Invoke-Native 'claude' @('plugin', 'install', "$Plugin@$Plugin")

$userFlag = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'User')
if ($env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS -ne '1' -and $userFlag -ne '1') {
    Write-Host "`nwarning: function hooks are off. To turn them on for your user, run:"
    Write-Host '  [Environment]::SetEnvironmentVariable("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "1", "User")'
}

Write-Host "`nDone. Restart Claude Code or run /reload-plugins. laya-serve now starts at every login and restarts if it dies."
