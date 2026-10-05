@echo off
chcp 65001 >nul
setlocal
title Rincy 启动器

cd /d "%~dp0"

if "%RINCY_PORT%"=="" set RINCY_PORT=3000
set URL=http://127.0.0.1:%RINCY_PORT%

echo ==============================
echo   Rincy 启动器
echo ==============================
echo(

rem ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。
  echo(
  echo 请先安装 Node.js 18 或更高版本：
  echo   官网:   https://nodejs.org/
  echo   winget: winget install OpenJS.NodeJS.LTS
  echo(
  echo 安装后重新双击本文件。
  pause
  exit /b 1
)

rem ---- 2. 检查 npm ----
where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 npm（通常随 Node.js 一起安装）。
  pause
  exit /b 1
)

rem ---- 3. 检查 Node 版本 ----
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo [错误] Node.js 版本太低，需要 18 或更高。当前：
  node -v
  pause
  exit /b 1
)

rem ---- 4. 依赖：缺失则自动安装（首次运行需联网）----
if not exist "node_modules" goto do_install
if not exist "node_modules\busboy" goto do_install
if not exist "node_modules\tar" goto do_install
goto deps_ok

:do_install
echo 首次运行，正在安装依赖（busboy / tar）…
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo(
  echo [错误] 依赖安装失败。请检查网络后重新运行。
  echo 也可以手动执行: npm install
  pause
  exit /b 1
)

:deps_ok
rem ---- 5. 启动服务（独立最小化窗口）----
echo 正在启动 Rincy…
start "Rincy 服务" /min cmd /c "node src\server.js"

rem ---- 6. 等端口就绪 ----
set /a TRIES=0
:wait_loop
set /a TRIES+=1
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1', %RINCY_PORT%)).Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto ready
if %TRIES% GEQ 30 goto timeout
timeout /t 1 /nobreak >nul
goto wait_loop

:timeout
echo [警告] 等待超时，请手动在浏览器打开：%URL%
echo 提示：若端口被占用，可先执行 set RINCY_PORT=3080 再运行。
pause
exit /b 0

:ready
echo Rincy 已启动：%URL%
start "" "%URL%"
echo(
echo 提示：关闭本窗口不会停止服务。停止服务请在任务管理器里结束 node.exe。
pause
exit /b 0
