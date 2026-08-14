#!/bin/bash
#
# DocFlow Health Check Script (POSIX/Bash)
# Verifies all Azure Functions, endpoints, dependencies, and storage connectivity
#
# Usage:
#   ./health-check.sh
#   ./health-check.sh --include-details
#   ./health-check.sh --app-name doc-automation-func --resource-group doc-automation-rg
#

set -euo pipefail

# ============================================================================
# Configuration & Defaults
# ============================================================================

FUNCTION_APP_NAME="${FUNCTION_APP_NAME:-doc-automation-func}"
RESOURCE_GROUP="${RESOURCE_GROUP:-doc-automation-rg}"
BASE_URL="https://${FUNCTION_APP_NAME}.azurewebsites.net/api"
TIMEOUT=30
INCLUDE_DETAILS=false

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# ============================================================================
# Argument Parsing
# ============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        --include-details)
            INCLUDE_DETAILS=true
            shift
            ;;
        --app-name)
            FUNCTION_APP_NAME="$2"
            BASE_URL="https://${FUNCTION_APP_NAME}.azurewebsites.net/api"
            shift 2
            ;;
        --resource-group)
            RESOURCE_GROUP="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ============================================================================
# Helper Functions
# ============================================================================

write_status() {
    local message="$1"
    local status="${2:-INFO}"
    local details="${3:-}"

    case "$status" in
        SUCCESS)
            echo -e "${GREEN}[PASS]${NC} $message"
            ((PASS_COUNT++))
            ;;
        FAILURE)
            echo -e "${RED}[FAIL]${NC} $message"
            ((FAIL_COUNT++))
            ;;
        WARNING)
            echo -e "${YELLOW}[WARN]${NC} $message"
            ((WARN_COUNT++))
            ;;
        *)
            echo -e "${BLUE}[INFO]${NC} $message"
            ;;
    esac

    if [[ -n "$details" && "$INCLUDE_DETAILS" == "true" ]]; then
        echo -e "    ${CYAN}Details: $details${NC}"
    fi
}

