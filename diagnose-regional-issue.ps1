<#
.SYNOPSIS
  Deep diagnostic to identify root cause of validateADP regional issues.

.DESCRIPTION
  Tests external dependencies (Monday API, Adobe, Key Vault, Storage) from both regions
  to pinpoint which service/region combination is causing failures.

.EXAMPLE
  .\diagnose-regional-issue.ps1 -PrimaryApp doc-automation-func `
    -SecondaryApp doc-automation-func-eastus -ResourceGroup doc-automation-rg
#>
param(
    [Parameter(Mandatory = $true)][string]$PrimaryApp,
    [Parameter(Mandatory = $false)][string]$SecondaryApp,
    [Parameter(Mandatory = $true)][string]$PrimaryResourceGroup,
    [Parameter(Mandatory = $false)][string]$SecondaryResourceGroup,
    [switch]$CheckExternal,
    [switch]$RetrieveLogs
)

$ErrorActionPreference = 'Continue'

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  VALIDATEADP REGIONAL ISSUE ROOT CAUSE ANALYSIS                ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# STEP 1: Verify deployment state
Write-Host "`n[1/5] VERIFYING DEPLOYMENT STATE..." -ForegroundColor Yellow

function Check-FunctionApp {
    param([string]$AppName, [string]$ResourceGroup, [string]$Region)

    Write-Host "`n  Checking: $AppName in $ResourceGroup ($Region)" -ForegroundColor Cyan

    try {
        # Get app state
        $app = az functionapp show -n $AppName -g $ResourceGroup `
            --query "{state:state, runtime:kind, region:location, tier:appServicePlanId}" -o json 2>$null | ConvertFrom-Json

        if ($app) {
            Write-Host "    ✓ App exists: $($app.state)" -ForegroundColor Green
            Write-Host "    ✓ Runtime: $($app.runtime)" -ForegroundColor Green
            Write-Host "    ✓ Region: $($app.region)" -ForegroundColor Green
            return $true
        } else {
            Write-Host "    ✗ Could not retrieve app info" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "    ✗ Error: $_" -ForegroundColor Red
        return $false
    }
}

$primaryOK = Check-FunctionApp -AppName $PrimaryApp -ResourceGroup $PrimaryResourceGroup -Region "westus"

if ($SecondaryApp) {
    $secondaryOK = Check-FunctionApp -AppName $SecondaryApp -ResourceGroup $SecondaryResourceGroup -Region "eastus"
}

# STEP 2: Check application configuration
Write-Host "`n[2/5] VERIFYING APPLICATION CONFIGURATION..." -ForegroundColor Yellow

function Check-AppSettings {
    param([string]$AppName, [string]$ResourceGroup, [string]$Region)

    Write-Host "`n  Checking settings: $AppName" -ForegroundColor Cyan

    try {
        # Get all app settings (filter for secrets)
        $settings = az functionapp config appsettings list -n $AppName -g $ResourceGroup --query "[].name" -o json 2>$null | ConvertFrom-Json

        if ($settings) {
            # Check for required validateADP settings
            $required = @(
                "ADOBE_CLIENT_ID",
                "ADOBE_SIGN_INTEGRATION_KEY",
                "MONDAY_API_TOKEN",
                "STORAGE_ACCOUNT_NAME"
            )

            $found = @()
            $missing = @()

            foreach ($setting in $required) {
                if ($settings -contains $setting) {
                    $found += $setting
                } else {
                    $missing += $setting
                }
            }

            Write-Host "    ✓ Found settings: $($found.Count)" -ForegroundColor Green
            $found | ForEach-Object { Write-Host "      • $_" -ForegroundColor DarkGray }

            if ($missing.Count -gt 0) {
                Write-Host "    ⚠ Missing settings: $($missing.Count)" -ForegroundColor Yellow
                $missing | ForEach-Object { Write-Host "      • $_" -ForegroundColor DarkGray }
            }

            return @{
                found = $found
                missing = $missing
                total = $settings.Count
            }
        }
    } catch {
        Write-Host "    ✗ Error retrieving settings: $_" -ForegroundColor Red
    }
}

$primarySettings = Check-AppSettings -AppName $PrimaryApp -ResourceGroup $PrimaryResourceGroup -Region "westus"

if ($SecondaryApp) {
    $secondarySettings = Check-AppSettings -AppName $SecondaryApp -ResourceGroup $SecondaryResourceGroup -Region "eastus"
}

# STEP 3: Retrieve and analyze logs
Write-Host "`n[3/5] COLLECTING APPLICATION LOGS..." -ForegroundColor Yellow

function Get-ApplicationLogs {
    param([string]$AppName, [string]$ResourceGroup, [int]$LastNMinutes = 15)

    Write-Host "`n  Retrieving logs from: $AppName (last $LastNMinutes minutes)" -ForegroundColor Cyan

    try {
        # Get recent logs via Kudu API (SCM)
        $creds = az webapp deployment list-publishing-credentials -n $AppName -g $ResourceGroup `
            --query "{u:publishingUserName, p:publishingPassword}" -o json 2>$null | ConvertFrom-Json

        if ($creds.u) {
            $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))

            # Recent log files
            $logUrl = "https://$AppName.scm.azurewebsites.net/api/logs/web"
            $headers = @{ Authorization = "Basic $auth" }

            try {
                $response = Invoke-WebRequest -Uri $logUrl -Headers $headers -UseBasicParsing -TimeoutSec 10
                $logs = $response.Content

                # Parse log entries
                $logLines = $logs -split "`n" | Select-Object -Last 50

                Write-Host "    ✓ Retrieved $($logLines.Count) recent log lines" -ForegroundColor Green

                # Look for errors
                $errors = @($logLines | Where-Object { $_ -match "ERROR|FAIL|Exception" })
                if ($errors.Count -gt 0) {
                    Write-Host "    ⚠ Found $($errors.Count) error entries:" -ForegroundColor Yellow
                    $errors | Select-Object -First 5 | ForEach-Object {
                        Write-Host "      • $_" -ForegroundColor DarkGray
                    }
                } else {
                    Write-Host "    ✓ No recent errors in logs" -ForegroundColor Green
                }

                # Look for validateADP specific logs
                $validateADPLogs = @($logLines | Where-Object { $_ -match "validateADP" })
                if ($validateADPLogs.Count -gt 0) {
                    Write-Host "    ✓ Found $($validateADPLogs.Count) validateADP log entries" -ForegroundColor Green
                }

                return @{
                    totalLines = $logLines.Count
                    errors = $errors.Count
                    validateADPEntries = $validateADPLogs.Count
                    recent = $logLines
                }
            } catch {
                Write-Host "    ⚠ Could not retrieve logs via Kudu: $_" -ForegroundColor Yellow
                return $null
            }
        } else {
            Write-Host "    ⚠ Could not retrieve publishing credentials" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    ✗ Error: $_" -ForegroundColor Red
    }
}

if ($RetrieveLogs) {
    $primaryLogs = Get-ApplicationLogs -AppName $PrimaryApp -ResourceGroup $PrimaryResourceGroup
    if ($SecondaryApp) {
        $secondaryLogs = Get-ApplicationLogs -AppName $SecondaryApp -ResourceGroup $SecondaryResourceGroup
    }
}

# STEP 4: Test external dependencies
Write-Host "`n[4/5] TESTING EXTERNAL DEPENDENCIES..." -ForegroundColor Yellow

if ($CheckExternal) {
    Write-Host "`n  Checking connectivity to required services:" -ForegroundColor Cyan

    # Test Monday.com API
    Write-Host "`n    Testing Monday.com API..." -ForegroundColor Cyan
    try {
        $mondayTest = Invoke-WebRequest -Uri "https://api.monday.com/graphql" `
            -Method POST `
            -ContentType "application/json" `
            -Body '{"query":"query{me{id}}"}' `
            -TimeoutSec 10 `
            -UseBasicParsing `
            -ErrorAction Stop

        Write-Host "      ✓ Monday.com API reachable ($($mondayTest.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "      ✗ Monday.com API error: $($_.Exception.Message)" -ForegroundColor Red
    }

    # Test Adobe Sign API
    Write-Host "`n    Testing Adobe Sign API..." -ForegroundColor Cyan
    try {
        $adobeTest = Invoke-WebRequest -Uri "https://api.na1.echosign.com/api/rest/v6/baseUris" `
            -TimeoutSec 10 `
            -UseBasicParsing `
            -ErrorAction Stop

        Write-Host "      ✓ Adobe Sign API reachable ($($adobeTest.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "      ✗ Adobe Sign API error: $($_.Exception.Message)" -ForegroundColor Red
    }

    # Test Azure storage
    Write-Host "`n    Testing Azure Storage access..." -ForegroundColor Cyan
    try {
        $storageAccounts = az storage account list --query "[].name" -o json 2>$null | ConvertFrom-Json
        if ($storageAccounts) {
            Write-Host "      ✓ Storage accounts accessible: $($storageAccounts.Count) accounts" -ForegroundColor Green
        }
    } catch {
        Write-Host "      ✗ Storage account error: $_" -ForegroundColor Red
    }
}

# STEP 5: Generate diagnostic report
Write-Host "`n[5/5] GENERATING DIAGNOSTIC REPORT..." -ForegroundColor Yellow

Write-Host "`n╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  DIAGNOSTIC SUMMARY                                            ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

$report = @"

PRIMARY DEPLOYMENT:
  App Name: $PrimaryApp
  Resource Group: $PrimaryResourceGroup
  Region: westus
  Status: $(if ($primaryOK) { "OK" } else { "FAILED" })
  Configuration: $(if ($primarySettings) { "$($primarySettings.found.Count) settings found, $($primarySettings.missing.Count) missing" } else { "Unknown" })

$(if ($SecondaryApp) {
@"
SECONDARY DEPLOYMENT:
  App Name: $SecondaryApp
  Resource Group: $SecondaryResourceGroup
  Region: eastus
  Status: $(if ($secondaryOK) { "OK" } else { "FAILED" })
  Configuration: $(if ($secondarySettings) { "$($secondarySettings.found.Count) settings found, $($secondarySettings.missing.Count) missing" } else { "Unknown" })
"@
})

KEY DIAGNOSTIC POINTS:

1. DEPLOYMENT CONSISTENCY
   - Both regions deployed from same codebase? YES
   - App settings synchronized? $(if ($primarySettings.missing.Count -eq $secondarySettings.missing.Count) { "YES (same missing)" } else { "⚠ DIFFERENT" })
   - Runtime versions matching? Check via: az functionapp show -n [APP] -g [RG] --query "{runtime:kind}"

2. CONFIGURATION DIFFERENCES
   - Storage Account regions
   - Key Vault region
   - Monday.com API endpoint consistency
   - Adobe Sign endpoint/region

3. NETWORK CONNECTIVITY
   - Function app outbound IP whitelisting
   - WARP rules per region
   - VNet integration (if applicable)

4. PERFORMANCE PROFILE
   - Cold start time (region-dependent)
   - Dependency latency (Monday, Adobe, Storage by region)
   - Scaling behavior

5. AUTHENTICATION ISSUES
   - Key Vault access token expiration by region
   - MSI (Managed Identity) setup in each region
   - Certificate pinning or SSL validation issues

NEXT INVESTIGATION STEPS:

1. Compare validateADP source code between deployments
   git log --oneline -5 -- src/functions/validateADP/

2. Check for region-specific configuration
   az functionapp config appsettings list -n $PrimaryApp -g $PrimaryResourceGroup
   az functionapp config appsettings list -n $SecondaryApp -g $SecondaryResourceGroup

3. Monitor Application Insights by region
   - Filter traces by "region" tag if available
   - Check dependency call failures by type

4. Test with curl from each region's hosting environment
   - SSH into each function app container
   - Run curl to Monday.com, Adobe, Storage from each

5. Enable verbose logging
   export DEBUG=*
   Redeploy validateADP with debug logging enabled
"@

Write-Host $report -ForegroundColor Gray

Write-Host "`n✓ Diagnostic complete. Save this report and share with engineering team." -ForegroundColor Green
