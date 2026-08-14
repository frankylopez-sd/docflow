# DocFlow Docker Setup Script for PowerShell
# Initializes local development environment with Docker

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "DocFlow Local Docker Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is installed
try {
    $dockerVersion = docker --version 2>$null
    Write-Host "[OK] Docker is installed: $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Docker is not installed" -ForegroundColor Red
    Write-Host "Please install Docker Desktop from https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

# Check if Docker Compose is installed
try {
    $composeVersion = docker-compose --version 2>$null
    Write-Host "[OK] Docker Compose is installed: $composeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Docker Compose is not installed" -ForegroundColor Red
    Write-Host "Please install Docker Compose (included with Docker Desktop)" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Check if .env file exists
$envPath = ".\.env"
if (-not (Test-Path $envPath)) {
    Write-Host "Creating .env file from .env.example..." -ForegroundColor Yellow
    if (Test-Path ".\.env.example") {
        Copy-Item ".\.env.example" ".\.env"
        Write-Host "[OK] .env file created" -ForegroundColor Green
        Write-Host "[WARNING] Update .env with your actual credentials before running services" -ForegroundColor Yellow
    } else {
        Write-Host "[ERROR] .env.example not found" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[OK] .env file already exists" -ForegroundColor Green
}

Write-Host ""

# Create Azurite data directory if it doesn't exist
Write-Host "Creating Azurite data directory..." -ForegroundColor Yellow
$azuriteDir = ".\azurite-data"
if (-not (Test-Path $azuriteDir)) {
    New-Item -ItemType Directory -Force -Path $azuriteDir | Out-Null
}
Write-Host "[OK] Azurite data directory ready" -ForegroundColor Green

Write-Host ""

# Build Docker image
Write-Host "Building Docker image..." -ForegroundColor Yellow
docker-compose build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Docker build failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[OK] Docker setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Quick Start Commands:" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Start services:" -ForegroundColor White
Write-Host "  docker-compose up -d" -ForegroundColor Gray
Write-Host ""
Write-Host "View logs:" -ForegroundColor White
Write-Host "  docker-compose logs -f docflow" -ForegroundColor Gray
Write-Host ""
Write-Host "Run tests:" -ForegroundColor White
Write-Host "  docker-compose exec docflow npm test" -ForegroundColor Gray
Write-Host ""
Write-Host "Stop services:" -ForegroundColor White
Write-Host "  docker-compose down" -ForegroundColor Gray
Write-Host ""
Write-Host "Access Azure Functions:" -ForegroundColor White
Write-Host "  http://localhost:7071" -ForegroundColor Gray
Write-Host ""
Write-Host "Access Azure Storage Emulator (Azurite):" -ForegroundColor White
Write-Host "  Blob:  http://localhost:10000" -ForegroundColor Gray
Write-Host "  Queue: http://localhost:10001" -ForegroundColor Gray
Write-Host "  Table: http://localhost:10002" -ForegroundColor Gray
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
