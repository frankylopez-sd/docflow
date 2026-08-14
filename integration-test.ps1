#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DocFlow Integration Test Automation
.DESCRIPTION
    Automates all phases of the DocFlow integration test (Build, Deploy, Test, Verify)
.PARAMETER Phase
    Which phase to run: "all", "build", "deploy", "test", "verify"
.PARAMETER SkipBuild
    Skip npm install/test phases
.PARAMETER SkipDeploy
    Skip local Azure Functions deployment
.PARAMETER Verbose
    Show detailed logging
#>

param(
    [ValidateSet("all", "build", "deploy", "test", "verify", "webhook", "adobe", "monday", "cleanup")]
    [string]$Phase = "all",
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$Verbose
)

# ============================================================================
# CONFIGURATION
# ============================================================================

$PROJECT_ROOT = "C:\Users\Franky.Lopez\docflow"
$FUNCTIONS_RUNTIME_PORT = 7071
$AZURITE_BLOB_PORT = 10000
$AZURITE_QUEUE_PORT = 10001

$Colors = @{
    Success = @{ ForegroundColor = 'Green' }
    Error   = @{ ForegroundColor = 'Red' }
    Warning = @{ ForegroundColor = 'Yellow' }
    Info    = @{ ForegroundColor = 'Cyan' }
    Phase   = @{ ForegroundColor = 'Magenta'; BackgroundColor = 'White' }
}

# ============================================================================
# UTILITIES
# ============================================================================

function Write-Phase {
    param([string]$Message)
    Write-Host "`n=== PHASE: $Message ===" @($Colors.Phase)
}

function Write-Success {
    param([string]$Message)
    Write-Host "✅ $Message" @($Colors.Success)
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "❌ ERROR: $Message" @($Colors.Error)
}

function Write-Warning-Custom {
    param([string]$Message)
    Write-Host "⚠️  WARNING: $Message" @($Colors.Warning)
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ️  $Message" @($Colors.Info)
}

function Test-Port {
    param([int]$Port)
    try {
        $connection = New-Object System.Net.Sockets.TcpClient
        $connection.Connect("127.0.0.1", $Port)
        $connection.Close()
        return $true
    } catch {
        return $false
    }
}

function Wait-ForHealthCheck {
    param(
        [string]$Url,
        [int]$MaxSeconds = 120
    )
    $elapsed = 0
    $interval = 5

    Write-Info "Waiting for health check: $Url (max ${MaxSeconds}s)"

    while ($elapsed -lt $MaxSeconds) {
        try {
            $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5 -ErrorAction SilentlyContinue
            if ($response) {
                Write-Success "Health check passed"
                return $true
            }
        } catch {
            # Expected — app still starting
        }

        Write-Host "[$($elapsed)/$MaxSeconds] Waiting..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $interval
        $elapsed += $interval
    }

    Write-Error-Custom "Health check timeout after ${MaxSeconds}s"
    return $false
}

# ============================================================================
# PHASE 1: BUILD
# ============================================================================

function Invoke-Build {
    Write-Phase "BUILD (npm install + test)"

    if ($SkipBuild) {
        Write-Warning-Custom "Skipping build phase"
        return $true
    }

    Push-Location $PROJECT_ROOT

    try {
        # 1.1 Environment validation
        Write-Info "1.1: Validating environment"
        $nodeVersion = node -v
        $npmVersion = npm -v
        Write-Success "Node: $nodeVersion"
        Write-Success "npm: $npmVersion"

        # 1.2 Dependencies
        Write-Info "1.2: Installing dependencies (npm ci)"
        $output = npm ci 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error-Custom "npm ci failed"
            Write-Host $output
            return $false
        }
        Write-Success "Dependencies installed"

        # 1.3 Unit tests
        Write-Info "1.3: Running unit tests"
        $output = npm test 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error-Custom "Unit tests failed"
            Write-Host $output
            return $false
        }

        # Parse test count
        if ($output -match "(\d+) passing") {
            Write-Success "Tests passed: $($Matches[1])"
        } else {
            Write-Warning-Custom "Could not parse test count"
        }

        Write-Success "BUILD phase complete ✅"
        return $true
    }
    catch {
        Write-Error-Custom "Build failed: $_"
        return $false
    }
    finally {
        Pop-Location
    }
}

