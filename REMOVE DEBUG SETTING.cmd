@echo off
rem The translator removes this setting itself when it stops and BYOND is closed.
rem Run this only if the translator window was killed and you want BYOND fully back to normal.
echo Closing BYOND so the setting can be removed safely...
taskkill /f /im dreamseeker.exe >nul 2>nul
taskkill /f /im byond.exe >nul 2>nul
reg delete "HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments" /v dreamseeker.exe /f >nul 2>nul
reg delete "HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments" /v byond.exe /f >nul 2>nul
echo Done. BYOND will start normally (without the translator) next time.
pause
