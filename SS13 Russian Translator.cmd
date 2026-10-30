@echo off
title SS13 Russian Translator
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0runtime\bun.exe" (
  echo First start: getting the Bun runtime the translator runs on...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get_bun.ps1"
)
if not exist "%~dp0runtime\bun.exe" (
  pause
  exit /b 1
)
rem Shortcuts with the translator's icon (in this folder and on the desktop), made once.
if exist "%~dp0SS13 Russian Translator.lnk" goto run
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; foreach ($p in @('%~dp0SS13 Russian Translator.lnk', (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SS13 Russian Translator.lnk'))) { $s = $ws.CreateShortcut($p); $s.TargetPath = '%~dp0SS13 Russian Translator.cmd'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0ui\icon.ico'; $s.Description = 'SS13 Russian Translator'; $s.Save() }" >nul 2>nul
:run
"%~dp0runtime\bun.exe" "%~dp0src\bridge.js" %*
echo.
echo Translator stopped.
pause