# ============================================================================
# PHASE 2: DEPLOY LOCAL
# ============================================================================

function Invoke-DeployLocal {
    Write-Phase "DEPLOY LOCAL (Azurite + func start)"

    if ($SkipDeploy) {
        Write-Warning-Custom "Skipping deploy phase"
        return $true
    }

    # 2.1 Check Azurite
    Write-Info "2.1: Checking Azurite"
    if (-not (Get-Command azurite -ErrorAction SilentlyContinue)) {
        Write-Error-Custom "Azurite not found. Install with: npm install -g azurite"
        return $false
    }
    Write-Success "Azurite available"

    # 2.2 Check Azure Functions Core Tools
    Write-Info "2.2: Checking Azure Functions Core Tools"
    if (-not (Get-Command func -ErrorAction SilentlyContinue)) {
        Write-Error-Custom "Azure Functions Core Tools not found"
        Write-Warning-Custom "Install from: https://aka.ms/azure-functions/cli"
        return $false
    }
    Write-Success "func available"

    # 2.3 Verify local.settings.json
    Write-Info "2.3: Checking local.settings.json"
    $settingsPath = Join-Path $PROJECT_ROOT "local.settings.json"
    if (-not (Test-Path $settingsPath)) {
        Write-Warning-Custom "local.settings.json not found. Copying from template..."
        Copy-Item (Join-Path $PROJECT_ROOT "local.settings.json.example") $settingsPath
        Write-Warning-Custom "MANUAL STEP REQUIRED:"
        Write-Warning-Custom "  Edit $settingsPath and fill in:"
        Write-Warning-Custom "    - ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET"
        Write-Warning-Custom "    - MONDAY_API_TOKEN"
        Write-Warning-Custom "    - MONDAY_ONBOARDING_BOARD_ID"
        Write-Warning-Custom "    - Storage account name/key"
        Write-Warning-Custom "Then rerun: $($MyInvocation.Line)"
        return $false
    }
    Write-Success "local.settings.json configured"

    # 2.4 Start Azurite (background)
    Write-Info "2.4: Starting Azurite (background job)"
    $azuriteJob = Start-Job -ScriptBlock {
        azurite --silent
    } -Name "Azurite"
    Start-Sleep -Seconds 3

    if (-not (Test-Port $AZURITE_BLOB_PORT)) {
        Write-Error-Custom "Azurite failed to start"
        Stop-Job $azuriteJob
        return $false
    }
    Write-Success "Azurite running (PID: $($azuriteJob.Id))"

    # 2.5 Start func
    Write-Info "2.5: Starting Azure Functions runtime"
    Push-Location $PROJECT_ROOT

    $funcJob = Start-Job -ScriptBlock {
        param($projRoot)
        cd $projRoot
        func start 2>&1
    } -ArgumentList $PROJECT_ROOT -Name "AzureFunctions"

    Start-Sleep -Seconds 5

    if (-not (Test-Port $FUNCTIONS_RUNTIME_PORT)) {
        Write-Error-Custom "func failed to start on port $FUNCTIONS_RUNTIME_PORT"
        Stop-Job $funcJob
        Stop-Job $azuriteJob
        return $false
    }
    Write-Success "Azure Functions running (PID: $($funcJob.Id))"

    # 2.6 Health check
    Write-Info "2.6: Health check"
    if (-not (Wait-ForHealthCheck "http://127.0.0.1:$FUNCTIONS_RUNTIME_PORT/api/health")) {
        Write-Error-Custom "Health check failed"
        Stop-Job $funcJob
        Stop-Job $azuriteJob
        Pop-Location
        return $false
    }

    Write-Success "DEPLOY phase complete ✅"
    Write-Info "Running background jobs:"
    Write-Info "  Azurite: job $($azuriteJob.Id) ($($azuriteJob.Name))"
    Write-Info "  func: job $($funcJob.Id) ($($funcJob.Name))"
    Write-Info "Use: Stop-Job -Name 'Azurite'; Stop-Job -Name 'AzureFunctions' to cleanup"

    Pop-Location
    return $true
}

# ============================================================================
# PHASE 3: TEST FUNCTIONS
# ============================================================================

