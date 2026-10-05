#!/usr/bin/env bash
# 生成 Linux/macOS「启动器」发布包（tar.gz）
# 包里只有源码 + start.sh，不含 node_modules；首次运行自动装依赖。
set -e

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

STAGE="$(mktemp -d /tmp/rincy-lin-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/rincy"
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/start.sh" "$STAGE/rincy/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$STAGE/rincy/"
[ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$STAGE/rincy/"

# 在 /tmp 上补可执行位（/sdcard 存不下 x 位，tar 会带上）
chmod 755 "$STAGE/rincy/start.sh"

PKG="$ROOT/rincy-launcher-v0.1.0-linux.tar.gz"
tar -czf "$PKG" -C "$STAGE" rincy

echo "✅ 打包完成: $(basename "$PKG") ($(du -sh "$PKG" | cut -d' ' -f1))"
echo "   start.sh 权限: $(tar -tzvf "$PKG" | awk '$NF=="rincy/start.sh"{print $1}')"
