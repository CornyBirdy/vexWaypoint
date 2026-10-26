@echo off
rem Standalone launcher (without Rack): starts the server and opens the sim in your browser.
rem You can also just double-click index.html - the sim works from a file as well.
setlocal
cd /d "%~dp0"
if "%SIM_PORT%"=="" set "SIM_PORT=8137"
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%SIM_PORT%/"
call run-sim.bat
