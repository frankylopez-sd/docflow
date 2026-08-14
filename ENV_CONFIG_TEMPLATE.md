# DocFlow Poison Queue Configuration Template

## Local Development (.env)

```env
# Existing configuration
ADOBE_CLIENT_ID=xxx
ADOBE_CLIENT_SECRET=xxx
ADOBE_SIGN_API_URL=https://api.na2.adobesign.com
MONDAY_API_TOKEN=xxx
MONDAY_ONBOARDING_BOARD_ID=18422046530
MONDAY_TEMPLATE_CATALOG_ID=xxx
STORAGE_ACCOUNT_NAME=docflowstg
STORAGE_ACCOUNT_KEY=xxx
ENVIRONMENT=local

# NEW: SharePoint Integration
SHAREPOINT_SITE_URL=https://medwatchers.sharepoint.com/sites/hr-documents
SHAREPOINT_CLIENT_ID=<app-id-from-entra>
SHAREPOINT_CLIENT_SECRET=<app-secret-from-entra>
SHAREPOINT_TENANT_ID=<your-tenant-id>

# NEW: Optional - Ops Alerts Board
MONDAY_OPS_ALERTS_BOARD_ID=18422046531

# NEW: Optional - Retry Configuration
DOCFLOW_RETRY_BASE_MS=60000
```

## Azure Function App Settings (Production)

### Via Portal
1. Navigate to **Function App** → **Configuration**
2. Add New Application Settings:

```
SHAREPOINT_SITE_URL = https://medwatchers.sharepoint.com/sites/hr-documents

SHAREPOINT_CLIENT_ID = (Key Vault reference)
  @Microsoft.KeyVault(SecretUri=https://[vault].vault.azure.net/secrets/sharepoint-client-id/)

SHAREPOINT_CLIENT_SECRET = (Key Vault reference)
  @Microsoft.KeyVault(SecretUri=https://[vault].vault.azure.net/secrets/sharepoint-client-secret/)

SHAREPOINT_TENANT_ID = <your-tenant-id>

MONDAY_OPS_ALERTS_BOARD_ID = 18422046531 (optional)

DOCFLOW_RETRY_BASE_MS = 60000 (optional)
```

### Via Azure CLI

```bash
# Set via CLI
az functionapp config appsettings set \
  --resource-group <rg> \
  --name <func-app> \
  --settings \
    SHAREPOINT_SITE_URL="https://medwatchers.sharepoint.com/sites/hr-documents" \
    SHAREPOINT_TENANT_ID="<tenant-id>" \
    MONDAY_OPS_ALERTS_BOARD_ID="18422046531" \
    DOCFLOW_RETRY_BASE_MS="60000"

# Set secrets via Key Vault
az keyvault secret set \
  --vault-name <vault> \
  --name sharepoint-client-id \
  --value <app-id>

az keyvault secret set \
  --vault-name <vault> \
  --name sharepoint-client-secret \
  --value <app-secret>

# Create Key Vault references
az functionapp config appsettings set \
  --resource-group <rg> \
  --name <func-app> \
  --settings \
    SHAREPOINT_CLIENT_ID="@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/sharepoint-client-id/)" \
    SHAREPOINT_CLIENT_SECRET="@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/sharepoint-client-secret/)"
```

## Azure Storage Configuration

### Create Retry Queue

```bash
# Via Azure CLI
az storage queue create \
  --account-name <storage-account> \
  --name docflow-archive-retry \
  --auth-mode login

# Verify
az storage queue exists \
  --account-name <storage-account> \
  --name docflow-archive-retry
```

### Queue Properties

| Property | Value |
|----------|-------|
| Queue Name | `docflow-archive-retry` |
| Message TTL | 7 days (default) |
| Visibility Timeout | 30 seconds (default) |
| Max message size | 64 KB |

## Entra ID (Azure AD) App Registration

### Create App Registration for SharePoint

1. **Azure Portal** → **Entra ID** → **App registrations** → **New registration**

```
Name: DocFlow-SharePoint-Upload
Supported account types: Single tenant
Redirect URI: (leave blank for service principal)
```

2. **API Permissions** → **Add a permission**

```
API: Microsoft Graph
Permission type: Application
Permissions: 
  - Files.ReadWrite.All
  - Sites.ReadWrite.All
  - Calendars.ReadWrite
```

3. **Certificates & secrets** → **Client secrets** → **New client secret**

```
Description: DocFlow SharePoint Upload
Expires: 24 months
Copy the value immediately (won't show again)
```

4. **Overview** → Copy these values:

```
Application (client) ID: <SHAREPOINT_CLIENT_ID>
Directory (tenant) ID: <SHAREPOINT_TENANT_ID>
Client Secret: <SHAREPOINT_CLIENT_SECRET>
```

### Grant SharePoint Permissions

If using SharePoint-specific access (vs Graph API):

```bash
# Install Microsoft.SharePoint.Client SDK
# Then add application permissions via SharePoint admin center

# Alternative: Use Microsoft Graph (preferred)
# Graph permissions already set above
```

## Managed Identity Permissions

### Grant Function App Access to Key Vault

