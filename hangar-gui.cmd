@echo off
REM Hangar GUI launcher.  事前に:  npm install ^&^& npm run build
REM ELECTRON_RUN_AS_NODE が環境に残っているとNodeモードで起動してしまうのでクリア
set "ELECTRON_RUN_AS_NODE="
"%~dp0node_modules\.bin\electron.cmd" "%~dp0." %*
