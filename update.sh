#!/bin/sh
# Rincy 自动更新（update.sh）：从 GitHub Releases 拉最新载荷包并就地覆盖。
# 覆盖纪律（与启动器 overlay 一致）：src/ web/ 全量刷新；其余文件只增改不删；
# data/（你的数据）与 node_modules/（依赖）绝对不动。Linux / macOS 用。
set -e
cd "$(dirname "$0")" || exit 1
if [ ! -f "src/server.js" ]; then cd .. || exit 1; fi

CUR="$(node -p "require('./package.json').version" 2>/dev/null || echo 未知)"
echo "当前版本：$CUR"
echo "查询最新版本…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

INFO="$(curl -fsSL --retry 3 -m 30 https://api.github.com/repos/MC2049/Rincy/releases/latest 2>/dev/null || true)"
ASSET="$(printf '%s' "$INFO" | grep -o '"browser_download_url": *"[^"]*rincy-payload-[0-9.]*\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$ASSET" ] || { echo "没拿到最新载荷包（网络问题？可改用应用内升级）。"; exit 1; }
echo "最新：$ASSET"
echo "下载…"
curl -fSL --retry 3 -m 600 -o "$TMP/payload.zip" "$ASSET"
echo "解包…"
unzip -q -o "$TMP/payload.zip" -d "$TMP/x"
ROOT="$(find "$TMP/x" -maxdepth 3 -type d -name src | head -1 | sed 's|/src$||')"
[ -n "$ROOT" ] || { echo "包内没找到载荷目录（src/server.js）。"; exit 1; }

rm -rf src web
cp -r "$ROOT/src" "$ROOT/web" .
for f in lang themes package.json package-lock.json README.md quick-start.md start.bat start.sh update.bat update.sh; do
  if [ -e "$ROOT/$f" ]; then cp -r "$ROOT/$f" .; fi
done
chmod +x start.sh update.sh 2>/dev/null || true

NEW="$(node -p "require('./package.json').version" 2>/dev/null || echo 未知)"
echo "更新完成：$CUR → $NEW"
echo "重启服务生效（停掉旧的再 node src/server.js）。data/ 里的数据不受影响。"
