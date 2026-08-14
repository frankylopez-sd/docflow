<#
.SYNOPSIS
  Test validateADP across regions with detailed diagnostics to identify regional issues.

.DESCRIPTION
  Runs comprehensive tests against validateADP endpoints in multiple regions,
  comparing response times, error patterns, and external dependency behavior.

.EXAMPLE
  .\test-validateadp-regional.ps1 -Primary https://doc-automation-func.azurewebsites.net `
    -Secondary https://doc-automation-func-eastus.azurewebsites.net
#>
param(
    [Parameter(Mandatory = $true)][string]$Primary,
    [Parameter(Mandatory = $false)][string]$Secondary,
    [Parameter(Mandatory = $false)][int]$Iterations = 5,
    [switch]$Verbose
)

$ErrorActionPreference = 'Continue'

# Color helpers
$colors = @{
    header = [ConsoleColor]::Cyan
    success = [ConsoleColor]::Green
    error = [ConsoleColor]::Red
    warning = [ConsoleColor]::Yellow
    info = [ConsoleColor]::DarkGray
    metric = [ConsoleColor]::Magenta
}

function Write-Status {
    param([string]$Message, [string]$Color = "info")
    Write-Host $Message -ForegroundColor $colors[$Color]
}

function Test-Endpoint {
    param(
        [string]$Url,
        [string]$TestPayload,
        [string]$RegionName,
        [int]$IterationCount = 1
    )

    $endpoint = "$Url/api/validateADP"
    $results = @()

    Write-Status "`n[TESTING REGION: $RegionName]" -Color metric
    Write-Status "Endpoint: $endpoint" -Color info

    for ($i = 1; $i -le $IterationCount; $i++) {
        Write-Status "`n  Iteration $i/$IterationCount..." -Color info

        $attempt = @{
            iteration = $i
            region = $RegionName
            timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
            success = $false
            statusCode = $null
            responseTime = 0
            responseSize = 0
            error = $null
            dnsTime = 0
            connectionTime = 0
            serverProcessing = 0
            transferTime = 0
            details = @{}
        }

        try {
            $sw = Measure-Command {
                $response = Invoke-WebRequest -Uri $endpoint `
                    -Method POST `
                    -ContentType "application/json" `
                    -Body $TestPayload `
                    -UseBasicParsing `
                    -TimeoutSec 30 `
                    -ErrorAction Stop
            }

            $attempt.success = $true
            $attempt.statusCode = $response.StatusCode
            $attempt.responseTime = [Math]::Round($sw.TotalMilliseconds, 2)
            $attempt.responseSize = $response.Content.Length

            # Parse response
            try {
                $content = $response.Content | ConvertFrom-Json
                $attempt.details = @{
                    status = $content.status
                    validationResult = $content.validationResult
                    errors = $content.errors
                    timestamp = $content.timestamp
                }
            } catch {
                $attempt.details.parseError = "Could not parse JSON response"
            }

            Write-Status "    ✓ SUCCESS ($($attempt.statusCode)) - $($attempt.responseTime)ms" -Color success

        } catch {
            $attempt.error = $_.Exception.Message
            $attempt.statusCode = $_.Exception.Response.StatusCode.Value__ 2>$null

            if ($_.Exception.Message -contains "timeout") {
                Write-Status "    ✗ TIMEOUT after 30s" -Color error
            } elseif ($_.Exception.Message -contains "DNS") {
                Write-Status "    ✗ DNS RESOLUTION ERROR: $($_.Exception.Message)" -Color error
            } elseif ($_.Exception.Message -contains "Connection") {
                Write-Status "    ✗ CONNECTION ERROR: $($_.Exception.Message)" -Color error
            } else {
                Write-Status "    ✗ ERROR ($($attempt.statusCode)): $($_.Exception.Message)" -Color error
            }

            if ($Verbose) {
                Write-Status "       Full: $($_.Exception | Format-List | Out-String)" -Color info
            }
        }

        $results += $attempt
        Start-Sleep -Milliseconds 500  # Rate limiting
    }

    return $results
}

# Test payload
$testPayload = @{
    email = "test@example.com"
    firstName = "Test"
    lastName = "User"
    department = "IT"
    startDate = "2026-01-01"
} | ConvertTo-Json

