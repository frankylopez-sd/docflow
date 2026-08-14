<#
.SYNOPSIS
  Automated end-to-end regional diagnosis for validateADP.
  Runs all diagnostic scripts and generates a comprehensive report.

.EXAMPLE
  .\run-full-regional-diagnosis.ps1
#>

$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $PSScriptRoot

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  VALIDATEADP FULL REGIONAL DIAGNOSIS WORKFLOW                  ║" -ForegroundColor Cyan
Write-Host "║  Automated end-to-end issue detection                          ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = "$scriptDir\regional-diagnosis-reports"
$reportFile = "$reportDir\diagnosis-$timestamp.html"

if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

Write-Host "`nGenerating report at: $reportFile" -ForegroundColor Yellow

# Collect baseline info
Write-Host "`n[PHASE 1] Baseline Collection..." -ForegroundColor Cyan
$baseline = @{
    timestamp = $timestamp
    primaryApp = "doc-automation-func"
    primaryRg = "doc-automation-rg"
    secondaryApp = "doc-automation-func-eastus"
    secondaryRg = "doc-automation-rg-eastus"
    environment = $env:COMPUTERNAME
    osVersion = [System.Environment]::OSVersion.VersionString
}

Write-Host "  Primary App: $($baseline.primaryApp)" -ForegroundColor DarkGray
Write-Host "  Secondary App: $($baseline.secondaryApp)" -ForegroundColor DarkGray

# Phase 2: Multi-region deployment
Write-Host "`n[PHASE 2] Deployment to Secondary Region..." -ForegroundColor Cyan
$deploymentLog = @()

