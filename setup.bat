@echo off
rem One-time check, run by hand. There is nothing to download or build:
rem the sim is plain HTML/JS and only needs Python OR Windows PowerShell to be served.
setlocal
cd /d "%~dp0"
set "RUNTIME="

python -c "import sys" >nul 2>nul
if not errorlevel 1 set "RUNTIME=Python"

if not defined RUNTIME (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "RUNTIME=Python (py launcher)"
)
if not defined RUNTIME (
    where powershell >nul 2>nul
    if not errorlevel 1 set "RUNTIME=Windows PowerShell"
)

if not defined RUNTIME (
    echo.
    echo [FAIL] Neither Python nor Windows PowerShell was found, so the sim cannot be served.
    echo        Install Python from https://www.python.org/downloads/ and run this again.
    set "CODE=1"
) else (
    echo.
    echo [OK] The sim will be served with: %RUNTIME%
    echo      Nothing else needs installing. Add this folder to Rack and press Start.
    set "CODE=0"
)

pause
exit /b %CODE%
