@echo off
chcp 65001 >nul
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0game-off.ps1"
echo.
pause
