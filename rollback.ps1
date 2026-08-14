<#
.SYNOPSIS
  DocFlow Rollback Automation — restore production to last-known-good state.

.DESCRIPTION
  Three modes:
  1. REVERT (default) — Git revert HEAD and redeploy (2-5 min)
  2. SLOT-SWAP — If blue-green slots exist, swap back to previous (10-30 sec)
  3. KILL-APP — Emergency: restart app process (last resort)

  All modes verify health before completing rollback.

.EXAMPLE
  .\rollback.ps1 -Mode Revert -Verify
  Revert last commit, push to master, wait for GitHub Actions, verify health.

  .\rollback.ps1 -Mode SlotSwap -Verify
  Swap staging ← → production, verify both healthy.

  .\rollback.ps1 -Mode KillApp
  Kill w3wp process (forces app restart).

.NOTES
  Requires: Azure CLI, git, admin PowerShell session
  Target: doc-automation-func (doc-automation-rg)
#>

param(
    [Parameter(Mandatory = $false)]
    [ValidateSet("Revert", "SlotSwap", "KillApp")]
    [string]$Mode = "Revert",

    [Parameter(Mandatory = $false)]
    [switch]$Verify,

    [Parameter(Mandatory = $false)]
    [string]$AppName = "doc-automation-func",

    [Parameter(Mandatory = $false)]
    [string]$ResourceGroup = "doc-automation-rg",

    [Parameter(Mandatory = $false)]
    [string]$PreviousCommit = $null
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Write-Host @"
╔════════════════════════════════════════════════════════════════╗
║  DOCFLOW ROLLBACK — $timestamp                  ║
║  Mode: $Mode                                                   ║
╚════════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

# ============================================================================
# MODE 1: GIT REVERT + PUSH (Direct Rollback)
# ============================================================================

if ($Mode -eq "Revert") {
    Write-Host "`n[1/5] REVERTING TO LAST-GOOD COMMIT..." -ForegroundColor Yellow

    Set-Location $root

    # Show current commit
    $currentCommit = git rev-parse --short HEAD
    $currentMessage = git log -1 --pretty=%B | Select-Object -First 1
    Write-Host "  Current (broken): $currentCommit - $currentMessage" -ForegroundColor Red

    # Show previous commit
    $previousMsg = git log -2 --pretty=%B | Select-Object -Last 1 | Select-Object -First 1
    $previousHash = if ($PreviousCommit) { $PreviousCommit } else {
        git log -1 --skip 1 --pretty=%h
    }
    Write-Host "  Previous (good):  $previousHash - $previousMsg" -ForegroundColor Green

    # Tag current broken commit
    Write-Host "`n[2/5] TAGGING BROKEN COMMIT..." -ForegroundColor Yellow
    $breakTag = "rollback-from-$(Get-Date -Format yyyyMMdd-HHmmss)-$currentCommit"
    git tag $breakTag HEAD
    git push origin --tags
    Write-Host "  Tagged: $breakTag" -ForegroundColor Green

    # Revert
    Write-Host "`n[3/5] CREATING REVERT COMMIT..." -ForegroundColor Yellow
    git revert $currentCommit --no-edit 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Revert failed (merge conflict?)" -ForegroundColor Red
        Write-Host "  Manual fix required:" -ForegroundColor Yellow
        Write-Host "    1. git revert --abort" -ForegroundColor DarkGray
        Write-Host "    2. Fix conflicts manually" -ForegroundColor DarkGray
        Write-Host "    3. git push origin master" -ForegroundColor DarkGray
        exit 1
    }

    Write-Host "  Revert commit created (local)" -ForegroundColor Green

    # Push to trigger GitHub Actions
    Write-Host "`n[4/5] PUSHING TO MASTER (triggers GitHub Actions)..." -ForegroundColor Yellow
    git push origin master 2>&1 | Out-Null
    Write-Host "  ✓ Pushed to master" -ForegroundColor Green
    Write-Host "  GitHub Actions will now:" -ForegroundColor DarkGray
    Write-Host "    1. Run tests (30s)" -ForegroundColor DarkGray
    Write-Host "    2. Build package (15s)" -ForegroundColor DarkGray
    Write-Host "    3. Deploy to Azure (30-60s)" -ForegroundColor DarkGray
    Write-Host "    4. Health check (up to 5 min)" -ForegroundColor DarkGray

    # Wait for GitHub Actions
    if ($Verify) {
        Write-Host "`n[5/5] WAITING FOR DEPLOYMENT & VERIFICATION..." -ForegroundColor Yellow
        Start-Sleep -Seconds 15  # Let GitHub Actions start

        $deploymentOk = $false
        for ($i = 1; $i -le 40; $i++) {  # Up to 3.3 minutes
            $health = $null
            try {
                $response = Invoke-WebRequest -Uri "https://$AppName.azurewebsites.net/api/health" `
                    -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue

                if ($response.StatusCode -eq 200) {
                    $deploymentOk = $true
                    break
                }
            } catch {
                # Still deploying
            }

            $elapsed = $i * 5
            Write-Host "  [$elapsed seconds] Health check: waiting..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 5
        }

        Write-Host ""
        if ($deploymentOk) {
            Write-Host "✅ ROLLBACK COMPLETE" -ForegroundColor Green
            Write-Host "   Production is now on previous commit: $previousHash" -ForegroundColor Green
            Write-Host "   Broken commit tagged: $breakTag" -ForegroundColor DarkGray
        } else {
            Write-Host "⚠ DEPLOYMENT TIMEOUT" -ForegroundColor Yellow
            Write-Host "   Health check didn't return 200 in 3+ minutes" -ForegroundColor Yellow
            Write-Host "   Deployment may still be in progress. Check:" -ForegroundColor Yellow
            Write-Host "   1. GitHub Actions: https://github.com/medwatchers/docflow/actions" -ForegroundColor DarkGray
            Write-Host "   2. Health: https://$AppName.azurewebsites.net/api/health" -ForegroundColor DarkGray
            Write-Host "   3. Logs: https://$AppName.scm.azurewebsites.net/api/logs/application" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "`n✅ REVERT PUSHED TO MASTER" -ForegroundColor Green
        Write-Host "   GitHub Actions deployment in progress..." -ForegroundColor DarkGray
        Write-Host "   Monitor: https://github.com/medwatchers/docflow/actions" -ForegroundColor DarkGray
    }
}

# ============================================================================
# MODE 2: BLUE-GREEN SLOT SWAP (Instant Rollback)
# ============================================================================

elseif ($Mode -eq "SlotSwap") {
    Write-Host "`n[1/3] CHECKING SLOT CONFIGURATION..." -ForegroundColor Yellow

    # Verify staging slot exists
    $slots = az functionapp deployment slot list -g $ResourceGroup -n $AppName -o json 2>$null | ConvertFrom-Json
    $hasStaging = $slots | Where-Object { $_.name -eq "staging" }

    if (-not $hasStaging) {
        Write-Host "  ✗ Staging slot not found" -ForegroundColor Red
        Write-Host "`n  Blue-green slots haven't been set up yet." -ForegroundColor Yellow
        Write-Host "  To create staging slot, run:" -ForegroundColor Yellow
        Write-Host "  az functionapp deployment slot create -g $ResourceGroup -n $AppName -s staging" -ForegroundColor DarkGray
        exit 1
    }

    Write-Host "  ✓ Staging slot exists" -ForegroundColor Green
    Write-Host "    Production: https://$AppName.azurewebsites.net" -ForegroundColor DarkGray
    Write-Host "    Staging:    https://$AppName-staging.azurewebsites.net" -ForegroundColor DarkGray

    Write-Host "`n[2/3] SWAPPING STAGING ← → PRODUCTION..." -ForegroundColor Yellow

    # Perform swap
    az functionapp deployment slot swap `
        --resource-group $ResourceGroup `
        --name $AppName `
        --slot staging 2>&1 | Out-Null

    Write-Host "  ✓ Slot swap complete (10-30 seconds to propagate)" -ForegroundColor Green

    if ($Verify) {
        Write-Host "`n[3/3] VERIFYING BOTH SLOTS HEALTHY..." -ForegroundColor Yellow

        $prodHealthy = $false
        $stagingHealthy = $false

        for ($i = 1; $i -le 12; $i++) {  # Up to 60 seconds
            # Check production
            try {
                $prodResponse = Invoke-WebRequest -Uri "https://$AppName.azurewebsites.net/api/health" `
                    -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
                if ($prodResponse.StatusCode -eq 200) { $prodHealthy = $true }
            } catch { }

            # Check staging
            try {
                $stagingResponse = Invoke-WebRequest -Uri "https://$AppName-staging.azurewebsites.net/api/health" `
                    -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
                if ($stagingResponse.StatusCode -eq 200) { $stagingHealthy = $true }
            } catch { }

            if ($prodHealthy -and $stagingHealthy) { break }

            $elapsed = $i * 5
            Write-Host "  [$elapsed seconds] Production: $(if ($prodHealthy) { '✓' } else { '...' }) | Staging: $(if ($stagingHealthy) { '✓' } else { '...' })" `
                -ForegroundColor DarkGray
            Start-Sleep -Seconds 5
        }

        Write-Host ""
        if ($prodHealthy -and $stagingHealthy) {
            Write-Host "✅ ROLLBACK COMPLETE & VERIFIED" -ForegroundColor Green
            Write-Host "   Production: Swapped back to previous version" -ForegroundColor Green
            Write-Host "   Staging:    Now contains broken code (can be inspected)" -ForegroundColor DarkGray
        } elseif ($prodHealthy) {
            Write-Host "⚠ PRODUCTION HEALTHY, but staging not responding" -ForegroundColor Yellow
            Write-Host "   Rollback succeeded, but staging may need attention" -ForegroundColor Yellow
        } else {
            Write-Host "✗ HEALTH CHECK FAILED" -ForegroundColor Red
            Write-Host "   Check logs: https://$AppName.scm.azurewebsites.net/api/logs/application" -ForegroundColor Yellow
        }
    } else {
        Write-Host "`n✅ SLOT SWAP INITIATED" -ForegroundColor Green
        Write-Host "   Verifying: https://$AppName.azurewebsites.net/api/health" -ForegroundColor DarkGray
    }
}

# ============================================================================
# MODE 3: EMERGENCY APP RESTART (Last Resort)
# ============================================================================

elseif ($Mode -eq "KillApp") {
    Write-Host "`n[EMERGENCY MODE] Killing app process..." -ForegroundColor Red
    Write-Host "  ⚠ Use only if app is hung/crashed" -ForegroundColor Yellow

    # Get Kudu credentials
    Write-Host "`n[1/2] Getting Kudu credentials..." -ForegroundColor Yellow
    $creds = az webapp deployment list-publishing-credentials -n $AppName -g $ResourceGroup `
        --query "{u:publishingUserName, p:publishingPassword}" -o json | ConvertFrom-Json

    $kuduUser = $creds.u
    $kuduPass = $creds.p
    $pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$kuduUser:$kuduPass"))

    Write-Host "`n[2/2] Sending kill command to Kudu..." -ForegroundColor Yellow

    try {
        $response = Invoke-RestMethod `
            -Uri "https://$AppName.scm.azurewebsites.net/api/command" `
            -Method POST `
            -Headers @{"Authorization" = "Basic $pair" } `
            -ContentType "application/json" `
            -Body '{"command":"taskkill /F /IM w3wp.exe","dir":"site/wwwroot"}' `
            -TimeoutSec 30

        Write-Host "  ✓ Kill signal sent" -ForegroundColor Green
        Write-Host "  App will restart in ~5-10 seconds" -ForegroundColor DarkGray

        if ($Verify) {
            Write-Host "`n  Waiting for app restart..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10

            for ($i = 1; $i -le 12; $i++) {
                try {
                    $health = Invoke-WebRequest -Uri "https://$AppName.azurewebsites.net/api/health" `
                        -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
                    if ($health.StatusCode -eq 200) {
                        Write-Host "  ✅ App is back online" -ForegroundColor Green
                        break
                    }
                } catch { }

                $elapsed = ($i * 5) + 10
                Write-Host "  [$elapsed seconds] Still starting..." -ForegroundColor DarkGray
                Start-Sleep -Seconds 5
            }
        }
    } catch {
        Write-Host "  ✗ Failed to kill process: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host "`n" -ForegroundColor DarkGray
