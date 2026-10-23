@echo off
rem Runs the current code of Trackview in its desktop window (npm run tauri dev).
rem Code changes reload live. Close the Trackview window (or press Ctrl+C here) to stop.
title Trackview (dev)
cd /d "%~dp0trackview"

rem Rust/cargo is installed with rustup but may not be on PATH.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where npm >nul 2>nul || (echo npm not found. Install Node.js first. & pause & exit /b 1)
where cargo >nul 2>nul || (echo cargo not found. Install Rust with rustup first. & pause & exit /b 1)

if not exist node_modules (
  echo Installing packages...
  call npm install || (pause & exit /b 1)
)

rem The dev server needs port 5173 free.
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul && (
  echo Port 5173 is already in use - another "npm run dev" is probably running. Close it and try again.
  pause & exit /b 1
)

echo Starting Trackview... the first start compiles Rust and can take a minute.
call npm run tauri dev
if errorlevel 1 pause
