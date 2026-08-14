@echo off
REM DocFlow Docker Setup Script for Windows
REM Initializes local development environment with Docker

setlocal enabledelayedexpansion

echo.
echo ========================================
echo DocFlow Local Docker Setup
echo ========================================
echo.

REM Check if Docker is installed
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed
    echo Please install Docker Desktop from https://www.docker.com/products/docker-desktop
    exit /b 1
)

REM Check if Docker Compose is installed
docker-compose --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker Compose is not installed
    echo Please install Docker Compose ^(included with Docker Desktop^)
    exit /b 1
)

echo [OK] Docker and Docker Compose are installed
echo.

REM Check if .env file exists
if not exist .env (
    echo Creating .env file from .env.example...
    copy .env.example .env
    echo [OK] .env file created
    echo [WARNING] Update .env with your actual credentials before running services
) else (
    echo [OK] .env file already exists
)
echo.

REM Create Azurite data directory if it doesn't exist
echo Creating Azurite data directory...
if not exist azurite-data mkdir azurite-data
echo [OK] Azurite data directory ready
echo.

REM Build Docker image
echo Building Docker image...
docker-compose build
if %errorlevel% neq 0 (
    echo [ERROR] Docker build failed
    exit /b 1
)

echo.
echo [OK] Docker setup complete!
echo.
echo ========================================
echo Quick Start Commands:
echo ========================================
echo.
echo Start services:
echo   docker-compose up -d
echo.
echo View logs:
echo   docker-compose logs -f docflow
echo.
echo Run tests:
echo   docker-compose exec docflow npm test
echo.
echo Stop services:
echo   docker-compose down
echo.
echo Access Azure Functions:
echo   http://localhost:7071
echo.
echo Access Azure Storage Emulator (Azurite):
echo   Blob:  http://localhost:10000
echo   Queue: http://localhost:10001
echo   Table: http://localhost:10002
echo.
echo ========================================
echo.

pause
