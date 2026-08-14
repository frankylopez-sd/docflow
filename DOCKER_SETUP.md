# DocFlow Docker Setup Guide

Complete local development environment for DocFlow using Docker and Docker Compose.

## Prerequisites

- **Docker Desktop** (20.10+) with Docker Compose included
  - Download: https://www.docker.com/products/docker-desktop
  - Windows: Supports WSL2 backend (recommended)
  - macOS: Intel or Apple Silicon native support
  - Linux: Docker Engine + Docker Compose

- **Disk Space**: ~2GB for Docker images and volumes
- **Ports Available**: 7071 (Functions), 10000-10002 (Azurite)

## Quick Start

### Windows

```powershell
# From the docflow directory
.\docker-setup.bat
```

### macOS / Linux

```bash
# From the docflow directory
chmod +x docker-setup.sh
./docker-setup.sh
```

### Manual Setup

```bash
# Copy environment template
cp .env.example .env

# Build Docker image
docker-compose build

# Start services
docker-compose up -d

# View logs
docker-compose logs -f docflow
```

## Architecture

### Services

#### 1. **Azurite** (Azure Storage Emulator)
- **Image**: `mcr.microsoft.com/azure-storage/azurite:latest`
- **Container Name**: `docflow-azurite`
- **Ports**:
  - `10000`: Blob Storage
  - `10001`: Queue Storage
  - `10002`: Table Storage
- **Data**: Persisted in `azurite-data` volume
- **Connection String** (built-in):
  ```
  DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;
  ```

#### 2. **DocFlow Functions**
- **Image**: Custom-built from `Dockerfile`
- **Container Name**: `docflow-functions`
- **Port**: `7071` (Azure Functions Runtime)
- **Dependencies**: Azurite (must be healthy before starting)
- **Code Mounting**: Live source code mounting for development
- **Node Modules**: Separate volume to prevent overwrite on mount

## Common Commands

### Start Services

```bash
# Start in background
docker-compose up -d

# Start with logs in foreground
docker-compose up

# Start specific service
docker-compose up -d azurite
docker-compose up -d docflow
```

### View Logs

```bash
# View all service logs
docker-compose logs

# View DocFlow logs only (follow mode)
docker-compose logs -f docflow

# View last 100 lines of Azurite logs
docker-compose logs azurite --tail=100

# View logs with timestamps
docker-compose logs -t
```

### Execute Commands Inside Container

```bash
# Run tests
docker-compose exec docflow npm test

# Run with coverage
docker-compose exec docflow npm run test:coverage

# Run specific test file
docker-compose exec docflow npm test -- src/tests/health.test.js

# Start Node REPL
docker-compose exec docflow node

# Execute bash command
docker-compose exec docflow sh
```

### Stop and Clean

```bash
# Stop services (keeps volumes)
docker-compose stop

# Stop and remove containers (keeps volumes)
docker-compose down

# Stop and remove everything including volumes
docker-compose down -v

# Remove Docker image
docker-compose down --rmi all
```

### Rebuild Services

```bash
# Rebuild DocFlow image (after npm dependency changes)
docker-compose build docflow

# Rebuild all services
docker-compose build

# Build without cache
docker-compose build --no-cache
```

## Environment Configuration

### .env File

The `.env` file controls service behavior. Copy from `.env.example`:

```bash
cp .env.example .env
```

### Key Variables

#### Azure Storage (Azurite)
```env
# These are pre-configured for local development
STORAGE_ACCOUNT_NAME=devstoreaccount1
STORAGE_ACCOUNT_KEY=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==
BLOB_TEMP_CONTAINER=pdf-temp
BLOB_ARCHIVE_CONTAINER=pdf-archive
```

#### Adobe Services
```env
ADOBE_CLIENT_ID=your-client-id
ADOBE_CLIENT_SECRET=your-client-secret
ADOBE_IMS_URL=https://ims-na1.adobelogin.com
ADOBE_PDF_SERVICES_URL=https://pdf-services.adobe.io
ADOBE_SIGN_API_URL=https://api.na1.adobesign.com
```

#### Monday.com Integration
```env
MONDAY_API_TOKEN=your-token
MONDAY_API_URL=https://api.monday.com/v2
MONDAY_ONBOARDING_BOARD_ID=board-id
MONDAY_TEMPLATE_CATALOG_ID=board-id
MONDAY_ARCHIVE_BOARD_ID=board-id
MONDAY_SIGNING_SECRET=your-secret
```

#### Monday Column Mappings
```env
MONDAY_COL_STATUS=status
MONDAY_COL_AGREEMENT_ID=text_agreement
MONDAY_COL_PDF_URL=link_pdf
MONDAY_COL_SIGNED_PDF_URL=link_signed
# ... (see .env.example for full list)
```

## Accessing Services

### Azure Functions Runtime

- **URL**: http://localhost:7071
- **Health Check**: http://localhost:7071/api/health
- **Functions**:
  - POST http://localhost:7071/api/mondayWebhook
  - POST http://localhost:7071/api/adobeWebhook
  - GET http://localhost:7071/api/health

### Azure Storage Emulator (Azurite)

- **Blob Storage**: http://localhost:10000
- **Queue Storage**: http://localhost:10001
- **Table Storage**: http://localhost:10002
- **Account Name**: `devstoreaccount1`
- **Account Key**: `Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==`

### Using Azure Storage Explorer

1. Download: https://azure.microsoft.com/features/storage-explorer/
2. Click "Connect to Azure Storage"
3. Select "Use a connection string"
4. Paste the Azurite connection string:
   ```
   DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;
   ```

## Testing Workflows

