@echo off
REM DOCFLOW LOCAL SERVER STARTUP

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║              STARTING DOCFLOW LOCAL SERVER                     ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM Check if Node is installed
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo ✗ Node.js not found. Install from: https://nodejs.org/
  pause
  exit /b 1
)

echo ✓ Node.js found
echo.

REM Check if dependencies are installed
if not exist "node_modules" (
  echo Installing npm dependencies...
  call npm install
  echo.
)

REM Set environment variables (if not already set)
if not defined MONDAY_API_TOKEN (
  echo ⚠ MONDAY_API_TOKEN not set (optional for testing)
)

if not defined ADOBE_CLIENT_ID (
  echo ⚠ ADOBE_CLIENT_ID not set (optional for testing)
)

echo.
echo Starting server...
echo.

REM Start the server
node server.js

pause
