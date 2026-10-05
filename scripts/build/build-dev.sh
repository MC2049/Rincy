#!/usr/bin/env bash
# 开发/离线包：包含 node_modules（体积大，仅供内部/离线部署用）
set -e

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

STAGE="$(mktemp -d /tmp/rincy-dev-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/rincy"
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/package.json" "$ROOT/README.md" \
      "$ROOT/start.sh" "$ROOT/start.bat" "$ROOT/start.ps1" "$STAGE/rincy/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$STAGE/rincy/"
[ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$STAGE/rincy/"

if [ -d "$ROOT/node_modules" ]; then
  cp -r "$ROOT/node_modules" "$STAGE/rincy/"
else
  echo "警告：没有 node_modules，这个包将不含依赖"
fi

chmod 755 "$STAGE/rincy/start.sh"

PKG="$ROOT/rincy-dev-with-deps-v0.1.0.tar.gz"
tar -czf "$PKG" -C "$STAGE" rincy
echo "✅ 打包完成: $(basename "$PKG") ($(du -sh "$PKG" | cut -d' ' -f1))"
