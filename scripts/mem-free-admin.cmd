@echo off
rem ?????? Hindsight + ?? Tobii RGB ???????? 1.7 GB?
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0mem-free.ps1','-Tobii'"
