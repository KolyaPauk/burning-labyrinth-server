@echo off
cd /d "%~dp0"
if exist runtime\node.exe (set "NODE=runtime\node.exe") else (set "NODE=node")
echo === Full reset: stops the server and deletes the whole database, including the admin password ===
"%NODE%" --disable-warning=ExperimentalWarning src\reset-db.js
pause
