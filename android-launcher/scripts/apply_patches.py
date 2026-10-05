#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 termux-app 源码改造成「Rincy 启动器」。

用法:
    python3 apply_patches.py /path/to/termux-app

可用环境变量:
    RINCY_TERMUX_DIR      termux-app 源码目录（默认取第一个参数）
    RINCY_BOOTSTRAP_ZIP   自定义 bootstrap zip（默认 ./bootstrap-aarch64-repacked.zip）
    RINCY_LIBTERMUX_SO    预编译 libtermux.so（默认 ./libtermux.so）

改动清单（与 README 一一对应）:
  1. app/build.gradle           包名/应用名、关闭 native 编译与 bootstrap 自动下载
  2. TermuxConstants.java       TERMUX_PACKAGE_NAME / TERMUX_APP_NAME
  3. app strings.xml            应用名 ENTITY
  4. AndroidManifest.xml        新增 RincyWebActivity
  5. RincyWebActivity.java      以 WebView 承载 Rincy 界面（127.0.0.1:4780）
  6. TermuxInstaller.java       bootstrap 改从 assets 读取（不再依赖 NDK/native blob）
  7. terminal-emulator         去掉 NDK 编译，改用预编译 libtermux.so（jniLibs）
  8. 放置 bootstrap zip 与 libtermux.so
