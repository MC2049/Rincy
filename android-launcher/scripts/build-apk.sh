#!/usr/bin/env bash
# 构建 Rincy 启动器 APK（单 ABI arm64-v8a，debug 签名，未压缩 bootstrap）
#
# 用法：
#   RINCY_TERMUX_DIR=/path/to/termux-app \
#   RINCY_BOOTSTRAP_ZIP=./bootstrap-aarch64-repacked.zip \
#   RINCY_LIBTERMUX_SO=./libtermux.so \
#   ./build-apk.sh
#
# 必需环境变量（有默认值，按需覆盖）：
#   JAVA_HOME        JDK 11（AGP 4.2.2 / Gradle 7.2 不支持 JDK 17）
#   ANDROID_HOME     Android SDK（需 platforms;android-30 与 build-tools;30.0.3）
# 可选：
#   RINCY_GRADLE_ZIP 本地 gradle-7.2-all.zip（离线构建时用，避免联网下载）
#   RINCY_AAPT2      已有的 aapt2 可执行文件（aarch64 宿主建议提供）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERMUX_DIR="${RINCY_TERMUX_DIR:-$HERE/../termux-app}"
JAVA_HOME="${JAVA_HOME:-/opt/jdk/jdk-11.0.32.1+1}"
ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
BOOTSTRAP_ZIP="${RINCY_BOOTSTRAP_ZIP:-$HERE/../bootstrap-aarch64-repacked.zip}"
LIBTERMUX_SO="${RINCY_LIBTERMUX_SO:-$HERE/../libtermux.so}"

export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "==> 环境"
echo "    JAVA_HOME   = $JAVA_HOME"
"$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed 's/^/    /'
echo "    ANDROID_HOME= $ANDROID_HOME"
echo "    TERMUX_DIR  = $TERMUX_DIR"
echo "    bootstrap   = $BOOTSTRAP_ZIP ($(du -h "$BOOTSTRAP_ZIP" | cut -f1))"
echo "    libtermux.so= $LIBTERMUX_SO"

[ -d "$TERMUX_DIR" ] || { echo "!! termux-app 源码目录不存在: $TERMUX_DIR"; exit 1; }

# ---- 1. 应用源码补丁 -------------------------------------------------------
RINCY_BOOTSTRAP_ZIP="$BOOTSTRAP_ZIP" \
RINCY_LIBTERMUX_SO="$LIBTERMUX_SO" \
    python3 "$HERE/apply_patches.py" "$TERMUX_DIR"

# ---- 2. aapt2：aarch64 宿主上的处理 ---------------------------------------
HOST_ARCH="$(uname -m)"
AAPT2_OVERRIDE=""
if [ -n "${RINCY_AAPT2:-}" ]; then
    AAPT2_OVERRIDE="$RINCY_AAPT2"
elif [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
    echo
    echo "==> 宿主为 $HOST_ARCH：AGP 自带的 aapt2 是 x86_64 二进制，需要 qemu 包装"
    QEMU="$(command -v qemu-x86_64-static || true)"
    if [ -z "$QEMU" ]; then
        echo "!! 未找到 qemu-x86_64-static，请先安装（apt-get install qemu-user-static）"
        echo "!! 或自行提供 aarch64 原生 aapt2：RINCY_AAPT2=/path/to/aapt2"
        exit 1
    fi
    REAL_AAPT2="$HERE/.aapt2-x86_64"
    if [ ! -f "$REAL_AAPT2" ]; then
        # 从 Gradle 缓存里的 aapt2 jar 中取出真正的二进制
        JAR="$(find "$HOME/.gradle/caches/modules-2" -name 'aapt2-*-linux.jar' 2>/dev/null | head -1 || true)"
        if [ -z "$JAR" ]; then
            echo "!! 未在 Gradle 缓存中找到 aapt2 jar，请先执行一次 gradlew（让它下载依赖）后重试"
            exit 1
        fi
        python3 - "$JAR" "$REAL_AAPT2" <<'PY'
import sys, zipfile
jar, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(jar) as z:
    open(out, 'wb').write(z.read('aapt2'))
print('extracted aapt2 ->', out)
PY
        chmod +x "$REAL_AAPT2"
    fi
    AAPT2_OVERRIDE="$HERE/.aapt2-wrapper"
    cat > "$AAPT2_OVERRIDE" <<EOF
#!/bin/sh
exec $QEMU -L / "$REAL_AAPT2" "\$@"
EOF
    chmod +x "$AAPT2_OVERRIDE"
    echo "    aapt2 wrapper = $AAPT2_OVERRIDE ($("$AAPT2_OVERRIDE" version 2>&1 | head -1))"
fi

if [ -n "$AAPT2_OVERRIDE" ]; then
    grep -q "aapt2FromMavenOverride" "$TERMUX_DIR/gradle.properties" 2>/dev/null || \
        printf '\n# Rincy: aapt2 覆盖（aarch64 宿主）\nandroid.aapt2FromMavenOverride=%s\n' "$AAPT2_OVERRIDE" \
            >> "$TERMUX_DIR/gradle.properties"
fi

# ---- 3. Gradle wrapper：可用本地 zip 离线运行 -----------------------------
if [ -n "${RINCY_GRADLE_ZIP:-}" ]; then
    echo
    echo "==> 使用本地 Gradle 发行包: $RINCY_GRADLE_ZIP"
    GRADLE_ZIP_ESCAPED="$(printf '%s' "$RINCY_GRADLE_ZIP" | sed 's|:|\\:|g')"
    python3 - "$TERMUX_DIR/gradle/wrapper/gradle-wrapper.properties" "$GRADLE_ZIP_ESCAPED" <<'PY'
import re, sys
path, zip_path = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
s = re.sub(r'distributionUrl=.*', 'distributionUrl=file\\:' + zip_path, s)
open(path, 'w', encoding='utf-8').write(s)
print('wrapper distributionUrl -> file:' + zip_path)
PY
fi

# ---- 4. 构建 ---------------------------------------------------------------
cd "$TERMUX_DIR"
chmod +x gradlew 2>/dev/null || true
# 单 APK（不分 ABI 包），release 同理
export TERMUX_SPLIT_APKS_FOR_DEBUG_BUILDS=0
export TERMUX_SPLIT_APKS_FOR_RELEASE_BUILDS=0

echo
echo "==> ./gradlew assembleDebug"
./gradlew assembleDebug --no-daemon

APK="$(find "$TERMUX_DIR/app/build/outputs/apk" -name '*.apk' | head -1 || true)"
echo
if [ -n "$APK" ]; then
    echo "✅ 构建成功: $APK ($(du -h "$APK" | cut -f1))"
else
    echo "❌ 未找到 APK 产物"
    exit 1
fi
