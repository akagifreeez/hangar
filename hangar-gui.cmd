@echo off
REM Hangar GUI launcher.  First run:  npm install  then  npm run build
REM Clear ELECTRON_RUN_AS_NODE: if it is set in the environment, Electron starts
REM in Node mode and crashes (app is undefined).  Then launch electron.exe directly
REM (going through the node-based electron.cmd shim can exit immediately on some setups).
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo [Hangar] electron not found: "%ELECTRON_EXE%"
  echo [Hangar] Run:  npm install
  pause
  exit /b 1
)
if not exist "%~dp0dist\cli.js" (
  echo [Hangar] dist is not built.  Run:  npm run build
  pause
  exit /b 1
)
start "Hangar" "%ELECTRON_EXE%" "%~dp0." %*
endlocal
