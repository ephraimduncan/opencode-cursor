param(
	[ValidateSet("start", "stop", "restart", "status", "auth-status", "sync-models", "build", "install-deps")]
	[string]$Action = "status",
	[int]$Port = 32124,
	[string]$Host_ = "127.0.0.1",
	[string]$HealthUrl = "http://127.0.0.1:32124/health",
	[switch]$NoExit
)

$ErrorActionPreference = "Stop"

# ── Utility Functions ──────────────────────────────────────────────

function Get-RepoRoot {
	return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\"))
}

function Get-ConfigPath {
	return Join-Path $PSScriptRoot "..\config.json"
}

function Load-Config {
	$configPath = Get-ConfigPath
	if (-not (Test-Path $configPath)) {
		return $null
	}
	return (Get-Content $configPath -Raw | ConvertFrom-Json)
}

function Get-BunCommand {
	$command = Get-Command bun -ErrorAction SilentlyContinue
	if (-not $command) {
		throw "bun command not found in PATH. Install from https://bun.sh"
	}
	return $command.Source
}

function Get-CursorAgentCommand {
	$command = Get-Command cursor-agent -ErrorAction SilentlyContinue
	if (-not $command) {
		throw "cursor-agent command not found in PATH. Install from https://cursor.com"
	}
	return $command.Source
}

# ── Port Management ────────────────────────────────────────────────