### Run All Tests

```bash
docker-compose exec docflow npm test
```

### Run Specific Test Suite

```bash
docker-compose exec docflow npm test -- src/tests/health.test.js
docker-compose exec docflow npm test -- generatePDF
```

### Run Tests with Coverage

```bash
docker-compose exec docflow npm run test:coverage
```

### Watch Mode (Auto-rerun on changes)

```bash
docker-compose exec docflow npm test -- --watch
```

## Troubleshooting

### Issue: Port Already in Use

**Symptom**: `Error: listen EADDRINUSE :::7071`

**Solution**:
```bash
# Find process using port 7071
# On macOS/Linux
lsof -i :7071

# On Windows (PowerShell)
Get-NetTCPConnection -LocalPort 7071

# Kill the process or use different ports in docker-compose.yml
```

### Issue: Azurite Container Won't Start

**Symptom**: `docflow` container fails to start because Azurite is unhealthy

**Solution**:
```bash
# Check Azurite logs
docker-compose logs azurite

# Restart Azurite
docker-compose restart azurite

# Give it more time to start (update healthcheck in docker-compose.yml)
```

### Issue: Docker Cannot Find Image

**Symptom**: `Error response from daemon: no such image`

**Solution**:
```bash
# Rebuild the image
docker-compose build --no-cache docflow

# Check Docker disk space
docker system df
docker system prune  # Clean up unused resources
```

### Issue: Storage Connection Fails

**Symptom**: `Error: connect ECONNREFUSED 127.0.0.1:10000`

**Solution**:
```bash
# Ensure Azurite is running and healthy
docker-compose ps

# Check Azurite is accessible
curl http://localhost:10000/devstoreaccount1

# Verify services are on same network
docker network ls
docker network inspect docflow-network
```

### Issue: Code Changes Not Reflected

**Symptom**: Changes to source files not appearing in container

**Solution**:
```bash
# Ensure volume is properly mounted
docker-compose exec docflow cat /app/src/functions/health/index.js

# Restart the service
docker-compose restart docflow

# Check volume mounting in docker-compose.yml
docker inspect docflow-functions | grep -A 10 Mounts
```

### Issue: Out of Disk Space

**Symptom**: `no space left on device`

**Solution**:
```bash
# Check Docker disk usage
docker system df

# Clean up unused resources
docker system prune -a

# Remove Azurite data volume
docker volume rm docflow_azurite-data

# Rebuild from scratch
docker-compose down -v
docker-compose build --no-cache
```

## Performance Optimization

### Reduce Build Time

```bash
# Build without cache (full rebuild)
docker-compose build --no-cache

# Build with BuildKit (faster, modern)
DOCKER_BUILDKIT=1 docker-compose build
```

### Optimize Development

```bash
# Use tmpfs for node_modules (faster, but lost on restart)
# Add to docker-compose.yml:
# tmpfs:
#   - /app/node_modules:noexec,nosuid,size=512m
```

### Monitor Resource Usage

```bash
# Real-time container stats
docker stats

# Detailed container inspection
docker-compose ps
docker inspect docflow-functions
```

## Advanced Usage

### Custom Network Configuration

The services use a dedicated `docflow-network` bridge network for isolation:

```bash
# Connect to network from another container
docker run -it --network docflow-network mcr.microsoft.com/azure-storage/azurite:latest sh
```

### Persistent Data

Azurite data is persisted in the `azurite-data` volume:

```bash
# List volumes
docker volume ls | grep docflow

# Inspect volume location
docker volume inspect docflow_azurite-data

# Backup Azurite data
docker run --rm -v docflow_azurite-data:/data -v $(pwd):/backup \
  ubuntu tar czf /backup/azurite-backup.tar.gz -C /data .

# Restore Azurite data
docker run --rm -v docflow_azurite-data:/data -v $(pwd):/backup \
  ubuntu tar xzf /backup/azurite-backup.tar.gz -C /data
```

### Override Environment at Runtime

```bash
# Override specific variables
docker-compose run -e ADOBE_CLIENT_ID=override-value docflow npm test

# Set multiple overrides
docker-compose exec docflow sh -c "export MY_VAR=value && npm test"
```

## Integration with IDE

### VS Code

1. Install "Docker" extension by Microsoft
2. Install "Remote - Containers" extension
3. Open command palette (`Ctrl+Shift+P`)
4. Select "Remote-Containers: Reopen in Container"

### WebStorm / IntelliJ

1. Go to Settings → Project → Python Interpreter
2. Add "Docker Compose" interpreter
3. Point to docker-compose.yml
4. Select service: `docflow`

## CI/CD Integration

### GitHub Actions Example

```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    options: >-
      --health-cmd "curl -f http://localhost:10000/"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
    ports:
      - 10000:10000
      - 10001:10001
      - 10002:10002

steps:
  - uses: actions/checkout@v3
  - uses: docker/setup-buildx-action@v2
  - uses: docker/build-push-action@v4
    with:
      context: .
      file: ./Dockerfile
      push: false
```

## Security Considerations

- **Local Development Only**: Azurite credentials are hardcoded for convenience
- **Never** use these credentials in production
- **Production**: Use Azure Managed Identity or Key Vault references
- **Secrets**: Store in `.env.local` (add to `.gitignore`)
- **Images**: Keep base images updated (`docker-compose build --no-cache`)

## Additional Resources

- [Azure Functions Core Tools](https://github.com/Azure/azure-functions-core-tools)
- [Azurite Documentation](https://github.com/Azure/Azurite)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)
- [Azure Storage Emulator](https://docs.microsoft.com/azure/storage/common/storage-use-azurite)
