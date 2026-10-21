@echo off
rem start.bat - Rincy launcher (Windows)
rem Self-locating: works at package root, or inside a scripts\ subfolder.
cd /d "%~dp0"
if not exist "src\server.js" cd /d "%~dp0.."
if not exist "src\server.js" (
  echo [ERROR] src\server.js not found next to this file.
  echo Keep start.bat together with the src folder.
  pause
  exit /b 1
)

if "%RINCY_PORT%"=="" set RINCY_PORT=3000
set URL=http://127.0.0.1:%RINCY_PORT%

echo ==============================
echo   Rincy
echo ==============================
echo.

rem ---- 1. Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js 18 or newer first: https://nodejs.org/
  pause
  exit /b 1
)

rem ---- 2. Check npm ----
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. It usually ships with Node.js.
  pause
  exit /b 1
)

rem ---- 3. Dependencies: install if missing (first run needs network) ----
if not exist "node_modules\busboy" goto do_install
if not exist "node_modules\tar" goto do_install
goto deps_ok

:do_install
echo First run: installing dependencies (busboy / tar) ...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your network and retry.
  pause
  exit /b 1
)

:deps_ok
rem ---- 4. Start the server in a minimized window ----
echo Starting Rincy ...
start "Rincy server" /min cmd /c "node src\server.js"

rem ---- 5. Wait for the port to come up ----
set /a TRIES=0
:wait_loop
set /a TRIES+=1
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1', %RINCY_PORT%)).Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto ready
if %TRIES% GEQ 30 goto timeout
timeout /t 1 /nobreak >nul
goto wait_loop

:timeout
echo [WARN] Timed out waiting for the port. Open %URL% manually.
echo Tip: if the port is taken, run: set RINCY_PORT=3080 first.
pause
exit /b 0

:ready
echo Rincy is running: %URL%
start "" "%URL%"
echo.
echo Tip: closing this window does NOT stop the server.
echo To stop the server, end node.exe in Task Manager.
pause
exit /b 0
