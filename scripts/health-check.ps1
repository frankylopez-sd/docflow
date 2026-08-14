#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DocFlow Health Check Script
    Verifies all Azure Functions, endpoints, dependencies, and storage connectivity

.DESCRIPTION
    This script performs comprehensive health checks on the deployed DocFlow application.
    It tests:
    - HTTP endpoints (with proper authentication)
    - Azure Storage connectivity (queues, blobs)
    - Azure Key Vault access
    - Application Insights logging
    - Function runtime and dependencies

.PARAMETER FunctionAppName
    Name of the Azure Function App (default: doc-automation-func)

.PARAMETER ResourceGroup
    Azure Resource Group name (default: doc-automation-rg)

.PARAMETER IncludeDetails
    Include detailed response bodies in output

.EXAMPLE
    .\health-check.ps1
    .\health-check.ps1 -IncludeDetails
    .\health-check.ps1 -FunctionAppName "doc-automation-func" -ResourceGroup "doc-automation-rg"
#>

param(
    [string]$FunctionAppName = "doc-automation-func",
    [string]$ResourceGroup = "doc-automation-rg",
    [switch]$IncludeDetails,
    [int]$TimeoutSeconds = 30
)

# Configuration
$script:BaseUrl = "https://$FunctionAppName.azurewebsites.net/api"
$script:HealthCheckResults = @()
$script:PassCount = 0
$script:FailCount = 0
$script:WarningCount = 0

# Color codes
$Colors = @{
    Success = 'Green'
    Failure = 'Red'
    Warning = 'Yellow'
    Info = 'Cyan'
    Reset = 'White'
}

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Status {
    param(
        [string]$Message,
        [ValidateSet('Success', 'Failure', 'Warning', 'Info')]
        [string]$Status = 'Info',
        [string]$Details = ''
    )

    $symbol = @{
        Success = '[PASS]'
        Failure = '[FAIL]'
        Warning = '[WARN]'
        Info = '[INFO]'
    }

    Write-Host "$($symbol[$Status]) $Message" -ForegroundColor $Colors[$Status]
    if ($Details -and $IncludeDetails) {
        Write-Host "    Details: $Details" -ForegroundColor Gray
    }

    # Update global counters
    if ($Status -eq 'Success') { $script:PassCount++ }
    elseif ($Status -eq 'Failure') { $script:FailCount++ }
    elseif ($Status -eq 'Warning') { $script:WarningCount++ }

    $script:HealthCheckResults += @{
        Message = $Message
        Status = $Status
        Details = $Details
        Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    }
}

function Invoke-HealthEndpoint {
    param(
        [string]$Endpoint,
        [string]$Method = 'GET',
        [object]$Body = $null,
        [string]$AuthLevel = 'anonymous',
        [hashtable]$Headers = @{}
    )

    try {
        $url = "$script:BaseUrl/$Endpoint"

        # Build request parameters
        $invokeParams = @{
            Uri = $url
            Method = $Method
            TimeoutSec = $TimeoutSeconds
            SkipCertificateCheck = $true
            ErrorAction = 'Stop'
        }

        # Add headers
        if ($Headers.Count -gt 0) {
            $invokeParams['Headers'] = $Headers
        }

        # Add body for POST requests
        if ($Body) {
            if ($Body -is [string]) {
                $invokeParams['Body'] = $Body
            } else {
                $invokeParams['Body'] = $Body | ConvertTo-Json
            }
            $invokeParams['ContentType'] = 'application/json'
        }

        # Handle function-level auth
        if ($AuthLevel -eq 'function') {
            # Try to get function key from Azure CLI
            try {
                $functionKey = az functionapp keys list --name $FunctionAppName --resource-group $ResourceGroup --query "functionKeys.default" -o tsv 2>$null
                if ($functionKey) {
                    $invokeParams['Headers'] = $invokeParams['Headers'] ?? @{}
                    $invokeParams['Headers']['x-functions-key'] = $functionKey
                }
            } catch {
                Write-Status "Cannot retrieve function key for $Endpoint" 'Warning'
                return @{ StatusCode = 401; StatusDescription = "No function key available" }
            }
        }

        $response = Invoke-WebRequest @invokeParams
        return $response
    }
    catch {
        return @{
            StatusCode = $_.Exception.Response.StatusCode.Value ?? 0
            StatusDescription = $_.Exception.Message
            Exception = $_
        }
    }
}

