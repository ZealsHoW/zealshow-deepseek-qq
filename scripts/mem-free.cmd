@echo off
rem ?? Hindsight?? 1.9~2.7 GB????????
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mem-free.ps1" %*
pause
