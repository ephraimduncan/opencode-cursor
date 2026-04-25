param(
	[ValidateSet("menu", "list")]
	[string]$Action = "menu"
)

$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\"))
$ProxyManagerScript = Join-Path $PSScriptRoot "proxy-manager.ps1"

# ── Display Helpers ────────────────────────────────────────────────

function Write-Banner([string]$Title) {
	Write-Host "=======================================================" -ForegroundColor DarkGray
	Write-Host (" {0}" -f $Title) -ForegroundColor Cyan
	Write-Host "=======================================================" -ForegroundColor DarkGray
	Write-Host ""
}

function Write-Value([string]$Label, [string]$Value, [string]$Color = "White") {
	Write-Host ("  {0,-12}: " -f $Label) -NoNewline -ForegroundColor Gray
	Write-Host $Value -ForegroundColor $Color
}

function Pause-Continue([string]$Message = "Press Enter to continue") {
	[void](Read-Host $Message)
}

function Read-MenuChoice([string]$Prompt) {
	return (Read-Host $Prompt).Trim()
}

# ── Quick Status Display ──────────────────────────────────────────

function Get-QuickStatus {
	$port = 32124
	$healthUrl = "http://127.0.0.1:${port}/health"

	$portPids = @()
	try {
		$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
		if ($connections) {
			$portPids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
		}
	} catch {}

	$healthy = $false
	try {
		$response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
		$healthy = ($response.ok -eq $true)
	} catch {}

	return [pscustomobject]@{
		Port = $port
		PIDs = $portPids
		Healthy = $healthy
		Status = if ($healthy) { "RUNNING" } elseif ($portPids.Count -gt 0) { "UNHEALTHY" } else { "STOPPED" }
		StatusColor = if ($healthy) { "Green" } elseif ($portPids.Count -gt 0) { "Yellow" } else { "Red" }
	}
}

function Show-QuickStatus {
	$status = Get-QuickStatus
	Write-Host ("  Proxy: ") -NoNewline -ForegroundColor Gray
	Write-Host $status.Status -ForegroundColor $status.StatusColor -NoNewline
	Write-Host (" (port $($status.Port))") -ForegroundColor DarkGray
	Write-Host ""
}

# ── Menu Actions ──────────────────────────────────────────────────

function Invoke-ProxyManager([string]$ActionParam) {
	& powershell -NoProfile -ExecutionPolicy Bypass -File $ProxyManagerScript -Action $ActionParam
}

function Start-ProxyFlow {
	Write-Banner "START PROXY"
	Invoke-ProxyManager "start"
	Pause-Continue
}

function Stop-ProxyFlow {
	Write-Banner "STOP PROXY"
	Invoke-ProxyManager "stop"
	Pause-Continue
}

function Restart-ProxyFlow {
	Write-Banner "RESTART PROXY"
	Invoke-ProxyManager "restart"
	Pause-Continue
}

function Show-StatusFlow {
	Invoke-ProxyManager "status"
	Pause-Continue
}

function Show-AuthStatusFlow {
	Write-Banner "AUTH STATUS"
	Invoke-ProxyManager "auth-status"
	Write-Host ""
	
	$choice = Read-MenuChoice "Run OpenCode Cursor login? [y/N]"
	if ($choice -match '^(?i)y(es)?$') {
		Write-Host ""
		Write-Host "> Running: opencode auth login --provider cursor" -ForegroundColor Gray
		& opencode auth login --provider cursor
		Write-Host ""
		Invoke-ProxyManager "auth-status"
	}
	Pause-Continue
}

function Sync-ModelsFlow {
	Write-Banner "SYNC MODELS"
	Invoke-ProxyManager "sync-models"
	Pause-Continue
}

function Build-ProjectFlow {
	Write-Banner "BUILD PROJECT"
	Invoke-ProxyManager "build"
	Pause-Continue
}

function Install-DepsFlow {
	Write-Banner "INSTALL DEPENDENCIES"
	Invoke-ProxyManager "install-deps"
	Pause-Continue
}