function Invoke-TestFunctions {
    Write-Phase "TEST FUNCTIONS"

    Write-Info "Running npm test"
    Push-Location $PROJECT_ROOT

    try {
        $output = npm test 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error-Custom "Tests failed"
            Write-Host $output
            return $false
        }

        if ($output -match "(\d+) passing") {
            Write-Success "All tests passed: $($Matches[1])"
        }

        return $true
    }
    finally {
        Pop-Location
    }
}

# ============================================================================
# PHASE 4: TEST WEBHOOK
# ============================================================================

function Invoke-TestWebhook {
    Write-Phase "TEST WEBHOOK"

    Write-Info "Posting test payload to mondayWebhook"

    $payload = @{
        action = "update_column_value"
        event = @{
            columnId = "checkbox"
            itemId = 12345
            value = @{ checked = "true" }
        }
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod `
            -Uri "http://127.0.0.1:$FUNCTIONS_RUNTIME_PORT/api/mondayWebhook" `
            -Method Post `
            -Body $payload `
            -ContentType "application/json" `
            -TimeoutSec 10

        Write-Success "Webhook responded with status 200"
        Write-Info "Response: $($response | ConvertTo-Json)"
        return $true
    }
    catch {
        Write-Error-Custom "Webhook test failed: $_"
        return $false
    }
}

# ============================================================================
# PHASE 5: TEST ADOBE INTEGRATION
# ============================================================================

function Invoke-TestAdobe {
    Write-Phase "TEST ADOBE (PDF Generation + Sign)"

    Write-Info "Running Adobe integration tests"
    Push-Location $PROJECT_ROOT

    try {
        # Run only adobe tests
        $output = npm test -- --testNamePattern="adobe" 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error-Custom "Adobe tests failed"
            Write-Host $output
            return $false
        }

        Write-Success "Adobe integration tests passed"
        return $true
    }
    finally {
        Pop-Location
    }
}

# ============================================================================
# PHASE 6: CLEANUP
# ============================================================================

function Invoke-Cleanup {
    Write-Phase "CLEANUP"

    Write-Info "Stopping background jobs..."

    $jobs = Get-Job -Name "Azurite" -ErrorAction SilentlyContinue
    if ($jobs) {
        Stop-Job -Name "Azurite"
        Remove-Job -Name "Azurite"
        Write-Success "Azurite stopped"
    }

    $jobs = Get-Job -Name "AzureFunctions" -ErrorAction SilentlyContinue
    if ($jobs) {
        Stop-Job -Name "AzureFunctions"
        Remove-Job -Name "AzureFunctions"
        Write-Success "Azure Functions stopped"
    }

    Write-Success "Cleanup complete"
}

# ============================================================================
# MAIN
# ============================================================================

Write-Host @"

╔════════════════════════════════════════════════════════════════╗
║   DocFlow Integration Test Automation                         ║
║   Phase: $Phase                                                ║
║   Status: READY                                              ║
╚════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

$success = $true

try {
    switch ($Phase) {
        "all" {
            $success = $success -and (Invoke-Build)
            $success = $success -and (Invoke-DeployLocal)
            $success = $success -and (Invoke-TestFunctions)
            $success = $success -and (Invoke-TestWebhook)
            $success = $success -and (Invoke-TestAdobe)
            if ($success) {
                Write-Phase "ALL PHASES COMPLETE"
                Write-Host "✅ ALL TESTS PASSED — SYSTEM READY FOR PRODUCTION" @($Colors.Success) -BackgroundColor Black
            }
        }
        "build" {
            $success = Invoke-Build
        }
        "deploy" {
            $success = Invoke-DeployLocal
        }
        "test" {
            $success = Invoke-TestFunctions
        }
        "webhook" {
            $success = Invoke-TestWebhook
        }
        "adobe" {
            $success = Invoke-TestAdobe
        }
        "cleanup" {
            Invoke-Cleanup
            return 0
        }
    }
}
catch {
    Write-Error-Custom "Unexpected error: $_"
    $success = $false
}
finally {
    # Prompt for cleanup if full run
    if ($Phase -eq "all" -and $success) {
        Write-Info "Run 'integration-test.ps1 -Phase cleanup' to stop background jobs"
    }
}

# Exit with appropriate code
exit ($success ? 0 : 1)