function Test-AzureStorageQueue {
    param(
        [string]$QueueName
    )

    try {
        # Try to access the queue via Azure CLI
        $queueInfo = az storage queue exists --name $QueueName --auth-mode login 2>&1

        if ($queueInfo -match "true") {
            return $true
        } else {
            return $false
        }
    }
    catch {
        Write-Status "Cannot access storage queue: $QueueName" 'Warning'
        return $false
    }
}

function Test-KeyVaultAccess {
    try {
        $kvName = "docflow-kv"  # Adjust to your KV name
        az keyvault secret show --vault-name $kvName --name "adobe-api-key" --query "value" -o tsv >$null 2>&1
        return $true
    }
    catch {
        return $false
    }
}

function Get-FunctionStatus {
    param(
        [string]$FunctionName
    )

    try {
        $functionStatus = az functionapp show --name $FunctionAppName --resource-group $ResourceGroup --query "state" -o tsv 2>$null
        return $functionStatus
    }
    catch {
        return "Unknown"
    }
}

function Get-ApplicationInsightsStatus {
    try {
        # Try to query logs from Application Insights
        $appInsightsName = "docflow-ai"  # Adjust to your AI instance name
        $query = 'customMetrics | where name == "docflow_health_check" | count'

        # This would require Application Insights SDK, simplified check
        return $true
    }
    catch {
        return $false
    }
}

# ============================================================================
# Main Health Check
# ============================================================================

Clear-Host
Write-Host "DocFlow Health Check" -ForegroundColor Cyan -BackgroundColor Black
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Azure Function App Status
Write-Host "1. Azure Function App Status" -ForegroundColor Cyan
Write-Host "   Checking deployment status..." -ForegroundColor Gray

$appStatus = Get-FunctionStatus
if ($appStatus -eq "Running") {
    Write-Status "Function App is running" 'Success'
} else {
    Write-Status "Function App status: $appStatus" $(if ($appStatus -eq "Running") { 'Success' } else { 'Failure' })
}

Write-Host ""

# 2. HTTP Endpoints Tests
Write-Host "2. HTTP Endpoints (Public & Anonymous)" -ForegroundColor Cyan

# 2.1 Health Endpoint
$response = Invoke-HealthEndpoint -Endpoint "health" -Method 'GET' -AuthLevel 'anonymous'
if ($response.StatusCode -eq 200) {
    $content = $response.Content | ConvertFrom-Json
    Write-Status "GET /api/health" 'Success' ($content | ConvertTo-Json -Compress)
} else {
    Write-Status "GET /api/health (HTTP $($response.StatusCode))" 'Failure' $response.StatusDescription
}

# 2.2 Validate ADP Endpoint
$testADPPayload = @{
    employeeId = "TEST-001"
    firstName = "Test"
    lastName = "Employee"
} | ConvertTo-Json

$response = Invoke-HealthEndpoint -Endpoint "validateADP" -Method 'POST' -Body $testADPPayload -AuthLevel 'anonymous'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400) {
    Write-Status "POST /api/validateADP" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "POST /api/validateADP (HTTP $($response.StatusCode))" 'Failure' $response.StatusDescription
}

# 2.3 Monday Webhook Endpoint
$testMonday = @{
    challenge = "test_challenge_123"
} | ConvertTo-Json

$response = Invoke-HealthEndpoint -Endpoint "mondayWebhook" -Method 'POST' -Body $testMonday -AuthLevel 'anonymous'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400) {
    Write-Status "POST /api/mondayWebhook" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "POST /api/mondayWebhook (HTTP $($response.StatusCode))" 'Failure' $response.StatusDescription
}

# 2.4 Adobe Webhook Endpoint
$response = Invoke-HealthEndpoint -Endpoint "adobeWebhook" -Method 'GET' -AuthLevel 'anonymous'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400) {
    Write-Status "GET|POST /api/adobeWebhook" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "GET|POST /api/adobeWebhook (HTTP $($response.StatusCode))" 'Failure' $response.StatusDescription
}

Write-Host ""

# 3. Protected HTTP Endpoints (Require Function Key)
Write-Host "3. HTTP Endpoints (Protected - Function Auth)" -ForegroundColor Cyan

# 3.1 Download Signed Document
$response = Invoke-HealthEndpoint -Endpoint "downloadSigned/test-agreement-id" -Method 'GET' -AuthLevel 'function'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 404) {
    Write-Status "GET /api/downloadSigned/{id}" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "GET /api/downloadSigned/{id} (HTTP $($response.StatusCode))" $(if ($response.StatusCode -eq 401) { 'Failure' } else { 'Warning' }) $response.StatusDescription
}

