#!/usr/bin/env bash
# Rincy 启动脚本
# 自动检查 Node.js / npm，启动服务，打开浏览器。
# 首次运行自动安装依赖（busboy / tar），之后离线可用。

set -e

cd "$(dirname "$0")"

PORT="${RINCY_PORT:-3000}"
URL="http://127.0.0.1:${PORT}"

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。"
  echo ""
  echo "请先安装 Node.js 18 或更高版本："
  echo "  - Termux:        pkg install nodejs-lts"
  echo "  - Debian/Ubuntu: sudo apt install nodejs npm"
  echo "  - macOS:         brew install node"
  echo ""
  echo "安装后重新运行这个脚本。"
  exit 1
fi

# 2. 检查 npm
if ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 npm（Node.js 包管理器）。"
  echo "请先安装 Node.js 18 或更高版本："
  echo "  - Termux:        pkg install nodejs-lts"
  echo "  - Debian/Ubuntu: sudo apt install nodejs npm"
  echo "  - macOS:         brew install node"
  exit 1
fi

# 3. 检查/安装依赖（首次运行自动安装，之后离线可用）
if [ ! -d "node_modules" ]; then
  if [ ! -f "package.json" ]; then
    echo "错误：未找到 package.json，无法安装依赖。"
    exit 1
  fi
  echo "首次运行，正在安装依赖（busboy / tar）…"
  if ! npm install --no-audit --no-fund; then
    echo ""
    echo "依赖安装失败。请检查网络后重新运行此脚本。"
    echo "也可手动执行：npm install"
    exit 1
  fi
fi

# 4. 验证关键依赖是否存在（防止 node_modules 残缺）
for dep in busboy tar; do
  if [ ! -d "node_modules/$dep" ]; then
    echo "警告：node_modules/$dep 缺失，正在重新安装依赖…"
    npm install --no-audit --no-fund || {
      echo "依赖安装失败，请检查网络后重试。"
      exit 1
    }
    break
  fi
done

# 5. 检查 Node 版本
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 版本太低（当前 $(node -v)），需要 18 或更高。"
  exit 1
fi

# 6. 启动服务（后台）
echo "正在启动 Rincy…"
node src/server.js &
SERVER_PID=$!

# 7. 等端口就绪
for i in $(seq 1 30); do
  if curl -s -o /dev/null "${URL}" 2>/dev/null; then
    break
  fi
  sleep 0.3
done

# 8. 打开浏览器
echo "Rincy 已启动：${URL}"
if command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "${URL}"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "${URL}"
else
  echo "请手动在浏览器打开：${URL}"
fi

# 9. 等用户 Ctrl+C 退出
trap "echo ''; echo '正在关闭 Rincy…'; kill ${SERVER_PID} 2>/dev/null; exit 0" INT TERM
wait ${SERVER_PID}