function Show-OpenCodeConfigFlow {
	Write-Banner "OPENCODE CONFIG"
	$configPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
	if (Test-Path $configPath) {
		Write-Host "Config file: $configPath" -ForegroundColor DarkGray
		Write-Host ""
		Get-Content $configPath -Raw | Write-Host
	} else {
		Write-Host "Config not found at: $configPath" -ForegroundColor Red
		Write-Host ""
		$choice = Read-MenuChoice "Create default config? [y/N]"
		if ($choice -match '^(?i)y(es)?$') {
			$configDir = Split-Path $configPath -Parent
			if (-not (Test-Path $configDir)) {
				New-Item -ItemType Directory -Path $configDir -Force | Out-Null
			}
			$defaultConfig = @{
				plugin = @("@rama_nigg/open-cursor@latest")
				provider = @{
					"cursor-acp" = @{
						name = "Cursor ACP"
						npm = "@ai-sdk/openai-compatible"
						options = @{
							baseURL = "http://127.0.0.1:32124/v1"
						}
						models = @{
							"cursor-acp/auto" = @{ name = "Auto" }
							"cursor-acp/composer-1.5" = @{ name = "Composer 1.5" }
							"cursor-acp/opus-4.6-thinking" = @{ name = "Claude 4.6 Opus (Thinking)" }
							"cursor-acp/opus-4.6" = @{ name = "Claude 4.6 Opus" }
							"cursor-acp/sonnet-4.6" = @{ name = "Claude 4.6 Sonnet" }
							"cursor-acp/sonnet-4.6-thinking" = @{ name = "Claude 4.6 Sonnet (Thinking)" }
							"cursor-acp/gpt-5.4-high" = @{ name = "GPT-5.4 High" }
							"cursor-acp/gpt-5.4-medium" = @{ name = "GPT-5.4" }
							"cursor-acp/gemini-3.1-pro" = @{ name = "Gemini 3.1 Pro" }
						}
					}
				}
			} | ConvertTo-Json -Depth 6
			$defaultConfig | Set-Content -Path $configPath -Encoding UTF8
			Write-Host "Created default config at: $configPath" -ForegroundColor Green
		}
	}
	Pause-Continue
}

function Show-LogsFlow {
	Write-Banner "PROXY LOGS"
	Write-Host "To view debug logs, start the proxy with:" -ForegroundColor DarkGray
	Write-Host ""
	Write-Host '  $env:CURSOR_ACP_LOG_LEVEL = "debug"' -ForegroundColor White
	Write-Host "  bun run src\plugin-entry.ts" -ForegroundColor White
	Write-Host ""
	Write-Host "Or run opencode with debug:" -ForegroundColor DarkGray
	Write-Host ""
	Write-Host '  $env:CURSOR_ACP_LOG_LEVEL = "debug"' -ForegroundColor White
	Write-Host '  opencode run "your prompt" --model cursor-acp/auto' -ForegroundColor White
	Write-Host ""
	Pause-Continue
}

function Start-TrayAppFlow {
	Write-Banner "START TRAY APP"
	Start-Process wscript.exe -ArgumentList "`"$RepoRoot\.codex\launchers\start-tray.vbs`""
	Write-Host "Tray app started. Check your system tray." -ForegroundColor Green
	Pause-Continue
}

# ── Main Menu ─────────────────────────────────────────────────────

function Show-Menu {
	while ($true) {
		Clear-Host
		Write-Banner "OPENCODE-CURSOR MANAGER"
		Show-QuickStatus

		Write-Host " ── Proxy Control ──" -ForegroundColor DarkCyan
		Write-Host "  1. Show full status" -ForegroundColor White
		Write-Host "  2. Start proxy" -ForegroundColor White
		Write-Host "  3. Stop proxy" -ForegroundColor White
		Write-Host "  4. Restart proxy" -ForegroundColor White
		Write-Host "  T. Start Tray App (Background)" -ForegroundColor Cyan
		Write-Host ""
		Write-Host " ── Authentication ──" -ForegroundColor DarkCyan
		Write-Host "  5. Auth status / login" -ForegroundColor White
		Write-Host ""
		Write-Host " ── Configuration ──" -ForegroundColor DarkCyan
		Write-Host "  6. View/create OpenCode config" -ForegroundColor White
		Write-Host "  7. Sync models from cursor-agent" -ForegroundColor White
		Write-Host ""
		Write-Host " ── Build & Setup ──" -ForegroundColor DarkCyan
		Write-Host "  8. Install dependencies (bun install)" -ForegroundColor White
		Write-Host "  9. Build project (bun run build)" -ForegroundColor White
		Write-Host ""
		Write-Host " ── Help ──" -ForegroundColor DarkCyan
		Write-Host "  L. Show log/debug instructions" -ForegroundColor White
		Write-Host "  0. Exit" -ForegroundColor White
		Write-Host ""

		$choice = Read-MenuChoice "Select"
		switch ($choice) {
			"1" { Clear-Host; Show-StatusFlow }
			"2" { Clear-Host; Start-ProxyFlow }
			"3" { Clear-Host; Stop-ProxyFlow }
			"4" { Clear-Host; Restart-ProxyFlow }
			{ $_ -eq "T" -or $_ -eq "t" } { Clear-Host; Start-TrayAppFlow }
			"5" { Clear-Host; Show-AuthStatusFlow }
			"6" { Clear-Host; Show-OpenCodeConfigFlow }
			"7" { Clear-Host; Sync-ModelsFlow }
			"8" { Clear-Host; Install-DepsFlow }
			"9" { Clear-Host; Build-ProjectFlow }
			{ $_ -eq "L" -or $_ -eq "l" } { Clear-Host; Show-LogsFlow }
			"0" { return }
			default {
				Write-Host "Invalid choice." -ForegroundColor Red
				Start-Sleep -Seconds 1
			}
		}
	}
}

# ── Entry Point ───────────────────────────────────────────────────

Set-Location $RepoRoot

if ($Action -eq "list") {
	Show-QuickStatus
	exit 0
}

Show-Menu
