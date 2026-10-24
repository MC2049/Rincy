@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "src\server.js" cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Run start.bat first to set up the environment.
  pause
  exit /b 1
)
echo Current version:
node -p "require('./package.json').version" 2>nul
echo.
set "TMPD=%TEMP%\rincy-update-%RANDOM%"
mkdir "%TMPD%"
set "ZIP=%TMPD%\payload.zip"

echo Trying GitHub Releases ...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/MC2049/Rincy/releases/latest' -TimeoutSec 30; $a = $r.assets | Where-Object { $_.name -like 'rincy-payload-*.zip' } | Select-Object -First 1; if (-not $a) { throw 'no payload asset' }; Invoke-WebRequest -Uri $a.browser_download_url -OutFile '%ZIP%' -TimeoutSec 600; Write-Host ('Downloaded: ' + $r.tag_name) } catch { Write-Host ('GitHub failed: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto gitee
goto extract

:gitee
echo GitHub failed. Trying Gitee main archive ...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri 'https://gitee.com/mc2049/Rincy/repository/archive/main.zip' -OutFile '%ZIP%' -TimeoutSec 600 } catch { Write-Host ('Gitee failed: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto fail

:extract
echo Extracting ...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%TMPD%\x' -Force"
if errorlevel 1 goto fail
set "ROOT="
for /d /r "%TMPD%\x" %%d in (*) do if exist "%%d\src\server.js" if not defined ROOT set "ROOT=%%d"
if not defined ROOT (echo No payload directory found & goto fail)
echo Applying update (src and web refreshed; data and node_modules untouched) ...
if exist src rmdir /s /q src
if exist web rmdir /s /q web
xcopy /e /i /y "%ROOT%\src" src >nul
xcopy /e /i /y "%ROOT%\web" web >nul
for %%f in ("lang" "themes") do if exist "%ROOT%\%%~f" xcopy /e /i /y "%ROOT%\%%~f" "%%~f" >nul
for %%f in ("package.json" "package-lock.json" "README.md" "quick-start.md" "start.bat" "start.sh" "update.bat" "update.sh") do if exist "%ROOT%\%%~f" copy /y "%ROOT%\%%~f" "%%~f" >nul
echo.
echo Update done. New version:
node -p "require('./package.json').version" 2>nul
echo Restart the server to take effect. Your data is untouched.
rd /s /q "%TMPD%" 2>nul
pause
goto eof
:fail
echo Update FAILED. You can use in-app upgrade instead.
rd /s /q "%TMPD%" 2>nul
pause
:eof
