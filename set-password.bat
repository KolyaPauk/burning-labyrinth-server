@echo off
cd /d "%~dp0"
if exist runtime\node.exe (set "NODE=runtime\node.exe") else (set "NODE=node")
"%NODE%" --disable-warning=ExperimentalWarning src\set-password.js
pause
