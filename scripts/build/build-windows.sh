#!/usr/bin/env bash
# 生成 Windows「启动器」发布包（zip，内含 start.bat / start.ps1）
# 包里不含 node_modules；首次运行自动装依赖。
set -e

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

STAGE="$(mktemp -d /tmp/rincy-win-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/rincy"
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/package.json" "$ROOT/README.md" \
      "$ROOT/start.bat" "$ROOT/start.ps1" "$STAGE/rincy/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$STAGE/rincy/"
[ -f "$ROOT/.env.example" ] && cp "$ROOT/.env.example" "$STAGE/rincy/"

# Windows 的 .bat / .ps1 用 CRLF 更稳
python3 - "$STAGE/rincy" <<'PY'
import os, sys
d = sys.argv[1]
for name in ('start.bat', 'start.ps1'):
    p = os.path.join(d, name)
    with open(p, 'rb') as f:
        data = f.read().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    with open(p, 'wb') as f:
        f.write(data)
print('已规范 CRLF:', 'start.bat start.ps1')
PY

PKG="$ROOT/rincy-launcher-v0.1.0-windows.zip"
rm -f "$PKG"
python3 - "$STAGE" "$PKG" <<'PY'
import os, sys, zipfile
stage, pkg = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(pkg, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(stage):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, stage)
            z.write(full, rel)
    names = z.namelist()
print('zip 内文件数:', len(names))
PY

echo "✅ 打包完成: $(basename "$PKG") ($(du -sh "$PKG" | cut -d' ' -f1))"