Write-Status "╔════════════════════════════════════════════════════════════════╗" -Color header
Write-Status "║  VALIDATEADP REGIONAL DIAGNOSTIC TEST                          ║" -Color header
Write-Status "╚════════════════════════════════════════════════════════════════╝" -Color header

Write-Status "`nTest Configuration:" -Color metric
Write-Status "  Iterations per region: $Iterations" -Color info
Write-Status "  Payload size: $($testPayload.Length) bytes" -Color info
Write-Status "  Timeout: 30 seconds" -Color info

# Run primary tests
$primaryResults = Test-Endpoint -Url $Primary -TestPayload $testPayload -RegionName "PRIMARY" -IterationCount $Iterations

# Run secondary tests if provided
$secondaryResults = $null
if ($Secondary) {
    $secondaryResults = Test-Endpoint -Url $Secondary -TestPayload $testPayload -RegionName "SECONDARY" -IterationCount $Iterations
}

# ANALYSIS
Write-Status "`n╔════════════════════════════════════════════════════════════════╗" -Color header
Write-Status "║  TEST RESULTS & ANALYSIS                                       ║" -Color header
Write-Status "╚════════════════════════════════════════════════════════════════╝" -Color header

function Analyze-Results {
    param($Results, $RegionLabel)

    Write-Status "`n[$RegionLabel REGION ANALYSIS]" -Color metric

    $successful = @($Results | Where-Object { $_.success })
    $failed = @($Results | Where-Object { -not $_.success })

    Write-Status "Success Rate: $($successful.Count)/$($Results.Count) ($([Math]::Round($successful.Count/$Results.Count*100, 1))%)" -Color $(if ($successful.Count -eq $Results.Count) { "success" } else { "warning" })

    if ($successful.Count -gt 0) {
        $avgTime = [Math]::Round(($successful.responseTime | Measure-Object -Average).Average, 2)
        $minTime = [Math]::Round(($successful.responseTime | Measure-Object -Minimum).Minimum, 2)
        $maxTime = [Math]::Round(($successful.responseTime | Measure-Object -Maximum).Maximum, 2)

        Write-Status "`n Response Time Statistics:" -Color info
        Write-Status "  Average: $avgTime ms" -Color metric
        Write-Status "  Min: $minTime ms" -Color metric
        Write-Status "  Max: $maxTime ms" -Color metric
        Write-Status "  Variance: $([Math]::Round($maxTime - $minTime, 2)) ms" -Color $(if (($maxTime - $minTime) -gt 1000) { "warning" } else { "info" })

        $avgSize = [Math]::Round(($successful.responseSize | Measure-Object -Average).Average, 2)
        Write-Status "`n Response Size:" -Color info
        Write-Status "  Average: $avgSize bytes" -Color metric
    }

    if ($failed.Count -gt 0) {
        Write-Status "`n Failed Requests:" -Color error
        $failed | ForEach-Object {
            Write-Status "  • Iteration $($_.iteration): $($_.error)" -Color error
        }

        # Categorize errors
        $dnsErrors = @($failed | Where-Object { $_.error -contains "DNS" }).Count
        $timeoutErrors = @($failed | Where-Object { $_.error -contains "timeout" }).Count
        $connectionErrors = @($failed | Where-Object { $_.error -contains "Connection" }).Count

        if ($dnsErrors -gt 0) {
            Write-Status "`n  ⚠ DNS ISSUES DETECTED ($dnsErrors failures)" -Color warning
        }
        if ($timeoutErrors -gt 0) {
            Write-Status "`n  ⚠ TIMEOUT ISSUES DETECTED ($timeoutErrors failures)" -Color warning
        }
        if ($connectionErrors -gt 0) {
            Write-Status "`n  ⚠ CONNECTION ISSUES DETECTED ($connectionErrors failures)" -Color warning
        }
    }
}

Analyze-Results -Results $primaryResults -RegionLabel "PRIMARY"

