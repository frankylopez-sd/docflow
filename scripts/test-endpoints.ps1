#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DocFlow Endpoint Test Script
    Detailed testing of all HTTP endpoints with verbose output and debugging

.DESCRIPTION
    This script provides detailed testing of DocFlow endpoints with:
    - Request/response logging
    - Timing information
    - Auth header verification
    - Payload validation

.PARAMETER FunctionAppName
    Name of the Azure Function App (default: doc-automation-func)

.PARAMETER ResourceGroup
    Azure Resource Group name (default: doc-automation-rg)

.PARAMETER Endpoint
    Specific endpoint to test (optional, tests all if not specified)

.PARAMETER Method
    HTTP method to use (default: auto-detect from config)

.PARAMETER Payload
    JSON payload for POST/PUT requests

.PARAMETER ShowDetails
    Show detailed request/response information

.EXAMPLE
    .\test-endpoints.ps1
    .\test-endpoints.ps1 -ShowDetails
    .\test-endpoints.ps1 -Endpoint "health"
    .\test-endpoints.ps1 -Endpoint "validateADP" -Payload '{"employeeId":"TEST-001"}'
#>

param(
    [string]$FunctionAppName = "doc-automation-func",
    [string]$ResourceGroup = "doc-automation-rg",
    [string]$Endpoint = '',
    [string]$Method = '',
    [string]$Payload = '',
    [switch]$ShowDetails
)

# ============================================================================
# Endpoint Configuration
# ============================================================================

$EndpointConfig = @{
    'health' = @{
        method = 'GET'
        auth = 'anonymous'
        description = 'Application health check'
    }
    'validateADP' = @{
        method = 'POST'
        auth = 'anonymous'
        description = 'Validate ADP data'
        defaultPayload = @{
            employeeId = "TEST-001"
            firstName = "Test"
            lastName = "Employee"
        }
    }
    'mondayWebhook' = @{
        method = 'POST'
        auth = 'anonymous'
        description = 'Monday.com webhook handler'
        defaultPayload = @{
            challenge = "test_challenge_$(Get-Random)"
        }
    }
    'adobeWebhook' = @{
        method = 'GET'
        auth = 'anonymous'
        description = 'Adobe webhook handler'
    }
    'downloadSigned' = @{
        method = 'GET'
        auth = 'function'
        description = 'Download signed document'
        route = 'downloadSigned/{agreementId}'
        defaultParam = 'test-agreement-id'
    }
    'updateMonday' = @{
        method = 'POST'
        auth = 'function'
        description = 'Update Monday.com item'
        defaultPayload = @{
            itemId = 0
            updates = @{}
        }
    }
    'createADPUser' = @{
        method = 'POST'
        auth = 'function'
        description = 'Create ADP user'
        defaultPayload = @{
            employeeId = "TEST-001"
            firstName = "Test"
            lastName = "Employee"
        }
    }
}

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "=" * 70 -ForegroundColor Cyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host "=" * 70 -ForegroundColor Cyan
}

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "▶ $Text" -ForegroundColor Yellow
}

function Write-Detail {
    param(
        [string]$Label,
        [object]$Value
    )
    $valueStr = if ($Value -is [object] -and $Value -isnot [string]) {
        $Value | ConvertTo-Json -Compress
    } else {
        $Value.ToString()
    }
    Write-Host "  $($Label -PadRight 20): $valueStr" -ForegroundColor Gray
}

