@echo off
chcp 65001 >nul
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0game-on.ps1"
echo.
pause