if ($secondaryResults) {
    Analyze-Results -Results $secondaryResults -RegionLabel "SECONDARY"

    # Comparative Analysis
    Write-Status "`n╔════════════════════════════════════════════════════════════════╗" -Color header
    Write-Status "║  REGIONAL COMPARISON                                           ║" -Color header
    Write-Status "╚════════════════════════════════════════════════════════════════╝" -Color header

    $primarySuccess = @($primaryResults | Where-Object { $_.success }).Count
    $secondarySuccess = @($secondaryResults | Where-Object { $_.success }).Count

    Write-Status "`nReliability Comparison:" -Color metric
    Write-Status "  Primary Success Rate: $([Math]::Round($primarySuccess/$primaryResults.Count*100, 1))%" -Color info
    Write-Status "  Secondary Success Rate: $([Math]::Round($secondarySuccess/$secondaryResults.Count*100, 1))%" -Color info

    if ($primarySuccess -eq $primaryResults.Count -and $secondarySuccess -eq $secondaryResults.Count) {
        Write-Status "  ✓ Both regions equally reliable" -Color success
    } elseif ($primarySuccess -gt $secondarySuccess) {
        $diff = $primarySuccess - $secondarySuccess
        Write-Status "  ⚠ PRIMARY is more reliable (higher success rate by $diff failure(s))" -Color warning
    } elseif ($secondarySuccess -gt $primarySuccess) {
        $diff = $secondarySuccess - $primarySuccess
        Write-Status "  ⚠ SECONDARY is more reliable (higher success rate by $diff failure(s))" -Color warning
    }

    $primarySuccessful = @($primaryResults | Where-Object { $_.success })
    $secondarySuccessful = @($secondaryResults | Where-Object { $_.success })

    if ($primarySuccessful.Count -gt 0 -and $secondarySuccessful.Count -gt 0) {
        $primaryAvg = [Math]::Round(($primarySuccessful.responseTime | Measure-Object -Average).Average, 2)
        $secondaryAvg = [Math]::Round(($secondarySuccessful.responseTime | Measure-Object -Average).Average, 2)

        Write-Status "`nPerformance Comparison:" -Color metric
        Write-Status "  Primary Avg Response: $primaryAvg ms" -Color info
        Write-Status "  Secondary Avg Response: $secondaryAvg ms" -Color info

        $diff = [Math]::Abs($primaryAvg - $secondaryAvg)
        $faster = if ($primaryAvg -lt $secondaryAvg) { "PRIMARY" } else { "SECONDARY" }

        if ($diff -lt 50) {
            Write-Status "  ✓ Performance is comparable (difference: $([Math]::Round($diff, 2))ms)" -Color success
        } else {
            Write-Status "  ⚠ Performance difference: $faster is $([Math]::Round($diff, 2))ms faster" -Color warning
        }
    }

    # Determine root cause
    Write-Status "`n╔════════════════════════════════════════════════════════════════╗" -Color header
    Write-Status "║  DIAGNOSIS & RECOMMENDATIONS                                  ║" -Color header
    Write-Status "╚════════════════════════════════════════════════════════════════╝" -Color header

    if ($primarySuccess -eq $primaryResults.Count -and $secondarySuccess -eq $secondaryResults.Count) {
        Write-Status "`n✓ CONCLUSION: NO REGIONAL ISSUE DETECTED" -Color success
        Write-Status "`nValidateADP functions correctly in both regions. The issue may be:" -Color info
        Write-Status "  • Environmental (development vs production data)" -Color info
        Write-Status "  • Related to specific user/request patterns" -Color info
        Write-Status "  • Dependent on external service availability" -Color info
    } else {
        Write-Status "`n✗ CONCLUSION: REGIONAL ISSUE DETECTED" -Color error
        Write-Status "`nOne region is consistently failing. Investigate:" -Color info

        if ($primarySuccess -lt $secondarySuccess) {
            Write-Status "`n  PRIMARY REGION ($Primary) is failing more frequently:" -Color error
            Write-Status "    1. Check Primary App Service logs" -Color info
            Write-Status "    2. Verify Key Vault/Secret access in primary region" -Color info
            Write-Status "    3. Test network connectivity from primary function app" -Color info
            Write-Status "    4. Review WARP firewall rules for primary region" -Color info
        } else {
            Write-Status "`n  SECONDARY REGION ($Secondary) is failing more frequently:" -Color error
            Write-Status "    1. Check Secondary App Service logs" -Color info
            Write-Status "    2. Verify Key Vault/Secret access in secondary region" -Color info
            Write-Status "    3. Test network connectivity from secondary function app" -Color info
            Write-Status "    4. Review WARP firewall rules for secondary region" -Color info
        }
    }
}

Write-Status "`n✓ Test complete." -Color success
