#!/bin/sh
# start.sh — 启动 Rincy（Linux / macOS / Android Termux）
cd "$(dirname "$0")/.."
exec node src/server.js
