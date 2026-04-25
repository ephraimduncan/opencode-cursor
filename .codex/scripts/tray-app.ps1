Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "SilentlyContinue"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\"))
$ProxyManagerScript = Join-Path $PSScriptRoot "proxy-manager.ps1"

# To ensure only one instance of the tray app runs
$mutex = New-Object System.Threading.Mutex($false, "Global\OpenCodeCursorProxyTrayAppMutex")
if (-not $mutex.WaitOne(0, $false)) {
    [System.Windows.Forms.MessageBox]::Show("Tray app is already running.", "OpenCode-Cursor Proxy", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    exit
}

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = "Minimized"
$form.Visible = $false

$contextMenu = New-Object System.Windows.Forms.ContextMenu

$statusMenuItem = New-Object System.Windows.Forms.MenuItem
$statusMenuItem.Text = "Status: Checking..."
$statusMenuItem.Enabled = $false

$startMenuItem = New-Object System.Windows.Forms.MenuItem
$startMenuItem.Text = "Start Proxy"
$startMenuItem.add_Click({
    $notifyIcon.ShowBalloonTip(2000, "OpenCode-Cursor Proxy", "Starting proxy...", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ProxyManagerScript`" -Action start" -Wait
    Update-Status
})

$stopMenuItem = New-Object System.Windows.Forms.MenuItem
$stopMenuItem.Text = "Stop Proxy"
$stopMenuItem.add_Click({
    $notifyIcon.ShowBalloonTip(2000, "OpenCode-Cursor Proxy", "Stopping proxy...", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ProxyManagerScript`" -Action stop" -Wait
    Update-Status
})

$restartMenuItem = New-Object System.Windows.Forms.MenuItem
$restartMenuItem.Text = "Restart Proxy"
$restartMenuItem.add_Click({
    $notifyIcon.ShowBalloonTip(2000, "OpenCode-Cursor Proxy", "Restarting proxy...", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ProxyManagerScript`" -Action restart" -Wait
    Update-Status
})

$menuMenuItem = New-Object System.Windows.Forms.MenuItem
$menuMenuItem.Text = "Open Management Menu"
$menuMenuItem.add_Click({
    Start-Process cmd -ArgumentList "/c cd /d `"$RepoRoot`" && title OpenCode-Cursor Manager && .codex\launchers\opencode-cursor.bat menu"
})

$exitMenuItem = New-Object System.Windows.Forms.MenuItem
$exitMenuItem.Text = "Exit Tray App"
$exitMenuItem.add_Click({
    $notifyIcon.Visible = $false
    $timer.Stop()
    $form.Close()
    $mutex.ReleaseMutex()
    [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.AddRange(@(
    $statusMenuItem, 
    (New-Object System.Windows.Forms.MenuItem("-")), 
    $startMenuItem, 
    $stopMenuItem, 
    $restartMenuItem,
    (New-Object System.Windows.Forms.MenuItem("-")), 
    $menuMenuItem, 
    (New-Object System.Windows.Forms.MenuItem("-")), 
    $exitMenuItem
))

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Text = "OpenCode-Cursor Proxy"
$notifyIcon.Visible = $true

function Update-Status {
    $port = 32124
    $healthUrl = "http://127.0.0.1:${port}/health"

    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    $healthy = $false
    
    if ($connections) {
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($response -and $response.ok -eq $true) { 
                $healthy = $true 
            }
        } catch {}
    }

    if ($healthy) {
        if ($statusMenuItem.Text -ne "Status: RUNNING") {
            $statusMenuItem.Text = "Status: RUNNING"
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
            $notifyIcon.Text = "OpenCode-Cursor Proxy (RUNNING)"
            $startMenuItem.Enabled = $false
            $stopMenuItem.Enabled = $true
            $restartMenuItem.Enabled = $true
        }
    } elseif ($connections) {
        if ($statusMenuItem.Text -ne "Status: UNHEALTHY (Port in use)") {
            $statusMenuItem.Text = "Status: UNHEALTHY (Port in use)"
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
            $notifyIcon.Text = "OpenCode-Cursor Proxy (UNHEALTHY)"
            $startMenuItem.Enabled = $true
            $stopMenuItem.Enabled = $true
            $restartMenuItem.Enabled = $true
        }
    } else {
        if ($statusMenuItem.Text -ne "Status: STOPPED") {
            $statusMenuItem.Text = "Status: STOPPED"
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
            $notifyIcon.Text = "OpenCode-Cursor Proxy (STOPPED)"
            $startMenuItem.Enabled = $true
            $stopMenuItem.Enabled = $false
            $restartMenuItem.Enabled = $false
        }
    }
}

Update-Status

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Update-Status })
$timer.Start()

$notifyIcon.add_DoubleClick({
    Start-Process cmd -ArgumentList "/c cd /d `"$RepoRoot`" && title OpenCode-Cursor Manager && .codex\launchers\opencode-cursor.bat menu"
})

[System.Windows.Forms.Application]::Run($form)
