#!/bin/sh
# start.sh — 启动 Rincy（Linux / macOS / Android Termux）
# 兼容两种摆放：包根（zip 解压后）或仓库 scripts/ 目录（自动向上找一层）
cd "$(dirname "$0")"
if [ ! -f "src/server.js" ]; then cd ..; fi
exec node src/server.js
