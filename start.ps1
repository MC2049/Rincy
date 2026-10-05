# Rincy 启动器（PowerShell 版）
# 用法：powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$port = if ($env:RINCY_PORT) { $env:RINCY_PORT } else { '3000' }
$url  = "http://127.0.0.1:$port"

function Die($msg) {
  Write-Host "[错误] $msg" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

Write-Host '==============================' -ForegroundColor Cyan
Write-Host '  Rincy 启动器' -ForegroundColor Cyan
Write-Host '==============================' -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die @'
没有找到 Node.js。请先安装 Node.js 18 或更高版本：
  官网:   https://nodejs.org/
  winget: winget install OpenJS.NodeJS.LTS
安装后重新运行本脚本。
'@
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die '没有找到 npm（通常随 Node.js 一起安装）。' }

# 2. 版本
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Die "Node.js 版本太低（当前 $(node -v)），需要 18 或更高。" }

# 3. 依赖：缺失则自动安装（首次运行需联网）
$needInstall = $false
foreach ($dep in @('busboy', 'tar')) {
  if (-not (Test-Path "node_modules/$dep")) { $needInstall = $true }
}
if (-not (Test-Path 'node_modules')) { $needInstall = $true }

if ($needInstall) {
  Write-Host '首次运行，正在安装依赖（busboy / tar）…'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die '依赖安装失败，请检查网络后重试（也可手动执行 npm install）。' }
}

# 4. 启动服务
Write-Host '正在启动 Rincy…'
Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WindowStyle Minimized

# 5. 等端口就绪
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]$port)
    $c.Close()
    $ready = $true
    break
  } catch { Start-Sleep -Milliseconds 300 }
}

if (-not $ready) {
  Write-Host "[警告] 等待超时，请手动打开 $url" -ForegroundColor Yellow
  Write-Host '提示：若端口被占用，可设置 RINCY_PORT 后重试。'
} else {
  Write-Host "Rincy 已启动：$url" -ForegroundColor Green
  Start-Process $url
}
Read-Host '按回车退出（关闭本窗口不会停止服务）'
