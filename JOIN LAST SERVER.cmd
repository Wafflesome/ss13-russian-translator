@echo off
rem Starts the translator and rejoins the server you played on last (handy for your local test server).
title SS13 Russian Translator
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0runtime\bun.exe" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get_bun.ps1"
"%~dp0runtime\bun.exe" "%~dp0src\bridge.js" --join-last
echo.
echo Translator stopped.
pause