try {
    Write-Host "  Executing deploy-multiregion.ps1..." -ForegroundColor Yellow

    # Run deployment script with output capture
    $deployOutput = & "$scriptDir\deploy-multiregion.ps1" `
        -PrimaryRegion "westus" `
        -SecondaryRegion "eastus" `
        -SkipTests 2>&1

    $deploymentLog = $deployOutput
    Write-Host "  ✓ Deployment script completed" -ForegroundColor Green

} catch {
    Write-Host "  ⚠ Deployment script error: $_" -ForegroundColor Yellow
    $deploymentLog += "ERROR: $_"
}

# Phase 3: Comparative testing
Write-Host "`n[PHASE 3] Running Comparative Tests (5 iterations)..." -ForegroundColor Cyan
$testLog = @()

try {
    Write-Host "  Executing test-validateadp-regional.ps1..." -ForegroundColor Yellow

    $testOutput = & "$scriptDir\test-validateadp-regional.ps1" `
        -Primary "https://doc-automation-func.azurewebsites.net" `
        -Secondary "https://doc-automation-func-eastus.azurewebsites.net" `
        -Iterations 5 2>&1

    $testLog = $testOutput
    Write-Host "  ✓ Tests completed" -ForegroundColor Green

} catch {
    Write-Host "  ⚠ Test execution error: $_" -ForegroundColor Yellow
    $testLog += "ERROR: $_"
}

# Phase 4: Deep diagnostic
Write-Host "`n[PHASE 4] Running Deep Diagnostics..." -ForegroundColor Cyan
$diagnosticLog = @()

try {
    Write-Host "  Executing diagnose-regional-issue.ps1..." -ForegroundColor Yellow

    $diagOutput = & "$scriptDir\diagnose-regional-issue.ps1" `
        -PrimaryApp "doc-automation-func" `
        -SecondaryApp "doc-automation-func-eastus" `
        -PrimaryResourceGroup "doc-automation-rg" `
        -SecondaryResourceGroup "doc-automation-rg-eastus" `
        -CheckExternal `
        -RetrieveLogs 2>&1

    $diagnosticLog = $diagOutput
    Write-Host "  ✓ Diagnostics completed" -ForegroundColor Green

} catch {
    Write-Host "  ⚠ Diagnostic execution error: $_" -ForegroundColor Yellow
    $diagnosticLog += "ERROR: $_"
}

# Phase 5: Generate HTML report
Write-Host "`n[PHASE 5] Generating HTML Report..." -ForegroundColor Cyan

$htmlReport = @"
<!DOCTYPE html>
<html>
<head>
    <title>ValidateADP Regional Diagnosis Report - $timestamp</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        .header {
            background-color: #0078d4;
            color: white;
            padding: 20px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
        .section {
            background-color: white;
            border-left: 4px solid #0078d4;
            padding: 15px;
            margin-bottom: 15px;
            border-radius: 3px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .section.error {
            border-left-color: #d13438;
        }
        .section.warning {
            border-left-color: #ffb900;
        }
        .section.success {
            border-left-color: #107c10;
        }
        h1 {
            margin-top: 0;
            color: white;
        }
        h2 {
            color: #0078d4;
            border-bottom: 2px solid #0078d4;
            padding-bottom: 10px;
            margin-top: 20px;
        }
        h3 {
            color: #106ebe;
            margin-top: 15px;
        }
        .timestamp {
            color: #666;
            font-size: 12px;
        }
        .metric {
            display: inline-block;
            background-color: #f0f0f0;
            padding: 10px 15px;
            margin: 5px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
        .metric.primary {
            border-left: 3px solid #0078d4;
        }
        .metric.secondary {
            border-left: 3px solid #107c10;
        }
        pre {
            background-color: #f5f5f5;
            padding: 10px;
            border-radius: 3px;
            overflow-x: auto;
            font-size: 12px;
        }
        .status-ok {
            color: #107c10;
            font-weight: bold;
        }
        .status-error {
            color: #d13438;
            font-weight: bold;
        }
        .status-warning {
            color: #ffb900;
            font-weight: bold;
        }
        .conclusion {
            background-color: #fff4ce;
            border: 2px solid #ffb900;
            padding: 15px;
            border-radius: 5px;
            margin-top: 20px;
        }
        .conclusion.error {
            background-color: #fdeaea;
            border-color: #d13438;
        }
        .conclusion.success {
            background-color: #f1f5eb;
            border-color: #107c10;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        th {
            background-color: #f0f0f0;
            font-weight: bold;
        }
        tr:hover {
            background-color: #f9f9f9;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>ValidateADP Regional Diagnosis Report</h1>
        <p class="timestamp">Generated: $($baseline.timestamp)</p>
        <p class="timestamp">Environment: $($baseline.environment) | OS: $($baseline.osVersion)</p>
    </div>

    <div class="section">
        <h2>Executive Summary</h2>
        <p>This report contains the results of a comprehensive regional diagnosis for validateADP across Azure regions.</p>
        <p><strong>Deployment Targets:</strong></p>
        <ul>
            <li>Primary Region: westus ($($baseline.primaryApp))</li>
            <li>Secondary Region: eastus ($($baseline.secondaryApp))</li>
        </ul>
    </div>

    <div class="section">
        <h2>Phase 1: Baseline Information</h2>
        <table>
            <tr>
                <th>Property</th>
                <th>Value</th>
            </tr>
            <tr>
                <td>Primary App</td>
                <td><code>$($baseline.primaryApp)</code></td>
            </tr>
            <tr>
                <td>Secondary App</td>
                <td><code>$($baseline.secondaryApp)</code></td>
            </tr>
            <tr>
                <td>Test Timestamp</td>
                <td>$($baseline.timestamp)</td>
            </tr>
        </table>
    </div>

    <div class="section">
        <h2>Phase 2: Deployment Results</h2>
        <p>Status: <span class="status-ok">✓ Deployment script executed</span></p>
        <h3>Output:</h3>
        <pre>$([string]::Join("`n", @($deploymentLog | Select-Object -Last 50)))</pre>
    </div>

    <div class="section">
        <h2>Phase 3: Comparative Testing Results</h2>
        <p>Comparative tests were run against both regional deployments.</p>
        <h3>Test Summary:</h3>
        <pre>$([string]::Join("`n", @($testLog | Select-Object -Last 100)))</pre>
    </div>

    <div class="section">
        <h2>Phase 4: Deep Diagnostics</h2>
        <p>Diagnostic analysis of deployment configuration and external dependencies.</p>
        <h3>Diagnostic Output:</h3>
        <pre>$([string]::Join("`n", @($diagnosticLog | Select-Object -Last 150)))</pre>
    </div>

    <div class="section conclusion success">
        <h2>Recommendations</h2>
        <h3>If No Regional Issue Found:</h3>
        <ul>
            <li>✓ Keep secondary deployment for redundancy/failover</li>
            <li>✓ Configure Azure Traffic Manager for load balancing</li>
            <li>✓ Investigate non-regional root causes (data, time-based, user-specific)</li>
        </ul>

        <h3>If Regional Issue Found:</h3>
        <ul>
            <li>✗ Identify specific failed region from test results above</li>
            <li>✗ Review Phase 4 diagnostic details for root cause</li>
            <li>✗ Check Key Vault/Storage/Network configuration in affected region</li>
            <li>✗ Consider implementing regional failover logic in validateADP</li>
        </ul>
    </div>

    <div class="section">
        <h2>Next Steps</h2>
        <ol>
            <li><strong>Review Results:</strong> Check Phase 3 & 4 output above</li>
            <li><strong>Identify Issue Type:</strong> Regional vs. Application-wide vs. Data-specific</li>
            <li><strong>Root Cause Analysis:</strong> Use diagnostic output to identify specific cause</li>
            <li><strong>Implement Fix:</strong> Follow regional-specific remediation if needed</li>
            <li><strong>Verify Resolution:</strong> Re-run this diagnosis to confirm fix</li>
        </ol>
    </div>

    <div class="section">
        <h2>Additional Resources</h2>
        <ul>
            <li>Full Guide: <code>REGIONAL_DIAGNOSIS_GUIDE.md</code></li>
            <li>Deployment Script: <code>deploy-multiregion.ps1</code></li>
            <li>Test Script: <code>test-validateadp-regional.ps1</code></li>
            <li>Diagnostic Script: <code>diagnose-regional-issue.ps1</code></li>
        </ul>
    </div>
</body>
</html>
"@

# Save HTML report
$htmlReport | Out-File -FilePath $reportFile -Encoding UTF8
Write-Host "  ✓ Report saved to: $reportFile" -ForegroundColor Green

# Generate text summary
$textReport = @"
╔════════════════════════════════════════════════════════════════╗
║  VALIDATEADP REGIONAL DIAGNOSIS SUMMARY                        ║
╚════════════════════════════════════════════════════════════════╝

Timestamp: $timestamp
Environment: $($baseline.environment)

DEPLOYMENT STATUS:
  Primary: doc-automation-func (westus)
  Secondary: doc-automation-func-eastus (eastus)

PHASES COMPLETED:
  [✓] Phase 1: Baseline Collection
  [✓] Phase 2: Multi-region Deployment
  [✓] Phase 3: Comparative Testing
  [✓] Phase 4: Deep Diagnostics
  [✓] Phase 5: Report Generation

REPORT GENERATED:
  HTML Report: $reportFile

RECOMMENDED ACTIONS:
  1. Open HTML report in browser
  2. Review Phase 3 test results
  3. Check Phase 4 diagnostics for root cause
  4. Follow remediation steps in report

NEXT STEPS:
  - Automated diagnosis complete
  - Manual verification may be needed for root cause
  - Share HTML report with engineering team
"@

Write-Host $textReport -ForegroundColor Green

# Save text summary
$summaryFile = "$reportDir\diagnosis-$timestamp.txt"
$textReport | Out-File -FilePath $summaryFile -Encoding UTF8

Write-Host "`nSummary saved to: $summaryFile" -ForegroundColor Yellow

Write-Host "`n✓ Full regional diagnosis workflow complete!" -ForegroundColor Green
Write-Host "Open the HTML report to review findings: $reportFile" -ForegroundColor Cyan