"""
import os
import shutil
import sys

TERMUX_DIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RINCY_TERMUX_DIR", "./termux-app")
BOOTSTRAP_ZIP = os.environ.get("RINCY_BOOTSTRAP_ZIP", "./bootstrap-aarch64-repacked.zip")
LIBTERMUX_SO = os.environ.get("RINCY_LIBTERMUX_SO", "./libtermux.so")

PKG_NAME = "com.rincy.launcher"
APP_NAME = "Rincy"

log = []


def read(rel):
    with open(os.path.join(TERMUX_DIR, rel), encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    with open(os.path.join(TERMUX_DIR, rel), "w", encoding="utf-8") as f:
        f.write(text)
    log.append(rel)


def patch(rel, pairs, required=False):
    """按顺序做字面替换；required=True 时未命中即报错（防止上游变更导致静默失效）。"""
    text = read(rel)
    for old, new in pairs:
        if old not in text:
            if required:
                raise SystemExit("[FAIL] %s 未找到待替换片段: %r" % (rel, old[:80]))
            continue
        text = text.replace(old, new)
    write(rel, text)


# ---------------------------------------------------------------- 1. app/build.gradle
patch("app/build.gradle", [
    ('applicationId "com.termux"', 'applicationId "%s"' % PKG_NAME),
    ('TERMUX_PACKAGE_NAME = "com.termux"', 'TERMUX_PACKAGE_NAME = "%s"' % PKG_NAME),
    ('TERMUX_APP_NAME = "Termux"', 'TERMUX_APP_NAME = "%s"' % APP_NAME),
    ('TERMUX_API_APP_NAME = "Termux:API"', 'TERMUX_API_APP_NAME = "%s:API"' % APP_NAME),
    ('TERMUX_BOOT_APP_NAME = "Termux:Boot"', 'TERMUX_BOOT_APP_NAME = "%s:Boot"' % APP_NAME),
    ('TERMUX_FLOAT_APP_NAME = "Termux:Float"', 'TERMUX_FLOAT_APP_NAME = "%s:Float"' % APP_NAME),
    ('TERMUX_STYLING_APP_NAME = "Termux:Styling"', 'TERMUX_STYLING_APP_NAME = "%s:Styling"' % APP_NAME),
    ('TERMUX_TASKER_APP_NAME = "Termux:Tasker"', 'TERMUX_TASKER_APP_NAME = "%s:Tasker"' % APP_NAME),
    ('TERMUX_WIDGET_APP_NAME = "Termux:Widget"', 'TERMUX_WIDGET_APP_NAME = "%s:Widget"' % APP_NAME),
    # 不再用 ndkBuild 把 bootstrap 编进 .so；改为 assets
    ('''        externalNativeBuild {
            ndkBuild {
                cFlags "-std=c11", "-Wall", "-Wextra", "-Werror", "-Os", "-fno-stack-protector", "-Wl,--gc-sections"
            }
        }
''', ''),
    ('''    externalNativeBuild {
        ndkBuild {
            path "src/main/cpp/Android.mk"
        }
    }
''', ''),
    ('    ndkVersion = System.getenv("JITPACK_NDK_VERSION") ?: project.properties.ndkVersion\n', ''),
    # 自带 123MB bootstrap zip，避免 aapt2 二次压缩拖慢打包
    ('    buildTypes {', '''    aaptOptions {
        noCompress "zip"
    }

    buildTypes {'''),
    # 不再联网下载官方 bootstrap（会覆盖自定义包）
    ('''afterEvaluate {
    android.applicationVariants.all { variant ->
        variant.javaCompileProvider.get().dependsOn(downloadBootstraps)
    }
}''', '''afterEvaluate {
    /* Rincy: 使用自定义 bootstrap，禁用官方下载 */
}'''),
    ('        downloadBootstrap("aarch64", "c8d702b6f742935001c37cda81b8ac69504a95d5cf28f2899532dd8cd4b057eb", version)\n',
     '        /* Rincy: aarch64 使用自定义 bootstrap */\n'),
])

# ------------------------------------------------- 2. TermuxConstants
patch("termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java", [
    ('public static final String TERMUX_APP_NAME = "Termux";',
     'public static final String TERMUX_APP_NAME = "%s";' % APP_NAME),
    ('public static final String TERMUX_PACKAGE_NAME = "com.termux";',
     'public static final String TERMUX_PACKAGE_NAME = "%s";' % PKG_NAME),
])

# ------------------------------------------------- 3. strings.xml
patch("app/src/main/res/values/strings.xml", [
    ('<!ENTITY TERMUX_APP_NAME "Termux">', '<!ENTITY TERMUX_APP_NAME "%s">' % APP_NAME),
])

# ------------------------------------------------- 4. Manifest：新增 WebView 活动
manifest = read("app/src/main/AndroidManifest.xml")
if "RincyWebActivity" not in manifest:
    anchor = '''            <activity
            android:name=".shared.activities.ReportActivity"'''
    if anchor not in manifest:
        raise SystemExit("[FAIL] AndroidManifest 中未找到插入锚点（上游可能已变更）")
    manifest = manifest.replace(anchor, '''            <activity
                android:name=".app.RincyWebActivity"
                android:label="%s 启动器"
                android:exported="false" />
''' % APP_NAME + anchor)
    write("app/src/main/AndroidManifest.xml", manifest)

# ------------------------------------------------- 5. RincyWebActivity.java
web_activity = os.path.join(TERMUX_DIR, "app/src/main/java/com/termux/app/RincyWebActivity.java")
if not os.path.exists(web_activity):
    os.makedirs(os.path.dirname(web_activity), exist_ok=True)
    with open(web_activity, "w", encoding="utf-8") as f:
        f.write('''package com.termux.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** 以 WebView 打开本机 Rincy 服务（默认端口 4780）。 */
public class RincyWebActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = new WebView(this);
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("http://127.0.0.1:4780");
        setContentView(webView);
    }
}
''')
    log.append("app/src/main/java/com/termux/app/RincyWebActivity.java")

# ------------------------------------------------- 6. TermuxInstaller：改读 assets
installer = "app/src/main/java/com/termux/app/TermuxInstaller.java"
text = read(installer)
text = text.replace("final byte[] zipBytes = loadZipBytes();", "final byte[] zipBytes = loadZipBytes(activity);")
old_loader = '''    public static byte[] loadZipBytes() {
        // Only load the shared library when necessary to save memory usage.
        System.loadLibrary("termux-bootstrap");
        return getZip();
    }

    public static native byte[] getZip();'''
new_loader = '''    public static byte[] loadZipBytes(Context context) throws IOException {
        // Rincy: 从 assets 读取 bootstrap，避免依赖 NDK 编译出的 native blob
        try (InputStream in = context.getAssets().open("bootstrap-aarch64.zip")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }'''
if old_loader in text:
    text = text.replace(old_loader, new_loader)
elif "loadZipBytes(Context context)" not in text:
    raise SystemExit("[FAIL] TermuxInstaller 的 loadZipBytes 结构已变化")
if "import java.io.IOException;" not in text:
    text = text.replace("import java.io.InputStreamReader;",
                        "import java.io.IOException;\nimport java.io.InputStream;\nimport java.io.InputStreamReader;")
if "import java.io.ByteArrayOutputStream;" not in text:
    text = text.replace("import java.io.ByteArrayInputStream;",
                        "import java.io.ByteArrayInputStream;\nimport java.io.ByteArrayOutputStream;")
write(installer, text)

# ------------------------------------------------- 7. terminal-emulator：去 NDK，用预编译 .so
patch("terminal-emulator/build.gradle", [
    ('''        externalNativeBuild {
            ndkBuild {
                cFlags "-std=c11", "-Wall", "-Wextra", "-Werror", "-Os", "-fno-stack-protector", "-Wl,--gc-sections"
            }
        }

''', ''),
    ("""ndk {
            abiFilters 'x86', 'x86_64', 'armeabi-v7a', 'arm64-v8a'
        }""", """ndk {
            abiFilters 'arm64-v8a'
        }"""),
    ('''    externalNativeBuild {
        ndkBuild {
            path "src/main/jni/Android.mk"
        }
    }

''', ''),
    ('    ndkVersion = System.getenv("JITPACK_NDK_VERSION") ?: project.properties.ndkVersion\n', ''),
])

# ------------------------------------------------- 8. 放置产物：bootstrap + libtermux.so
assets_dir = os.path.join(TERMUX_DIR, "app/src/main/assets")
os.makedirs(assets_dir, exist_ok=True)
shutil.copy(BOOTSTRAP_ZIP, os.path.join(assets_dir, "bootstrap-aarch64.zip"))
log.append("app/src/main/assets/bootstrap-aarch64.zip")

jni_dir = os.path.join(TERMUX_DIR, "terminal-emulator/src/main/jniLibs/arm64-v8a")
os.makedirs(jni_dir, exist_ok=True)
shutil.copy(LIBTERMUX_SO, os.path.join(jni_dir, "libtermux.so"))
log.append("terminal-emulator/src/main/jniLibs/arm64-v8a/libtermux.so")

print("已修改 %d 处：" % len(log))
for item in log:
    print("  -", item)
print("\n完成。包名=%s 应用名=%s" % (PKG_NAME, APP_NAME))