function Get-PortProcessIds {
	param([int]$PortNumber)

	$connections = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue
	if (-not $connections) {
		return @()
	}

	return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-LingeringPortProcess {
	param([int]$PortNumber)

	foreach ($processId in Get-PortProcessIds -PortNumber $PortNumber) {
		try {
			$proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
			$procName = if ($proc) { $proc.ProcessName } else { "unknown" }
			Stop-Process -Id $processId -Force -ErrorAction Stop
			Write-Host "[proxy-mgr] killed PID $processId ($procName) on port $PortNumber" -ForegroundColor Yellow
		} catch {
			Write-Warning "[proxy-mgr] failed to kill PID ${processId}: $($_.Exception.Message)"
		}
	}
}

function Wait-ForPortFree {
	param(
		[int]$PortNumber,
		[int]$TimeoutSeconds = 10
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	while ((Get-Date) -lt $deadline) {
		if ((Get-PortProcessIds -PortNumber $PortNumber).Count -eq 0) {
			return $true
		}
		Start-Sleep -Milliseconds 300
	}
	return $false
}

# ── Health Check ───────────────────────────────────────────────────

function Wait-ForHealth {
	param(
		[string]$Url,
		[int]$TimeoutSeconds = 20
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	while ((Get-Date) -lt $deadline) {
		try {
			$response = Invoke-RestMethod -Uri $Url -TimeoutSec 2
			if ($response.ok -eq $true) {
				return $true
			}
		} catch {}

		Start-Sleep -Milliseconds 500
	}

	return $false
}

function Test-ProxyHealth {
	param([string]$Url)

	try {
		$response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
		return ($response.ok -eq $true)
	} catch {
		return $false
	}
}

# ── Auth Detection ─────────────────────────────────────────────────

function Get-CursorAuthPaths {
	$home_ = $env:USERPROFILE
	$paths = @()
	$authFiles = @("cli-config.json", "auth.json")

	# Windows: check ~/.cursor and ~/.config/cursor
	foreach ($file in $authFiles) {
		$paths += Join-Path $home_ ".cursor\$file"
	}
	foreach ($file in $authFiles) {
		$paths += Join-Path $home_ ".config\cursor\$file"
	}

	return $paths
}

function Get-AuthSnapshot {
	foreach ($authPath in Get-CursorAuthPaths) {
		if (-not (Test-Path $authPath)) {
			continue
		}

		try {
			$json = Get-Content $authPath -Raw | ConvertFrom-Json

			# Try to extract email from id_token JWT
			$email = "unknown"
			$idToken = $null

			# Handle different auth file formats
			if ($json.tokens -and $json.tokens.id_token) {
				$idToken = $json.tokens.id_token
			} elseif ($json.id_token) {
				$idToken = $json.id_token
			}

			if ($idToken) {
				$parts = $idToken.Split('.')
				if ($parts.Length -ge 2) {
					$payload = $parts[1].Replace('-', '+').Replace('_', '/')
					switch ($payload.Length % 4) {
						2 { $payload += '==' }
						3 { $payload += '=' }
					}
					try {
						$decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
						$claims = ConvertFrom-Json $decoded
						if ($claims.email) {
							$email = $claims.email
						}
					} catch {}
				}
			}

			return [pscustomobject]@{
				Path = $authPath
				Email = $email
				Format = if ($json.tokens) { "legacy (auth.json)" } else { "current (cli-config.json)" }
				Valid = $true
			}
		} catch {
			continue
		}
	}

	return $null
}

# ── Proxy Lifecycle ────────────────────────────────────────────────

function Stop-Proxy {
	param([int]$PortNumber)

	Write-Host "[proxy-mgr] stopping proxy on port $PortNumber..." -ForegroundColor Cyan

	# Kill processes on the port
	$portPids = Get-PortProcessIds -PortNumber $PortNumber
	if ($portPids.Count -eq 0) {
		Write-Host "[proxy-mgr] no process found on port $PortNumber" -ForegroundColor DarkGray
		return
	}

	Stop-LingeringPortProcess -PortNumber $PortNumber
	Start-Sleep -Milliseconds 500

	# Verify
	if ((Get-PortProcessIds -PortNumber $PortNumber).Count -gt 0) {
		Write-Host "[proxy-mgr] port still occupied, force-killing again..." -ForegroundColor Yellow
		Stop-LingeringPortProcess -PortNumber $PortNumber
		Start-Sleep -Milliseconds 800
	}

	if ((Get-PortProcessIds -PortNumber $PortNumber).Count -gt 0) {
		Write-Warning "[proxy-mgr] failed to free port $PortNumber"
	} else {
		Write-Host "[proxy-mgr] port $PortNumber is free" -ForegroundColor Green
	}
}

function Start-Proxy {
	param(
		[int]$PortNumber,
		[string]$HealthUrl_
	)

	$repoRoot = Get-RepoRoot
	$bun = Get-BunCommand

	# Check if port is already in use
	$existingPids = Get-PortProcessIds -PortNumber $PortNumber
	if ($existingPids.Count -gt 0) {
		# Check if it's our proxy
		$isHealthy = Test-ProxyHealth -Url $HealthUrl_
		if ($isHealthy) {
			Write-Host "[proxy-mgr] proxy is already running on port $PortNumber" -ForegroundColor Yellow
			return
		}
		Write-Host "[proxy-mgr] port $PortNumber is occupied but not healthy, cleaning up..." -ForegroundColor Yellow
		Stop-Proxy -PortNumber $PortNumber
	}

	Write-Host "[proxy-mgr] starting proxy on port $PortNumber..." -ForegroundColor Cyan

	# Build first if needed
	$distDir = Join-Path $repoRoot "dist"
	if (-not (Test-Path $distDir) -or (Get-ChildItem $distDir -Filter "*.js" -ErrorAction SilentlyContinue).Count -eq 0) {
		Write-Host "[proxy-mgr] building project first..." -ForegroundColor Yellow
		Set-Location $repoRoot
		& $bun run build
		if ($LASTEXITCODE -ne 0) {
			throw "build failed with exit code $LASTEXITCODE"
		}
	}

	# Start proxy in background
	$pluginEntry = Join-Path $repoRoot "src\plugin-entry.ts"
	$env:CURSOR_ACP_PORT = $PortNumber

	$pinfo = New-Object System.Diagnostics.ProcessStartInfo
	$pinfo.FileName = $bun
	$pinfo.Arguments = "run $pluginEntry"
	$pinfo.WorkingDirectory = $repoRoot
	$pinfo.UseShellExecute = $false
	$pinfo.CreateNoWindow = $true
	$pinfo.RedirectStandardOutput = $true
	$pinfo.RedirectStandardError = $true

	# Set environment
	$pinfo.EnvironmentVariables["CURSOR_ACP_PORT"] = "$PortNumber"

	$process = [System.Diagnostics.Process]::Start($pinfo)

	if (-not $process -or $process.HasExited) {
		throw "Failed to start proxy process"
	}

	Write-Host "[proxy-mgr] proxy process started (PID: $($process.Id))" -ForegroundColor DarkGray

	# Save PID
	$pidFile = Join-Path $PSScriptRoot "..\proxy.pid"
	$process.Id | Set-Content -Path $pidFile -Encoding UTF8

	# Wait for health
	Write-Host "[proxy-mgr] waiting for health check..." -ForegroundColor DarkGray
	$healthy = Wait-ForHealth -Url $HealthUrl_ -TimeoutSeconds 20

	if ($healthy) {
		Write-Host "[proxy-mgr] proxy is running on http://${Host_}:${PortNumber}/v1" -ForegroundColor Green
	} else {
		Write-Warning "[proxy-mgr] proxy started but health check did not pass"
		Write-Warning "[proxy-mgr] check logs: CURSOR_ACP_LOG_LEVEL=debug bun run $pluginEntry"
	}
}

# ── Status Display ─────────────────────────────────────────────────

function Write-StatusLine([string]$Label, [string]$Value, [string]$Color = "White") {
	Write-Host ("  {0,-12}: " -f $Label) -NoNewline -ForegroundColor Gray
	Write-Host $Value -ForegroundColor $Color
}

function Show-FullStatus {
	Write-Host "=======================================================" -ForegroundColor DarkGray
	Write-Host " OPENCODE-CURSOR PROXY STATUS" -ForegroundColor Cyan
	Write-Host "=======================================================" -ForegroundColor DarkGray
	Write-Host ""

	# Proxy Status
	Write-Host "[ PROXY ]" -ForegroundColor White
	$portPids = Get-PortProcessIds -PortNumber $Port
	$healthy = Test-ProxyHealth -Url $HealthUrl

	if ($healthy) {
		Write-StatusLine "Status" "RUNNING" "Green"
	} elseif ($portPids.Count -gt 0) {
		Write-StatusLine "Status" "UNHEALTHY (port occupied)" "Yellow"
	} else {
		Write-StatusLine "Status" "STOPPED" "Red"
	}

	Write-StatusLine "Port" "$Port" "White"
	Write-StatusLine "Health URL" "$HealthUrl" "DarkGray"

	if ($portPids.Count -gt 0) {
		foreach ($pidItem in $portPids) {
			$proc = Get-Process -Id $pidItem -ErrorAction SilentlyContinue
			$name = if ($proc) { $proc.ProcessName } else { "unknown" }
			Write-StatusLine "PID" "$pidItem ($name)" "White"
		}
	}
	Write-Host ""

	# Auth Status
	Write-Host "[ AUTH ]" -ForegroundColor White
	$auth = Get-AuthSnapshot
	if ($auth) {
		Write-StatusLine "Status" "AUTHENTICATED" "Green"
		Write-StatusLine "Email" $auth.Email "Cyan"
		Write-StatusLine "Format" $auth.Format "DarkGray"
		Write-StatusLine "File" $auth.Path "DarkGray"
	} else {
		Write-StatusLine "Status" "NOT AUTHENTICATED" "Red"
		Write-StatusLine "Action" "Run: opencode auth login --provider cursor" "Yellow"
	}
	Write-Host ""

	# Dependencies
	Write-Host "[ DEPENDENCIES ]" -ForegroundColor White

	$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
	if ($bunCmd) {
		try {
			$bunVer = & bun --version 2>&1
			Write-StatusLine "bun" "$bunVer" "Green"
		} catch {
			Write-StatusLine "bun" "found but version unknown" "Yellow"
		}
	} else {
		Write-StatusLine "bun" "NOT FOUND" "Red"
	}

	$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
	if ($nodeCmd) {
		try {
			$nodeVer = & node --version 2>&1
			Write-StatusLine "node" "$nodeVer" "Green"
		} catch {
			Write-StatusLine "node" "found but version unknown" "Yellow"
		}
	} else {
		Write-StatusLine "node" "NOT FOUND (optional)" "DarkGray"
	}

	Write-Host ""

	# OpenCode Config
	Write-Host "[ OPENCODE CONFIG ]" -ForegroundColor White
	$configPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
	if (Test-Path $configPath) {
		Write-StatusLine "Config" "found" "Green"
		try {
			$oc = Get-Content $configPath -Raw | ConvertFrom-Json
			$hasCursorProvider = $null -ne $oc.provider.'cursor-acp'
			$hasPlugin = $false
			if ($oc.plugin) {
				$hasPlugin = ($oc.plugin | Where-Object { $_ -match "cursor|open-cursor" }).Count -gt 0
			}
			Write-StatusLine "Provider" $(if ($hasCursorProvider) { "cursor-acp configured" } else { "cursor-acp MISSING" }) $(if ($hasCursorProvider) { "Green" } else { "Red" })
			Write-StatusLine "Plugin" $(if ($hasPlugin) { "registered" } else { "MISSING" }) $(if ($hasPlugin) { "Green" } else { "Red" })
		} catch {
			Write-StatusLine "Config" "parse error" "Red"
		}
	} else {
		Write-StatusLine "Config" "NOT FOUND" "Red"
		Write-StatusLine "Path" $configPath "DarkGray"
	}

	Write-Host ""
	Write-Host "-------------------------------------------------------" -ForegroundColor DarkGray
}

# ── Build ──────────────────────────────────────────────────────────

function Build-Project {
	$repoRoot = Get-RepoRoot
	$bun = Get-BunCommand

	Write-Host "[proxy-mgr] building project..." -ForegroundColor Cyan
	Set-Location $repoRoot
	& $bun run build
	if ($LASTEXITCODE -ne 0) {
		throw "build failed with exit code $LASTEXITCODE"
	}
	Write-Host "[proxy-mgr] build complete" -ForegroundColor Green
}

# ── Install Dependencies ──────────────────────────────────────────

function Install-Dependencies {
	$repoRoot = Get-RepoRoot
	$bun = Get-BunCommand

	Write-Host "[proxy-mgr] installing dependencies..." -ForegroundColor Cyan
	Set-Location $repoRoot
	& $bun install
	if ($LASTEXITCODE -ne 0) {
		throw "dependency install failed with exit code $LASTEXITCODE"
	}
	Write-Host "[proxy-mgr] dependencies installed" -ForegroundColor Green
}

# ── Main Switch ────────────────────────────────────────────────────

switch ($Action) {
	"status" {
		Show-FullStatus
		exit 0
	}
	"start" {
		Start-Proxy -PortNumber $Port -HealthUrl_ $HealthUrl
		exit 0
	}
	"stop" {
		Stop-Proxy -PortNumber $Port
		exit 0
	}
	"restart" {
		Stop-Proxy -PortNumber $Port
		Start-Sleep -Milliseconds 500
		Start-Proxy -PortNumber $Port -HealthUrl_ $HealthUrl
		Write-Host "[proxy-mgr] restart complete" -ForegroundColor Green
		exit 0
	}
	"auth-status" {
		$auth = Get-AuthSnapshot
		if ($auth) {
			Write-Host "[proxy-mgr] authenticated as $($auth.Email)" -ForegroundColor Green
			Write-Host "[proxy-mgr] format: $($auth.Format)" -ForegroundColor DarkGray
			Write-Host "[proxy-mgr] path: $($auth.Path)" -ForegroundColor DarkGray
		} else {
			Write-Host "[proxy-mgr] not authenticated" -ForegroundColor Red
			Write-Host "[proxy-mgr] run: opencode auth login --provider cursor" -ForegroundColor Yellow
		}
		exit 0
	}
	"sync-models" {
		Sync-Models
		exit 0
	}
	"build" {
		Build-Project
		exit 0
	}
	"install-deps" {
		Install-Dependencies
		exit 0
	}
}
