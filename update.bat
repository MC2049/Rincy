@echo off
setlocal
cd /d "%~dp0"
if not exist "src\server.js" cd /d "%~dp0.."

echo Current version:
node -p "require(./package.json).version" 2>nul
echo.
set "TMPD=%TEMP%\rincy-update-%RANDOM%"
mkdir "%TMPD%"
echo Fetching latest release info ...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri https://api.github.com/repos/MC2049/Rincy/releases/latest -TimeoutSec 30; $a = $r.assets | Where-Object { $_.name -like rincy-payload-*.zip } | Select-Object -First 1; if (-not $a) { throw no payload asset }; [IO.File]::WriteAllText(%TMPD%\url.txt, $a.browser_download_url); Write-Host (Latest:  + $r.tag_name) } catch { Write-Host (FAILED:  + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto fail
set /p URL=<"%TMPD%\url.txt"
echo Downloading %URL% ...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri %URL% -OutFile %TMPD%\payload.zip -TimeoutSec 600"
if errorlevel 1 goto fail
echo Extracting ...
powershell -NoProfile -Command "Expand-Archive -Path %TMPD%\payload.zip -DestinationPath %TMPD%\x -Force"
if errorlevel 1 goto fail
set "ROOT="
for /d /r "%TMPD%\x" %%d in (*) do if exist "%%d\src\server.js" if not defined ROOT set "ROOT=%%d"
if not defined ROOT (echo No payload directory found & goto fail)
echo Applying update (src and web are refreshed; data and node_modules untouched) ...
if exist src rmdir /s /q src
if exist web rmdir /s /q web
xcopy /e /i /y "%ROOT%\src" src >nul
xcopy /e /i /y "%ROOT%\web" web >nul
for %%f in ("lang" "themes") do if exist "%ROOT%\%%~f" xcopy /e /i /y "%ROOT%\%%~f" "%%~f" >nul
for %%f in ("package.json" "package-lock.json" "README.md" "quick-start.md" "start.bat" "start.sh" "update.bat" "update.sh") do if exist "%ROOT%\%%~f" copy /y "%ROOT%\%%~f" "%%~f" >nul
echo.
echo Update done. New version:
node -p "require(./package.json).version" 2>nul
echo Restart the server to take effect. Your data/ is untouched.
rd /s /q "%TMPD%" 2>nul
pause
goto eof
:fail
echo Update FAILED. You can use in-app upgrade instead.
rd /s /q "%TMPD%" 2>nul
pause
:eof
