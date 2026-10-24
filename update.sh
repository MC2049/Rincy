#!/bin/sh
# Rincy 自动更新（update.sh）：拉最新载荷包并就地覆盖。Linux / macOS 用。
# 覆盖纪律（与启动器 overlay 一致）：src/ web/ 全量刷新；其余文件只增改不删；
# data/（你的数据）与 node_modules/（依赖）绝对不动。
# 源：优先 GitHub Releases；失败回退 Gitee 主分支归档（国内可达）。
set -e
cd "$(dirname "$0")" || exit 1
if [ ! -f "src/server.js" ]; then cd .. || exit 1; fi

command -v node >/dev/null 2>&1 || { echo "需要 Node.js（先跑 start.sh 装好环境）。"; exit 1; }
echo "当前版本：$(node -p "require('./package.json').version" 2>/dev/null || echo 未知)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SRC=""
echo "尝试 GitHub Releases …"
INFO="$(curl -fsSL --retry 2 -m 30 https://api.github.com/repos/MC2049/Rincy/releases/latest 2>/dev/null || true)"
ASSET="$(printf '%s' "$INFO" | grep -o '"browser_download_url": *"[^"]*rincy-payload-[0-9.]*\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
if [ -n "$ASSET" ] && curl -fSL --retry 2 -m 600 -o "$TMP/payload.zip" "$ASSET" 2>/dev/null; then
  SRC="zip"
else
  echo "GitHub 不可达，改走 Gitee 主分支归档 …"
  curl -fSL --retry 2 -m 600 -o "$TMP/src.zip" "https://gitee.com/mc2049/Rincy/repository/archive/main.zip" || { echo "两个源都失败了。请检查网络，或改用应用内升级。"; exit 1; }
  SRC="src"
fi
FILE="$TMP/payload.zip"; [ "$SRC" = "src" ] && FILE="$TMP/src.zip"
echo "解包…"
unzip -q -o "$FILE" -d "$TMP/x"
ROOT="$(find "$TMP/x" -maxdepth 3 -type d -name src | head -1 | sed 's|/src$||')"
[ -n "$ROOT" ] || { echo "包内没找到载荷目录（src/server.js）。"; exit 1; }

rm -rf src web
cp -r "$ROOT/src" "$ROOT/web" .
for f in lang themes package.json package-lock.json README.md quick-start.md start.bat start.sh update.bat update.sh; do
  [ -e "$ROOT/$f" ] && cp -r "$ROOT/$f" . || true
done
chmod +x start.sh update.sh 2>/dev/null || true

echo "更新完成：$(node -p "require('./package.json').version" 2>/dev/null || echo 未知)"
echo "重启服务生效（停掉旧的再 node src/server.js）。data/ 里的数据不受影响。"
