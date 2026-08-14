#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DocFlow Quick Status Check
    Lightweight health status in <5 seconds
#>

param(
    [string]$FunctionAppName = "doc-automation-func",
    [string]$ResourceGroup = "doc-automation-rg"
)

$BaseUrl = "https://$FunctionAppName.azurewebsites.net/api"

Write-Host "DocFlow Quick Status Check - $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
Write-Host ""

# Health check only
try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/health" `
        -Method GET `
        -TimeoutSec 10 `
        -SkipCertificateCheck -ErrorAction Stop

    if ($response.StatusCode -eq 200) {
        $health = $response.Content | ConvertFrom-Json
        Write-Host "✓ Status: RUNNING" -ForegroundColor Green
        Write-Host "  Uptime: $($health.uptime ?? 'N/A')"
        Write-Host "  Version: $($health.version ?? 'N/A')"
        Write-Host "  Timestamp: $($health.timestamp ?? (Get-Date).ToString('o'))"
    }
} catch {
    Write-Host "✗ Status: DOWN" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "For detailed health check, run: .\health-check.ps1" -ForegroundColor Gray