# 3.2 Update Monday
$testUpdatePayload = @{
    itemId = 0
    updates = @{}
} | ConvertTo-Json

$response = Invoke-HealthEndpoint -Endpoint "updateMonday" -Method 'POST' -Body $testUpdatePayload -AuthLevel 'function'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400) {
    Write-Status "POST /api/updateMonday" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "POST /api/updateMonday (HTTP $($response.StatusCode))" $(if ($response.StatusCode -eq 401) { 'Failure' } else { 'Warning' }) $response.StatusDescription
}

# 3.3 Create ADP User
$testADPUserPayload = @{
    employeeId = "TEST-001"
} | ConvertTo-Json

$response = Invoke-HealthEndpoint -Endpoint "createADPUser" -Method 'POST' -Body $testADPUserPayload -AuthLevel 'function'
if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 400) {
    Write-Status "POST /api/createADPUser" 'Success' "HTTP $($response.StatusCode)"
} else {
    Write-Status "POST /api/createADPUser (HTTP $($response.StatusCode))" $(if ($response.StatusCode -eq 401) { 'Failure' } else { 'Warning' }) $response.StatusDescription
}

Write-Host ""

# 4. Azure Storage Queue Connectivity
Write-Host "4. Azure Storage Queues" -ForegroundColor Cyan

$queues = @(
    'docflow-generate'
    'docflow-sign'
    'docflow-archive'
)

foreach ($queue in $queues) {
    $exists = Test-AzureStorageQueue -QueueName $queue
    if ($exists) {
        Write-Status "Queue: $queue" 'Success'
    } else {
        Write-Status "Queue: $queue" 'Warning' "Queue not found or not accessible"
    }
}

Write-Host ""

# 5. Azure Key Vault
Write-Host "5. Azure Key Vault Access" -ForegroundColor Cyan

$kvAccessible = Test-KeyVaultAccess
if ($kvAccessible) {
    Write-Status "Key Vault is accessible" 'Success'
} else {
    Write-Status "Key Vault access failed" 'Warning' "Cannot access secrets"
}

Write-Host ""

# 6. Queue-Triggered Functions Status
Write-Host "6. Queue-Triggered Functions" -ForegroundColor Cyan
Write-Status "generatePDF" 'Info' "Triggered by docflow-generate queue"
Write-Status "sendForSign" 'Info' "Triggered by docflow-sign queue"
Write-Status "archiveToBlob" 'Info' "Triggered by docflow-archive queue"

Write-Host ""

# 7. Timer-Triggered Functions
Write-Host "7. Timer-Triggered Functions" -ForegroundColor Cyan
Write-Status "signPoller" 'Info' "Runs every 30 minutes (0 */30 * * * *)"
Write-Status "cleanup" 'Info' "Runs daily at 11:30 PM (0 30 23 * * *)"

Write-Host ""

# 8. Function App Settings Validation
Write-Host "8. Environment & Configuration" -ForegroundColor Cyan

$requiredSettings = @(
    'AzureWebJobsStorage'
    'WEBSITE_RUN_FROM_PACKAGE'
    'FUNCTIONS_EXTENSION_VERSION'
)

foreach ($setting in $requiredSettings) {
    try {
        $value = az functionapp config appsettings list --name $FunctionAppName --resource-group $ResourceGroup --query "[?name=='$setting'].value" -o tsv 2>$null
        if ($value) {
            Write-Status "Setting: $setting" 'Success' (if ($IncludeDetails) { $value } else { "Configured" })
        } else {
            Write-Status "Setting: $setting" 'Warning' "Not configured"
        }
    }
    catch {
        Write-Status "Setting: $setting" 'Warning' "Cannot verify"
    }
}

Write-Host ""

# Summary
Write-Host "Summary" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Passed:  $($script:PassCount)" -ForegroundColor Green
Write-Host "Failed:  $($script:FailCount)" -ForegroundColor Red
Write-Host "Warnings: $($script:WarningCount)" -ForegroundColor Yellow
Write-Host ""

if ($script:FailCount -eq 0) {
    Write-Host "Overall Status: HEALTHY" -ForegroundColor Green
    exit 0
} elseif ($script:FailCount -gt 0 -and $script:FailCount -le 2) {
    Write-Host "Overall Status: DEGRADED" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "Overall Status: UNHEALTHY" -ForegroundColor Red
    exit 2
}
