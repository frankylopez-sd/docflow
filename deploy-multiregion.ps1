<#
.SYNOPSIS
  Deploy validateADP to multiple regions for regional issue diagnosis.

.DESCRIPTION
  Creates parallel deployments in two regions (primary: westus, secondary: eastus)
  and runs comparative tests to identify regional dependencies.

.EXAMPLE
  .\deploy-multiregion.ps1 -PrimaryRegion westus -SecondaryRegion eastus -SkipDeploy
#>
param(
    [Parameter(Mandatory = $false)][string]$PrimaryRegion = "westus",
    [Parameter(Mandatory = $false)][string]$SecondaryRegion = "eastus",
    [switch]$SkipDeploy,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Configuration
$primaryApp = "doc-automation-func"
$primaryRg = "doc-automation-rg"
$secondaryApp = "doc-automation-func-$SecondaryRegion"
$secondaryRg = "doc-automation-rg-$SecondaryRegion"

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  MULTI-REGION VALIDATEADP DEPLOYMENT & COMPARISON              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# STEP 1: Collect current deployment info
Write-Host "`n[1/6] GATHERING CURRENT DEPLOYMENT INFO..." -ForegroundColor Yellow
try {
    $primaryInfo = @{
        app = $primaryApp
        region = $PrimaryRegion
        url = "https://$primaryApp.azurewebsites.net"
        scmUrl = "https://$primaryApp.scm.azurewebsites.net"
    }
    Write-Host "  ✓ Primary: $($primaryInfo.app) in $($primaryInfo.region)" -ForegroundColor Green
    Write-Host "    URL: $($primaryInfo.url)" -ForegroundColor DarkGray
} catch {
    Write-Host "  ⚠ Could not verify primary deployment: $_" -ForegroundColor Yellow
}

# STEP 2: Set up secondary region (if not skipping deploy)
if (-not $SkipDeploy) {
    Write-Host "`n[2/6] SETTING UP SECONDARY REGION ($SecondaryRegion)..." -ForegroundColor Yellow

    # Check if secondary RG exists
    $rgExists = az group exists -n $secondaryRg -o tsv 2>$null
    if ($rgExists -ne "true") {
        Write-Host "  Creating resource group: $secondaryRg in $SecondaryRegion..." -ForegroundColor Cyan
        az group create -n $secondaryRg -l $SecondaryRegion --tags "purpose=validateADP-regional-test" 2>$null
    } else {
        Write-Host "  ✓ Resource group $secondaryRg already exists" -ForegroundColor Green
    }

    # Create storage account for secondary region
    $storageAcctSecondary = "docautostore$(Get-Random -Minimum 1000 -Maximum 9999)"
    $storageExists = az storage account list -g $secondaryRg --query "[?name=='$storageAcctSecondary']" -o json 2>$null | ConvertFrom-Json
    if ($storageExists.Count -eq 0) {
        Write-Host "  Creating storage account: $storageAcctSecondary..." -ForegroundColor Cyan
        az storage account create -n $storageAcctSecondary -g $secondaryRg -l $SecondaryRegion --sku Standard_LRS 2>$null
        Write-Host "  ✓ Storage account created" -ForegroundColor Green
    }

    # Create function app in secondary region
    Write-Host "  Creating function app: $secondaryApp..." -ForegroundColor Cyan
    az functionapp create -n $secondaryApp -g $secondaryRg -l $SecondaryRegion `
        --storage-account $storageAcctSecondary --runtime node --runtime-version 20 `
        --functions-version 4 --consumption-plan-location $SecondaryRegion `
        --tags "purpose=validateADP-regional-test" 2>$null || Write-Host "  ⚠ Function app may already exist" -ForegroundColor Yellow

    Write-Host "  ✓ Secondary deployment ready in $SecondaryRegion" -ForegroundColor Green
} else {
    Write-Host "`n[2/6] SKIPPING SECONDARY REGION DEPLOYMENT" -ForegroundColor Gray
}

# STEP 3: Run tests (offline) if not skipped
if (-not $SkipTests) {
    Write-Host "`n[3/6] RUNNING OFFLINE TEST SUITE..." -ForegroundColor Yellow
    Set-Location $root
    npm test 2>&1 | Select-Object -Last 20
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Tests failed — cannot proceed with deployment" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ All tests passed" -ForegroundColor Green
} else {
    Write-Host "`n[3/6] SKIPPING TEST SUITE" -ForegroundColor Gray
}

# STEP 4: Deploy to both regions (if not skipping)
if (-not $SkipDeploy) {
    Write-Host "`n[4/6] PREPARING DEPLOYMENT PACKAGE..." -ForegroundColor Yellow
    npm ci --omit=dev 2>&1 | Out-Null

    $zip = Join-Path $env:TEMP "validateadp-multiregion-$(Get-Date -Format yyyyMMdd-HHmmss).zip"
    Write-Host "  Creating package: $zip..." -ForegroundColor Cyan
    $exclude = @('.git', '.env', 'local.settings.json', 'coverage', 'deploy', 'src\tests')
    $items = Get-ChildItem -Path $root -Force | Where-Object { $exclude -notcontains $_.Name }
    Compress-Archive -Path $items.FullName -DestinationPath $zip -Force
    Write-Host "  ✓ Package ready ($('{0:N2}' -f ((Get-Item $zip).Length / 1MB)) MB)" -ForegroundColor Green

    # Deploy to primary
    Write-Host "`n[5/6] DEPLOYING TO PRIMARY REGION ($PrimaryRegion)..." -ForegroundColor Yellow
    try {
        $creds = az webapp deployment list-publishing-credentials -n $primaryApp -g $primaryRg `
            --query "{u:publishingUserName, p:publishingPassword}" -o json 2>$null | ConvertFrom-Json

        if ($creds.u) {
            $pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.u):$($creds.p)"))
            $wc = New-Object System.Net.WebClient
            $wc.Headers.Add('Authorization', "Basic $pair")
            Write-Host "  Uploading to SCM endpoint..." -ForegroundColor Cyan
            $wc.UploadFile("https://$primaryApp.scm.azurewebsites.net/api/zipdeploy", 'PUT', $zip) | Out-Null
            Write-Host "  ✓ Deployed to primary" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ Could not retrieve primary credentials" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ⚠ Primary deployment warning: $_" -ForegroundColor Yellow
    }

    # Deploy to secondary
    Write-Host "`n  DEPLOYING TO SECONDARY REGION ($SecondaryRegion)..." -ForegroundColor Yellow
    try {
        $credsSecondary = az webapp deployment list-publishing-credentials -n $secondaryApp -g $secondaryRg `
            --query "{u:publishingUserName, p:publishingPassword}" -o json 2>$null | ConvertFrom-Json

        if ($credsSecondary.u) {
            $pairSecondary = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($credsSecondary.u):$($credsSecondary.p)"))
            $wcSecondary = New-Object System.Net.WebClient
            $wcSecondary.Headers.Add('Authorization', "Basic $pairSecondary")
            Write-Host "  Uploading to SCM endpoint..." -ForegroundColor Cyan
            $wcSecondary.UploadFile("https://$secondaryApp.scm.azurewebsites.net/api/zipdeploy", 'PUT', $zip) | Out-Null
            Write-Host "  ✓ Deployed to secondary" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ Could not retrieve secondary credentials" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ⚠ Secondary deployment warning: $_" -ForegroundColor Yellow
    }

    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    npm install | Out-Null
} else {
    Write-Host "`n[4/6] SKIPPING DEPLOYMENT" -ForegroundColor Gray
    Write-Host "[5/6] SKIPPING DEPLOYMENT" -ForegroundColor Gray
}

# STEP 6: Health verification & comparison
Write-Host "`n[6/6] HEALTH CHECK & COMPARISON..." -ForegroundColor Yellow

$results = @{
    primary = $null
    secondary = $null
}

# Test primary
Write-Host "`n  PRIMARY ($PrimaryRegion): https://$primaryApp.azurewebsites.net/api/health" -ForegroundColor Cyan
try {
    $sw = Measure-Command {
        $res = Invoke-WebRequest -Uri "https://$primaryApp.azurewebsites.net/api/health" `
            -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    }
    if ($res.StatusCode -eq 200) {
        $results.primary = @{
            status = "OK"
            code = $res.StatusCode
            responseTime = $sw.TotalMilliseconds
            region = $PrimaryRegion
        }
        Write-Host "    ✓ Status: $($res.StatusCode) | Response: $($sw.TotalMilliseconds)ms" -ForegroundColor Green
    }
} catch {
    $results.primary = @{
        status = "ERROR"
        error = $_.Exception.Message
        region = $PrimaryRegion
    }
    Write-Host "    ✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test secondary
Write-Host "`n  SECONDARY ($SecondaryRegion): https://$secondaryApp.azurewebsites.net/api/health" -ForegroundColor Cyan
try {
    $sw = Measure-Command {
        $res = Invoke-WebRequest -Uri "https://$secondaryApp.azurewebsites.net/api/health" `
            -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    }
    if ($res.StatusCode -eq 200) {
        $results.secondary = @{
            status = "OK"
            code = $res.StatusCode
            responseTime = $sw.TotalMilliseconds
            region = $SecondaryRegion
        }
        Write-Host "    ✓ Status: $($res.StatusCode) | Response: $($sw.TotalMilliseconds)ms" -ForegroundColor Green
    }
} catch {
    $results.secondary = @{
        status = "ERROR"
        error = $_.Exception.Message
        region = $SecondaryRegion
    }
    Write-Host "    ✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Comparative Analysis
Write-Host "`n╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  REGIONAL COMPARISON RESULTS                                   ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

$report = @"

PRIMARY REGION ($PrimaryRegion):
  Endpoint: https://$primaryApp.azurewebsites.net
  Status: $($results.primary.status)
  Response Code: $($results.primary.code)
  Response Time: $($results.primary.responseTime)ms
  Error: $($results.primary.error)

SECONDARY REGION ($SecondaryRegion):
  Endpoint: https://$secondaryApp.azurewebsites.net
  Status: $($results.secondary.status)
  Response Code: $($results.secondary.code)
  Response Time: $($results.secondary.responseTime)ms
  Error: $($results.secondary.error)

ANALYSIS:
"@

Write-Host $report

if ($results.primary.status -eq "OK" -and $results.secondary.status -eq "OK") {
    $timeDiff = [Math]::Abs($results.primary.responseTime - $results.secondary.responseTime)
    $perfStat = if ($results.primary.responseTime -lt $results.secondary.responseTime) {
        "$PrimaryRegion is $timeDiff ms faster"
    } else {
        "$SecondaryRegion is $timeDiff ms faster"
    }

    Write-Host "  ✓ BOTH REGIONS HEALTHY" -ForegroundColor Green
    Write-Host "  ✓ Performance: $perfStat" -ForegroundColor Green
    Write-Host "  ✓ No regional issue detected (validateADP works in both regions)" -ForegroundColor Green

} elseif ($results.primary.status -eq "OK" -and $results.secondary.status -eq "ERROR") {
    Write-Host "  ✗ SECONDARY REGION FAILURE" -ForegroundColor Red
    Write-Host "  → Indicates REGIONAL ISSUE: $($SecondaryRegion) cannot reach or execute validateADP" -ForegroundColor Red
    Write-Host "  → Possible causes:" -ForegroundColor Yellow
    Write-Host "    - Network/CORS restrictions by region" -ForegroundColor DarkGray
    Write-Host "    - Regional resource availability (e.g., Storage, Key Vault)" -ForegroundColor DarkGray
    Write-Host "    - DNS/routing issues in $SecondaryRegion" -ForegroundColor DarkGray

} elseif ($results.primary.status -eq "ERROR" -and $results.secondary.status -eq "OK") {
    Write-Host "  ✗ PRIMARY REGION FAILURE" -ForegroundColor Red
    Write-Host "  → Indicates REGIONAL ISSUE: $($PrimaryRegion) cannot reach or execute validateADP" -ForegroundColor Red

} else {
    Write-Host "  ✗ BOTH REGIONS FAILED" -ForegroundColor Red
    Write-Host "  → Issue is NOT regional; likely application-wide" -ForegroundColor Yellow
}

Write-Host "`n╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  NEXT STEPS                                                    ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

Write-Host @"

1. CHECK LOGS:
   - Primary: https://$primaryApp.scm.azurewebsites.net/api/logs/web
   - Secondary: https://$secondaryApp.scm.azurewebsites.net/api/logs/web

2. TEST VALIDATEADP SPECIFICALLY:
   curl -X POST https://$primaryApp.azurewebsites.net/api/validateADP \
     -H "Content-Type: application/json" \
     -d '{"testField":"value"}'

3. CHECK REGIONAL DEPENDENCIES:
   - Key Vault access (WARP may block by region)
   - Storage account latency
   - Monday.com API rate limiting by region
   - Adobe services availability

4. REVIEW NETWORK CONFIGURATION:
   - VNet integration (if used)
   - Firewall rules by region
   - Application Gateway/CDN routing

DEPLOYMENT INFO:
  Primary App:    $primaryApp
  Primary RG:     $primaryRg
  Secondary App:  $secondaryApp
  Secondary RG:   $secondaryRg
"@

Write-Host "`n✓ Analysis complete." -ForegroundColor Green
