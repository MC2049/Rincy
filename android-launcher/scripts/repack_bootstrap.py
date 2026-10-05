#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「Node 运行时 + Rincy 源码」内置进 Termux bootstrap，并改写 com.termux -> com.rincy.launcher

产物：可直接作为 app/src/main/cpp/bootstrap-aarch64.zip 的 zip

设计要点：
  * 文本文件里的 /data/data/com.termux/files 全部改写为新前缀（二进制无硬编码，已核实）
  * Node 运行时（9 个 deb）打包成 home/node-runtime.tar.gz，由首次启动时的 tar 解包，
    这样权限/软链完全由 Termux 自带 tar 保证，避免 dpkg 与前缀不匹配的坑
  * Rincy 源码（含 node_modules）直接放进 home/rincy/
"""
import gzip
import io
import os
import re
import sys
import tarfile
import zipfile

# 路径可用环境变量覆盖
SRC_ZIP = os.environ.get('RINCY_SRC_ZIP', './vendor/bootstrap-aarch64.zip')
DEBDIR = os.environ.get('RINCY_DEB_DIR', './vendor/node-deb')
RINCY_SRC = os.environ.get('RINCY_SOURCE_DIR', '..')
OUT_ZIP = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    'RINCY_OUT_ZIP', './bootstrap-aarch64-repacked.zip')

OLD = b'/data/data/com.termux/files'
NEW = b'/data/data/com.rincy.launcher/files'
OLD_S = OLD.decode()
NEW_S = NEW.decode()
DEB_ROOT = './data/data/com.termux/files/usr/'
DEB_ROOT2 = './data/data/com.termux/files/'

# 需要裁掉的路径前缀（体积优化）。注意不能裁 corepack — nodejs-lts 的 bin/corepack 指向它，否则 node 无法跑 npm/corepack。
PRUNE = ('include/', 'share/doc/', 'share/man/', 'share/info/', 'var/', 'lib/pkgconfig/')


OLD_SHORT = b'/data/data/com.termux'
NEW_SHORT = b'/data/data/com.rincy.launcher'


def _is_text(data: bytes) -> bool:
    """粗略判断是否为文本（二进制里替换会因长度变化损坏文件）"""
    head = data[:8192]
    if b'\x00' in head:
        return False
    try:
        head.decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False


def rewrite(data: bytes) -> bytes:
    if OLD in data:
        data = data.replace(OLD, NEW)
    # 短前缀（如 /data/data/com.termux/cache/...）：只改文本，避免破坏二进制
    if OLD_SHORT in data and _is_text(data):
        data = data.replace(OLD_SHORT, NEW_SHORT)
    return data


def ar_entries(path):
    """极简 ar 解析：返回 {name: bytes}"""
    out = {}
    with open(path, 'rb') as f:
        if f.read(8) != b'!<arch>\n':
            raise ValueError('not an ar archive: ' + path)
        while True:
            hdr = f.read(60)
            if len(hdr) < 60:
                break
            name = hdr[0:16].decode('ascii', 'replace').strip()
            size = int(hdr[48:58].decode('ascii').strip())
            data = f.read(size)
            if size % 2:
                f.read(1)
            out[name.rstrip('/')] = data
    return out


def decompress(name, data):
    if name.endswith('.tar.xz'):
        import lzma
        return lzma.decompress(data)
    if name.endswith('.tar.gz'):
        return gzip.decompress(data)
    if name.endswith('.tar.zst'):
        raise RuntimeError('zstd 压缩暂不支持: ' + name)
    if name.endswith('.tar'):
        return data
    return None


def collect_deb(path, tree):
    """把一个 deb 的 data.tar 展开进 tree：{prefix相对路径: (kind, mode, linkname, bytes)}"""
    ar = ar_entries(path)
    data_name = None
    for n in ar:
        if n.startswith('data.tar'):
            data_name = n
            break
    if not data_name:
        raise RuntimeError('deb 里没有 data.tar: ' + path)
    raw = decompress(data_name, ar[data_name])
    added = 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
        for m in tf:
            if m.name in ('.', './'):
                continue
            rel = m.name
            if rel.startswith(DEB_ROOT):
                rel = rel[len(DEB_ROOT):]
            elif rel.startswith(DEB_ROOT2):
                rel = rel[len(DEB_ROOT2):]
            rel = rel.lstrip('./').lstrip('/')
            # 丢掉 deb 里作为「根占位」的 data/... 空目录（前缀目录本身，无内容）
            if not rel or rel.split('/')[0] == 'data':
                continue
            if any(rel.startswith(p) or rel.startswith('usr/' + p) for p in PRUNE):
                continue
            if m.isdir():
                tree.setdefault(rel + '/', ('dir', m.mode, '', b''))
                continue
            if m.issym():
                link = m.linkname
                if link.startswith(OLD_S):
                    link = NEW_S + link[len(OLD_S):]
                tree[rel] = ('sym', m.mode, link, b'')
                added += 1
                continue
            if m.islnk():
                tree[rel] = ('link', m.mode, m.linkname, b'')
                added += 1
                continue
            f = tf.extractfile(m)
            data = f.read() if f else b''
            tree[rel] = ('file', m.mode, '', rewrite(data))
            added += 1
    return added


def build_node_runtime():
    debs = sorted(os.listdir(DEBDIR))
    tree = {}
    total = 0
    for d in debs:
        if not d.endswith('.deb'):
            continue
        n = collect_deb(os.path.join(DEBDIR, d), tree)
        print('   %-45s %d 个文件' % (d, n))
        total += n
    print('   node 运行时合计 %d 个条目' % total)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.PAX_FORMAT) as tf:
        # 目录先入
        for path in sorted(tree):
            kind, mode, link, data = tree[path]
            if kind != 'dir':
                continue
            ti = tarfile.TarInfo(path.rstrip('/'))
            ti.type = tarfile.DIRTYPE
            ti.mode = mode & 0o7777 or 0o755
            ti.mtime = 0
            tf.addfile(ti)
        for path in sorted(tree):
            kind, mode, link, data = tree[path]
            if kind == 'dir':
                continue
            ti = tarfile.TarInfo(path)
            ti.mode = mode & 0o7777 or 0o644
            ti.mtime = 0
            if kind == 'sym':
                ti.type = tarfile.SYMTYPE
                ti.linkname = link
                tf.addfile(ti)
            elif kind == 'link':
                ti.type = tarfile.LNKTYPE
                ti.linkname = link
                tf.addfile(ti)
            else:
                ti.type = tarfile.REGTYPE
                ti.size = len(data)
                tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


BOOT_SH = r'''#!/bin/sh
# Rincy 启动脚本（由 APK 内置，首次运行会解包 Node 运行时）
set -u

PREFIX="${PREFIX:-/data/data/com.rincy.launcher/files/usr}"
HOME_DIR="${HOME:-/data/data/com.rincy.launcher/files/home}"
RINCY_DIR="$HOME_DIR/rincy"
PORT="${RINCY_PORT:-4780}"
LOG="$HOME_DIR/rincy-boot.log"

export PATH="$PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib"
export HOME="$HOME_DIR"
export TMPDIR="$PREFIX/tmp"
export LANG=C.UTF-8
mkdir -p "$TMPDIR"

{
  echo "=== Rincy 启动 $(date) ==="
  echo "PREFIX=$PREFIX"

  # 1. 首次运行：解包内置的 Node 运行时
  if [ ! -x "$PREFIX/bin/node" ]; then
    echo "[1/3] 正在解包内置 Node 运行时…"
    if [ -f "$HOME_DIR/node-runtime.tar.gz" ]; then
      tar -xzf "$HOME_DIR/node-runtime.tar.gz" -C "$PREFIX" && echo "      解包完成" || echo "      ❌ 解包失败"
    else
      echo "      ❌ 找不到 node-runtime.tar.gz"
    fi
  else
    echo "[1/3] Node 运行时已就绪"
  fi

  # 2. 已经在跑就不重复启动
  if [ -f "$HOME_DIR/.rincy.pid" ] && kill -0 "$(cat "$HOME_DIR/.rincy.pid")" 2>/dev/null; then
    echo "[2/3] Rincy 已在运行 (pid $(cat "$HOME_DIR/.rincy.pid"))"
    exit 0
  fi

  # 3. 启动服务
  echo "[2/3] Node 版本: $("$PREFIX/bin/node" -v 2>&1)"
  cd "$RINCY_DIR" || { echo "❌ 找不到 $RINCY_DIR"; exit 1; }
  RINCY_PORT="$PORT" nohup "$PREFIX/bin/node" src/server.js >> "$LOG" 2>&1 &
  echo $! > "$HOME_DIR/.rincy.pid"
  echo "[3/3] 已启动，pid=$(cat "$HOME_DIR/.rincy.pid")，端口=$PORT"
} >> "$LOG" 2>&1

exit 0
'''

PROFILE_HOOK = r'''# Rincy 启动器：交互式 shell 启动时自动拉起 Rincy（只拉起一次）
if [ -x "$PREFIX/../home/rincy-boot.sh" ] && [ -z "${RINCY_BOOTED:-}" ]; then
  RINCY_BOOTED=1
  "$PREFIX/../home/rincy-boot.sh" &
fi
'''


def write_zip(out_path, node_tar_gz):
    src_entries = []
    with zipfile.ZipFile(SRC_ZIP) as z:
        for info in z.infolist():
            data = b'' if info.is_dir() else z.read(info.filename)
            src_entries.append((info.filename, rewrite(data), info.is_dir()))

    n_rewritten = 0
    for name, data, _ in src_entries:
        if data and (b'com.termux' in data) is False and OLD in data:
            n_rewritten += 1

    # Rincy 源码（含 node_modules）
    rincy_files = []
    include = ['src', 'web', 'package.json', 'package-lock.json', 'README.md', 'start.sh', 'node_modules']
    for item in include:
        full = os.path.join(RINCY_SRC, item)
        if os.path.isfile(full):
            rincy_files.append((item, open(full, 'rb').read()))
        elif os.path.isdir(full):
            for base, dirs, files in os.walk(full):
                dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
                for fn in files:
                    fp = os.path.join(base, fn)
                    rel = os.path.relpath(fp, RINCY_SRC)
                    rincy_files.append((rel, open(fp, 'rb').read()))

    extra = []
    for rel, data in rincy_files:
        extra.append(('home/rincy/' + rel.replace(os.sep, '/'), data))
    extra.append(('home/node-runtime.tar.gz', node_tar_gz))
    extra.append(('home/rincy-boot.sh', BOOT_SH.replace(OLD_S, NEW_S).encode()))
    extra.append(('etc/profile.d/99-rincy.sh', PROFILE_HOOK.replace(OLD_S, NEW_S).encode()))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name, data, is_dir in src_entries:
            zi = zipfile.ZipInfo(name)
            zi.external_attr = (0o755 if is_dir else 0o644) << 16
            if is_dir:
                zi.external_attr |= 0x10
                z.writestr(zi, b'')
            else:
                z.writestr(zi, data)
        for name, data in extra:
            zi = zipfile.ZipInfo(name)
            mode = 0o755 if (name.endswith('.sh') or name.endswith('node-runtime.tar.gz')) else 0o644
            zi.external_attr = mode << 16
            z.writestr(zi, data)

    print('原始条目: %d，新增条目: %d' % (len(src_entries), len(extra)))
    print('产物: %s (%.1f MB)' % (out_path, os.path.getsize(out_path) / 1048576.0))
    print('Rincy 文件数: %d' % len(rincy_files))


def main():
    print('=== 1. 打包 Node 运行时 ===')
    node_tar = build_node_runtime()
    print('   node-runtime.tar.gz: %.1f MB' % (len(node_tar) / 1048576.0))
    print('=== 2. 合并 bootstrap + 运行时 + Rincy ===')
    write_zip(OUT_ZIP, node_tar)
    print('=== 完成 ===')


if __name__ == '__main__':
    main()
