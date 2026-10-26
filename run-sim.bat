@echo off
rem Foreground launcher for Rack: serves the sim on %SIM_PORT% (default 8137).
rem Does not open a browser and does not wait for a keypress.
setlocal
cd /d "%~dp0"
if "%SIM_PORT%"=="" set "SIM_PORT=8137"

python -c "import sys" >nul 2>nul
if not errorlevel 1 goto usepython
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 goto usepy
goto usepowershell

:usepython
python serve.py %SIM_PORT%
exit /b %errorlevel%

:usepy
py -3 serve.py %SIM_PORT%
exit /b %errorlevel%

:usepowershell
powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -Port %SIM_PORT%
exit /b %errorlevel%