```bash
# Get Function App managed identity
IDENTITY=$(az functionapp identity show \
  --resource-group <rg> \
  --name <func-app> \
  --query principalId -o tsv)

# Grant Key Vault secret read permission
az keyvault set-policy \
  --name <vault> \
  --object-id $IDENTITY \
  --secret-permissions get list
```

### Grant Function App Access to Storage

```bash
# Get Function App managed identity (same as above)
IDENTITY=$(az functionapp identity show \
  --resource-group <rg> \
  --name <func-app> \
  --query principalId -o tsv)

# Assign storage queue reader role
az role assignment create \
  --assignee $IDENTITY \
  --role "Storage Queue Data Contributor" \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<storage-account>"
```

## Monday.com Configuration

### Create Ops Alerts Board

```bash
# Via Monday API
BOARD_ID=$(curl -s -H "Authorization: $MONDAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.monday.com/v2" \
  -d '{
    "query": "mutation { create_board(board_name: \"OPS Alerts\", board_kind: \"public\") { id name } }"
  }' | jq '.data.create_board.id')

echo "Board ID: $BOARD_ID"
```

### Record Board ID

```bash
# Update Function App settings
az functionapp config appsettings set \
  --resource-group <rg> \
  --name <func-app> \
  --settings MONDAY_OPS_ALERTS_BOARD_ID="$BOARD_ID"
```

## Validation Checklist

### Pre-Deployment

- [ ] SharePoint site URL is accessible
- [ ] Entra ID app registration created
- [ ] Client ID and secret obtained
- [ ] Tenant ID recorded
- [ ] Key Vault configured with secrets
- [ ] Function App managed identity has Key Vault permissions
- [ ] `docflow-archive-retry` queue created in storage
- [ ] Monday OPS alerts board created (optional but recommended)

### Post-Deployment

```bash
# Test SharePoint auth
curl -X POST https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token \
  -d "grant_type=client_credentials" \
  -d "client_id=<client-id>" \
  -d "client_secret=<client-secret>" \
  -d "scope=https://graph.microsoft.com/.default" \
  -H "Content-Type: application/x-www-form-urlencoded"
# Should return 200 with access_token

# Test storage queue access
az storage queue metadata show \
  --account-name <storage-account> \
  --name docflow-archive-retry \
  --auth-mode login
# Should return queue properties

# Test function app settings
az functionapp config appsettings list \
  --resource-group <rg> \
  --name <func-app> \
  --query "[?contains(name, 'SHAREPOINT') || contains(name, 'MONDAY_OPS')]"
# Should show all SharePoint + OPS settings
```

## Troubleshooting Configuration

### "Invalid tenant" Error

```bash
# Verify tenant ID
az account list --query "[].tenantId" -o tsv

# Use correct format in OAuth URL
https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token
```

### "Insufficient permissions" Error

```bash
# Verify Key Vault permissions
az keyvault secret list --vault-name <vault>

# Check managed identity permissions
az role assignment list \
  --assignee <managed-identity-id> \
  --query "[].roleDefinitionName"
```

### "Queue does not exist" Error

```bash
# Verify queue was created
az storage queue list \
  --account-name <storage-account> \
  --auth-mode login

# Create if missing
az storage queue create \
  --account-name <storage-account> \
  --name docflow-archive-retry
```

### "Invalid storage account key" Error

```bash
# Regenerate if needed (requires restart)
az storage account keys renew \
  --account-name <storage-account> \
  --key primary

# Update Function App settings (if using key auth)
STORAGE_KEY=$(az storage account keys list \
  --account-name <storage-account> \
  --query "[0].value" -o tsv)

az functionapp config appsettings set \
  --resource-group <rg> \
  --name <func-app> \
  --settings STORAGE_ACCOUNT_KEY="$STORAGE_KEY"
```

## Security Best Practices

1. **Never commit secrets** to git
   - Use Key Vault for all sensitive values
   - .env files should be in .gitignore

2. **Rotate credentials regularly**
   - SharePoint client secret: Every 6-12 months
   - Storage account keys: Every 90 days
   - Use Key Vault versioning

3. **Use managed identities** when possible
   - Eliminates need to store credentials
   - Automatic token refresh
   - No expiration concerns

4. **Audit access logs**
   - Monitor Key Vault access
   - Review Function App logs regularly
   - Alert on authentication failures

5. **Scope permissions narrowly**
   - Graph API: Only Files.ReadWrite.All (not Admin)
   - Storage Queue: Only Data Contributor (not Owner)
   - Key Vault: Only secret read (not create/delete)

## Reference

**Key Vault Naming Convention**:
- `sharepoint-client-id`
- `sharepoint-client-secret`
- `docflow-storage-key`

**Function App Settings Naming**:
- All uppercase with underscores
- Prefix with component: `SHAREPOINT_`, `MONDAY_`, `DOCFLOW_`
- Example: `SHAREPOINT_CLIENT_ID`, `MONDAY_OPS_ALERTS_BOARD_ID`

**Queue Naming Convention**:
- Format: `docflow-{stage}-{purpose}`
- Examples: `docflow-archive`, `docflow-archive-retry`, `docflow-sign`