invoke_health_endpoint() {
    local endpoint="$1"
    local method="${2:-GET}"
    local body="${3:-}"
    local auth_level="${4:-anonymous}"

    local url="${BASE_URL}/${endpoint}"
    local http_code
    local response
    local headers="-H 'Content-Type: application/json'"

    # Add function key for function-level auth
    if [[ "$auth_level" == "function" ]]; then
        local func_key
        func_key=$(az functionapp keys list --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" --query "functionKeys.default" -o tsv 2>/dev/null || echo "")
        if [[ -n "$func_key" ]]; then
            headers="$headers -H 'x-functions-key: $func_key'"
        fi
    fi

    if [[ -n "$body" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            -H 'Content-Type: application/json' \
            -d "$body" \
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" \
            -k 2>/dev/null || echo "000")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" \
            -k 2>/dev/null || echo "000")
    fi

    http_code=$(echo "$response" | tail -n1)
    echo "$http_code"
}

test_storage_queue() {
    local queue_name="$1"

    if az storage queue exists --name "$queue_name" --auth-mode login &>/dev/null; then
        return 0
    else
        return 1
    fi
}

test_keyvault_access() {
    local kv_name="${1:-docflow-kv}"

    if az keyvault secret show --vault-name "$kv_name" --name "adobe-api-key" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

get_function_status() {
    az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP" \
        --query "state" -o tsv 2>/dev/null || echo "Unknown"
}

# ============================================================================
# Main Health Check
# ============================================================================

clear

echo -e "${CYAN}===========================================${NC}"
echo -e "${CYAN}DocFlow Health Check${NC}"
echo -e "${CYAN}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${CYAN}===========================================${NC}"
echo ""

# 1. Azure Function App Status
echo -e "${CYAN}1. Azure Function App Status${NC}"

app_status=$(get_function_status)
if [[ "$app_status" == "Running" ]]; then
    write_status "Function App is running" "SUCCESS"
else
    write_status "Function App status: $app_status" "FAILURE"
fi

echo ""

# 2. HTTP Endpoints Tests
echo -e "${CYAN}2. HTTP Endpoints (Public & Anonymous)${NC}"

# 2.1 Health Endpoint
http_code=$(invoke_health_endpoint "health" "GET")
if [[ "$http_code" == "200" ]]; then
    write_status "GET /api/health" "SUCCESS" "HTTP $http_code"
else
    write_status "GET /api/health" "FAILURE" "HTTP $http_code"
fi

# 2.2 Validate ADP Endpoint
test_adp_payload='{"employeeId":"TEST-001","firstName":"Test","lastName":"Employee"}'
http_code=$(invoke_health_endpoint "validateADP" "POST" "$test_adp_payload")
if [[ "$http_code" == "200" || "$http_code" == "400" ]]; then
    write_status "POST /api/validateADP" "SUCCESS" "HTTP $http_code"
else
    write_status "POST /api/validateADP" "FAILURE" "HTTP $http_code"
fi

# 2.3 Monday Webhook Endpoint
test_monday='{"challenge":"test_challenge_123"}'
http_code=$(invoke_health_endpoint "mondayWebhook" "POST" "$test_monday")
if [[ "$http_code" == "200" || "$http_code" == "400" ]]; then
    write_status "POST /api/mondayWebhook" "SUCCESS" "HTTP $http_code"
else
    write_status "POST /api/mondayWebhook" "FAILURE" "HTTP $http_code"
fi

# 2.4 Adobe Webhook Endpoint
http_code=$(invoke_health_endpoint "adobeWebhook" "GET")
if [[ "$http_code" == "200" || "$http_code" == "400" ]]; then
    write_status "GET|POST /api/adobeWebhook" "SUCCESS" "HTTP $http_code"
else
    write_status "GET|POST /api/adobeWebhook" "FAILURE" "HTTP $http_code"
fi

echo ""

# 3. Protected HTTP Endpoints
echo -e "${CYAN}3. HTTP Endpoints (Protected - Function Auth)${NC}"

# 3.1 Download Signed Document
http_code=$(invoke_health_endpoint "downloadSigned/test-id" "GET" "" "function")
if [[ "$http_code" == "200" || "$http_code" == "404" ]]; then
    write_status "GET /api/downloadSigned/{id}" "SUCCESS" "HTTP $http_code"
else
    write_status "GET /api/downloadSigned/{id}" "FAILURE" "HTTP $http_code"
fi

# 3.2 Update Monday
test_update='{"itemId":0,"updates":{}}'
http_code=$(invoke_health_endpoint "updateMonday" "POST" "$test_update" "function")
if [[ "$http_code" == "200" || "$http_code" == "400" ]]; then
    write_status "POST /api/updateMonday" "SUCCESS" "HTTP $http_code"
else
    write_status "POST /api/updateMonday" "FAILURE" "HTTP $http_code"
fi

# 3.3 Create ADP User
test_adp_user='{"employeeId":"TEST-001"}'
http_code=$(invoke_health_endpoint "createADPUser" "POST" "$test_adp_user" "function")
if [[ "$http_code" == "200" || "$http_code" == "400" ]]; then
    write_status "POST /api/createADPUser" "SUCCESS" "HTTP $http_code"
else
    write_status "POST /api/createADPUser" "FAILURE" "HTTP $http_code"
fi

echo ""

# 4. Azure Storage Queues
echo -e "${CYAN}4. Azure Storage Queues${NC}"

for queue in "docflow-generate" "docflow-sign" "docflow-archive"; do
    if test_storage_queue "$queue"; then
        write_status "Queue: $queue" "SUCCESS"
    else
        write_status "Queue: $queue" "WARNING" "Queue not found or not accessible"
    fi
done

echo ""

# 5. Key Vault
echo -e "${CYAN}5. Azure Key Vault Access${NC}"

if test_keyvault_access; then
    write_status "Key Vault is accessible" "SUCCESS"
else
    write_status "Key Vault access failed" "WARNING" "Cannot access secrets"
fi

echo ""

# 6. Queue-Triggered Functions
echo -e "${CYAN}6. Queue-Triggered Functions${NC}"
write_status "generatePDF" "INFO" "Triggered by docflow-generate queue"
write_status "sendForSign" "INFO" "Triggered by docflow-sign queue"
write_status "archiveToBlob" "INFO" "Triggered by docflow-archive queue"

echo ""

# 7. Timer-Triggered Functions
echo -e "${CYAN}7. Timer-Triggered Functions${NC}"
write_status "signPoller" "INFO" "Runs every 30 minutes"
write_status "cleanup" "INFO" "Runs daily at 11:30 PM"

echo ""

# Summary
echo -e "${CYAN}===========================================${NC}"
echo -e "${CYAN}Summary${NC}"
echo -e "${CYAN}===========================================${NC}"
echo -e "Passed:  ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed:  ${RED}$FAIL_COUNT${NC}"
echo -e "Warnings: ${YELLOW}$WARN_COUNT${NC}"
echo ""

if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "Overall Status: ${GREEN}HEALTHY${NC}"
    exit 0
elif [[ $FAIL_COUNT -le 2 ]]; then
    echo -e "Overall Status: ${YELLOW}DEGRADED${NC}"
    exit 1
else
    echo -e "Overall Status: ${RED}UNHEALTHY${NC}"
    exit 2
fi
