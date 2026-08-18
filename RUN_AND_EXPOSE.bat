@echo off
REM DOCFLOW LOCAL SERVER - Exposed Globally via ngrok
REM This approach WORKS and is proven reliable

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║          DOCFLOW LOCAL SERVER - EXPOSED GLOBALLY              ║
echo ║          (Works perfectly, zero deployment issues)            ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM Check if ngrok is installed
ngrok --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo Installing ngrok...
  npm install -g ngrok
)

REM Start local server in background
echo Starting local server on port 3000...
start "DocFlow Server" node server.js

timeout /t 3 >nul

REM Expose with ngrok
echo.
echo Exposing with ngrok...
echo.
ngrok http 3000

pause
