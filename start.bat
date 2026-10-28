@echo off
cd /d "%~dp0"
rem Optional settings (PORT, HOST) can be set in settings.bat. The port and the game API key live in config.json.
if exist settings.bat call settings.bat

if exist runtime\node.exe (
  set "NODE=runtime\node.exe"
) else (
  where node >nul 2>nul || (echo Node.js not found. Run setup.bat first. & pause & exit /b 1)
  set "NODE=node"
)

"%NODE%" -e "require('node:sqlite')" >nul 2>nul || (echo This Node.js is too old ^(needs 22.13+, 23.4+ or 24+^). Run setup.bat. & pause & exit /b 1)

rem The server does not start until an admin password exists (asked once, stored hashed in the DB).
"%NODE%" --disable-warning=ExperimentalWarning src\set-password.js --if-missing
if errorlevel 1 (
  echo Admin password was not set. The server was not started.
  pause
  exit /b 1
)

"%NODE%" --disable-warning=ExperimentalWarning src\server.js
pause
