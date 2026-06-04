@echo off
REM Hangar CLI launcher.  使い方:  hangar scan "C:\path\to\booth"
REM 事前に:  npm install
set "HANGAR_DB=%~dp0hangar.db"
set "HANGAR_CACHE=%~dp0cache"
"%~dp0node_modules\.bin\tsx.cmd" "%~dp0src\cli.ts" %*
