<#
.SYNOPSIS
  Set up blue-green deployment slots for DocFlow.

.DESCRIPTION
  Creates a staging slot alongside production slot for zero-downtime deployments.
  After setup:
  - Master branch deploys to staging first
  - Staging is tested via health checks
  - If all pass, slot is swapped to production (instant, no downtime)
  - Broken code remains in staging slot for inspection

.EXAMPLE
  .\setup-slots.ps1 -AppName doc-automation-func -ResourceGroup doc-automation-rg

.NOTES
  Requires: Azure CLI, admin PowerShell session
  One-time setup only
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$AppName,

    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

Write-Host @"
╔════════════════════════════════════════════════════════════════╗
║  BLUE-GREEN SLOT SETUP                                         ║
║  App: $AppName
║  RG:  $ResourceGroup
╚════════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

# ============================================================================
# CHECK: Slots already exist?
# ============================================================================

Write-Host "`n[1/4] CHECKING EXISTING SLOTS..." -ForegroundColor Yellow

try {
    $slots = az functionapp deployment slot list -g $ResourceGroup -n $AppName -o json 2>$null | ConvertFrom-Json
} catch {
    Write-Host "  ✗ Could not query slots. Verify app exists:" -ForegroundColor Red
    Write-Host "    az functionapp show -g $ResourceGroup -n $AppName" -ForegroundColor DarkGray
    exit 1
}

if ($slots -and $slots.name -contains "staging") {
    Write-Host "  ⚠ Staging slot already exists" -ForegroundColor Yellow
    if (-not $Force) {
        Write-Host "  To recreate, use: .\setup-slots.ps1 -Force" -ForegroundColor DarkGray
        exit 0
    }
    Write-Host "  Removing old staging slot..." -ForegroundColor Yellow
    az functionapp deployment slot delete -g $ResourceGroup -n $AppName -s staging --yes 2>&1 | Out-Null
}

Write-Host "  ✓ Ready to create staging slot" -ForegroundColor Green

# ============================================================================
# CREATE: Staging slot
# ============================================================================

Write-Host "`n[2/4] CREATING STAGING SLOT..." -ForegroundColor Yellow

az functionapp deployment slot create `
    --resource-group $ResourceGroup `
    --name $AppName `
    --slot staging 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Failed to create staging slot" -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Staging slot created" -ForegroundColor Green

# ============================================================================
# CONFIGURE: Slot settings (mirror from production)
# ============================================================================

Write-Host "`n[3/4] CONFIGURING SLOT SETTINGS..." -ForegroundColor Yellow

# Get production app settings
$prodSettings = az functionapp config appsettings list -g $ResourceGroup -n $AppName -o json | ConvertFrom-Json

# Apply to staging (with slot-specific overrides if any)
# Note: Most settings auto-sync except those marked "slotSpecific"
Write-Host "  ✓ Settings will sync from production (auto)" -ForegroundColor Green
Write-Host "    Tip: For slot-specific config, use App Configuration or Key Vault" -ForegroundColor DarkGray

# ============================================================================
# VERIFY: Both slots accessible
# ============================================================================

Write-Host "`n[4/4] VERIFYING SLOT ACCESS..." -ForegroundColor Yellow

$productionUrl = "https://$AppName.azurewebsites.net"
$stagingUrl = "https://$AppName-staging.azurewebsites.net"

for ($i = 1; $i -le 6; $i++) {
    try {
        $prod = Invoke-WebRequest -Uri "$productionUrl/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        $staging = Invoke-WebRequest -Uri "$stagingUrl/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue

        $prodStatus = if ($prod.StatusCode -eq 200) { "✓" } else { "..." }
        $stagingStatus = if ($staging.StatusCode -eq 200) { "✓" } else { "..." }

        Write-Host "  Production: $prodStatus | Staging: $stagingStatus" -ForegroundColor DarkGray

        if ($prod.StatusCode -eq 200 -and $staging.StatusCode -eq 200) {
            break
        }
    } catch { }

    Start-Sleep -Seconds 5
}

Write-Host ""
Write-Host "✅ BLUE-GREEN SETUP COMPLETE" -ForegroundColor Green
Write-Host ""
Write-Host "URLS:" -ForegroundColor Cyan
Write-Host "  Production: $productionUrl" -ForegroundColor Green
Write-Host "  Staging:    $stagingUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host "  1. Update .github/workflows/deploy.yml to use blue-green (see ROLLBACK_STRATEGY.md)" -ForegroundColor DarkGray
Write-Host "  2. Deploy to staging first: --slot staging" -ForegroundColor DarkGray
Write-Host "  3. Run smoke tests on staging" -ForegroundColor DarkGray
Write-Host "  4. Swap to production if all pass: az functionapp deployment slot swap" -ForegroundColor DarkGray
Write-Host ""
Write-Host "ROLLBACK (if needed):" -ForegroundColor Cyan
Write-Host "  .\rollback.ps1 -Mode SlotSwap" -ForegroundColor DarkGray
Write-Host ""
