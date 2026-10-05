#!/usr/bin/env bash
# Rincy Linux 打包脚本：源码 + node_modules 一起打包（用户解压即用，无需联网）
#
# 注意：暂存目录放在 /tmp 而不是仓库目录，因为 /sdcard（Android FUSE）
# 存不下可执行位，而 start.sh 需要带上 x 权限，用户解压后才能直接 ./start.sh
set -e

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

# 1. 在 /tmp 建暂存目录
STAGE="$(mktemp -d /tmp/rincy-build-XXXXXX)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# 2. 复制源码
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/package.json" "$ROOT/start.sh" "$ROOT/README.md" "$STAGE/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$STAGE/"
[ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$STAGE/"

# 3. 复制依赖（busboy / tar 等）
if [ -d "$ROOT/node_modules" ]; then
  cp -r "$ROOT/node_modules" "$STAGE/"
else
  echo "警告：没有 node_modules，包里不含依赖（用户首次运行会通过 start.sh 自动安装）"
fi

# 4. 在 /tmp 上补可执行位（tar 会把权限一起带上）
chmod 755 "$STAGE/start.sh"
chmod -R a+rX "$STAGE/node_modules" 2>/dev/null || true

# 5. 打包
PKG="$ROOT/rincy-v0.1.0-linux.tar.gz"
tar -czf "$PKG" -C "$STAGE" .
echo "✅ 打包完成: $(basename "$PKG") ($(du -sh "$PKG" | cut -d' ' -f1))"
echo "   start.sh 权限: $(tar -tzvf "$PKG" | awk '$NF=="./start.sh"{print $1}')"