function Get-FunctionKey {
    try {
        $key = az functionapp keys list `
            --name $FunctionAppName `
            --resource-group $ResourceGroup `
            --query "functionKeys.default" -o tsv 2>$null

        return $key
    }
    catch {
        Write-Host "  ERROR: Cannot retrieve function key" -ForegroundColor Red
        return $null
    }
}

function Test-Endpoint {
    param(
        [string]$EndpointName,
        [string]$Route,
        [string]$Method = 'GET',
        [string]$AuthLevel = 'anonymous',
        [object]$Body = $null,
        [string]$Description = ''
    )

    $baseUrl = "https://$FunctionAppName.azurewebsites.net/api"
    $url = "$baseUrl/$Route"

    Write-Section "$EndpointName - $Description"
    Write-Detail "URL" $url
    Write-Detail "Method" $Method
    Write-Detail "Auth Level" $AuthLevel
    Write-Detail "Route" $Route

    # Prepare headers
    $headers = @{
        'Content-Type' = 'application/json'
    }

    # Add function key for protected endpoints
    if ($AuthLevel -eq 'function') {
        $funcKey = Get-FunctionKey
        if ($funcKey) {
            $headers['x-functions-key'] = $funcKey
            Write-Detail "Function Key" "$(($funcKey -replace '.','.').Substring(0,15))..."
        } else {
            Write-Host "  ⚠ WARNING: No function key available, request may fail" -ForegroundColor Yellow
        }
    }

    # Prepare request
    $invokeParams = @{
        Uri = $url
        Method = $Method
        TimeoutSec = 30
        SkipCertificateCheck = $true
        Headers = $headers
    }

    if ($Body) {
        if ($Body -is [string]) {
            $invokeParams['Body'] = $Body
        } else {
            $invokeParams['Body'] = $Body | ConvertTo-Json
        }
        Write-Detail "Payload" $invokeParams['Body']
    }

    # Execute request
    Write-Section "Sending Request..."

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest @invokeParams -ErrorVariable requestError

        $stopwatch.Stop()
        $duration = $stopwatch.ElapsedMilliseconds

        Write-Section "Response"
        Write-Detail "Status Code" "$($response.StatusCode) $($response.StatusDescription)"
        Write-Detail "Duration" "$($duration)ms"
        Write-Detail "Content Length" "$($response.Content.Length) bytes"
        Write-Detail "Content Type" $response.Headers['Content-Type']

        if ($ShowDetails -and $response.Content) {
            Write-Host ""
            Write-Host "Response Body:" -ForegroundColor Cyan
            try {
                $jsonContent = $response.Content | ConvertFrom-Json
                $jsonContent | ConvertTo-Json -Depth 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
            } catch {
                Write-Host "  [Not valid JSON]" -ForegroundColor Gray
                Write-Host "  $($response.Content)" -ForegroundColor Gray
            }
        }

        Write-Host ""
        Write-Host "✓ PASS" -ForegroundColor Green

        return @{
            Success = $true
            StatusCode = $response.StatusCode
            Duration = $duration
            ContentLength = $response.Content.Length
        }
    }
    catch {
        $stopwatch.Stop()
        $duration = $stopwatch.ElapsedMilliseconds

        Write-Section "Error Response"
        Write-Detail "Status Code" $($_.Exception.Response.StatusCode.Value ?? "No response")
        Write-Detail "Duration" "$($duration)ms"
        Write-Detail "Error" $_.Exception.Message

        if ($ShowDetails -and $_.Exception.Response) {
            Write-Host ""
            Write-Host "Error Details:" -ForegroundColor Cyan
            try {
                $errorStream = $_.Exception.Response.GetResponseStream()
                $errorReader = [System.IO.StreamReader]::new($errorStream)
                $errorBody = $errorReader.ReadToEnd()
                Write-Host "  $errorBody" -ForegroundColor Gray
            } catch {
                Write-Host "  [Cannot read error details]" -ForegroundColor Gray
            }
        }

        Write-Host ""
        Write-Host "✗ FAIL" -ForegroundColor Red

        return @{
            Success = $false
            StatusCode = $_.Exception.Response.StatusCode.Value ?? 0
            Duration = $duration
            Error = $_.Exception.Message
        }
    }
}

# ============================================================================
# Main Execution
# ============================================================================

Clear-Host

Write-Header "DocFlow Endpoint Test Utility"
Write-Detail "Application" $FunctionAppName
Write-Detail "Resource Group" $ResourceGroup
Write-Detail "Base URL" "https://$FunctionAppName.azurewebsites.net/api"
Write-Detail "Timestamp" (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Write-Detail "Verbose" $ShowDetails

# Test specific endpoint or all
if ($Endpoint) {
    # Test specific endpoint
    if ($EndpointConfig.ContainsKey($Endpoint)) {
        $config = $EndpointConfig[$Endpoint]
        $route = $config.route ?? $Endpoint
        $testMethod = $Method -or $config.method
        $testBody = $Payload -or ($config.defaultPayload | ConvertTo-Json)

        if ($config.ContainsKey('defaultParam')) {
            $route = $route -replace '\{.*?\}', $config.defaultParam
        }

        Test-Endpoint `
            -EndpointName $Endpoint `
            -Route $route `
            -Method $testMethod `
            -AuthLevel $config.auth `
            -Body $testBody `
            -Description $config.description
    } else {
        Write-Host "Unknown endpoint: $Endpoint" -ForegroundColor Red
        Write-Host "Available endpoints:"
        $EndpointConfig.Keys | ForEach-Object {
            Write-Host "  - $_"
        }
        exit 1
    }
} else {
    # Test all endpoints
    $results = @()

    foreach ($endpointName in $EndpointConfig.Keys) {
        $config = $EndpointConfig[$endpointName]
        $route = $config.route ?? $endpointName
        $testBody = $config.defaultPayload

        if ($config.ContainsKey('defaultParam')) {
            $route = $route -replace '\{.*?\}', $config.defaultParam
        }

        $result = Test-Endpoint `
            -EndpointName $endpointName `
            -Route $route `
            -Method $config.method `
            -AuthLevel $config.auth `
            -Body $testBody `
            -Description $config.description

        $results += @{
            Endpoint = $endpointName
            Result = $result
        }
    }

    # Summary
    Write-Header "Test Summary"

    $passed = @($results | Where-Object { $_.Result.Success }).Count
    $failed = @($results | Where-Object { -not $_.Result.Success }).Count
    $avgDuration = [Math]::Round(($results | Measure-Object -Property { $_.Result.Duration } -Average).Average)

    Write-Host ""
    Write-Host "Total Tests:    $($results.Count)" -ForegroundColor Cyan
    Write-Host "Passed:         $passed" -ForegroundColor Green
    Write-Host "Failed:         $failed" -ForegroundColor Red
    Write-Host "Avg Duration:   $($avgDuration)ms" -ForegroundColor Cyan
    Write-Host ""

    if ($failed -gt 0) {
        Write-Host "Failed Endpoints:" -ForegroundColor Red
        $results | Where-Object { -not $_.Result.Success } | ForEach-Object {
            Write-Host "  - $($_.Endpoint) (HTTP $($_.Result.StatusCode))"
        }
    }

    Write-Host ""
    if ($failed -eq 0) {
        Write-Host "Overall Status: PASS" -ForegroundColor Green
    } else {
        Write-Host "Overall Status: FAIL" -ForegroundColor Red
    }
}
