#!/usr/bin/env bash
# Rincy 启动脚本
# 自动检查 Node.js，启动服务，打开浏览器。

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

# 2. 检查 Node 版本
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 版本太低（当前 $(node -v)），需要 18 或更高。"
  exit 1
fi

# 3. 启动服务（后台）
echo "正在启动 Rincy…"
node src/server.js &
SERVER_PID=$!

# 4. 等端口就绪
for i in $(seq 1 30); do
  if curl -s -o /dev/null "${URL}" 2>/dev/null; then
    break
  fi
  sleep 0.3
done

# 5. 打开浏览器
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

# 6. 等用户 Ctrl+C 退出
trap "echo ''; echo '正在关闭 Rincy…'; kill ${SERVER_PID} 2>/dev/null; exit 0" INT TERM
wait ${SERVER_PID}
