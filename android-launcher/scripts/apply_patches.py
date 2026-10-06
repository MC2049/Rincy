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
  4. AndroidManifest.xml        启动器身份交给 RincyMainActivity、允许回环明文
  5. app-files/**               启动器界面：底部任务栏（对话/设置）+ 大 WebView
  6. TermuxInstaller.java       bootstrap 改从 assets 读取（不再依赖 NDK/native blob）
  7. terminal-emulator         去掉 NDK 编译，改用预编译 libtermux.so（jniLibs）
  8. 放置 bootstrap zip 与 libtermux.so
"""
import os
import re
import shutil
import sys

TERMUX_DIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RINCY_TERMUX_DIR", "./termux-app")
BOOTSTRAP_ZIP = os.environ.get("RINCY_BOOTSTRAP_ZIP", "./bootstrap-aarch64-repacked.zip")
LIBTERMUX_SO = os.environ.get("RINCY_LIBTERMUX_SO", "./libtermux.so")

PKG_NAME = "com.rincy.launcher"
APP_NAME = "Rincy"
APP_VERSION = "0.2.3"

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
    # 用启动器自己的版本号（便于覆盖安装）
    ('        versionCode 1002\n        versionName "0.118.3"',
     '        versionCode 2003\n        versionName "%s"' % APP_VERSION),
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
    ('<string name="bootstrap_installer_body">Installing bootstrap packages…</string>',
     '<string name="bootstrap_installer_body">正在部署 %s 运行环境…</string>' % APP_NAME),
])

# ------------------------------------------------- 4. Manifest：启动器身份 + 回环明文
manifest = read("app/src/main/AndroidManifest.xml")

# 清掉历史版本插入的单页 WebView 活动
manifest = re.sub(r'\n\s*<activity\s+android:name="\.app\.RincyWebActivity".*?/>', '', manifest, flags=re.S)

# WebView 访问 127.0.0.1 属于明文流量，targetSdk 28 起默认被禁
if "android:usesCleartextTraffic" not in manifest:
    app_anchor = '''        android:supportsRtl="false"
        android:theme="@style/Theme.Termux">'''
    if app_anchor not in manifest:
        raise SystemExit("[FAIL] AndroidManifest 中未找到 application 标签锚点")
    manifest = manifest.replace(
        app_anchor,
        app_anchor[:-1] + '\n        android:usesCleartextTraffic="true">')

# WebView 导入/导出需要把文件写进公共「下载」目录，API 29 需要保留旧版存储模型
if "android:requestLegacyExternalStorage" not in manifest:
    legacy_anchor = '        android:label="@string/application_name"\n'
    if legacy_anchor not in manifest:
        raise SystemExit("[FAIL] AndroidManifest 中未找到 label 锚点")
    manifest = manifest.replace(
        legacy_anchor,
        legacy_anchor + '        android:requestLegacyExternalStorage="true"\n',
        1)

# 启动器身份交给 RincyMainActivity；TermuxActivity 退回普通活动，仅开发模式按需打开
launcher_filters = '''            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>

'''
if launcher_filters in manifest:
    manifest = manifest.replace(launcher_filters, '')

termux_activity_anchor = '''        <activity
            android:name=".app.TermuxActivity"'''
if termux_activity_anchor not in manifest:
    raise SystemExit("[FAIL] AndroidManifest 中未找到 TermuxActivity 声明")
if ".app.RincyMainActivity" not in manifest:
    main_activity = '''        <activity
            android:name=".app.RincyMainActivity"
            android:configChanges="orientation|screenSize|smallestScreenSize|density|screenLayout|uiMode|keyboard|keyboardHidden|navigation"
            android:exported="true"
            android:label="@string/application_name"
            android:launchMode="singleTask"
            android:theme="@style/RincyTheme">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>

'''
    manifest = manifest.replace(termux_activity_anchor, main_activity + termux_activity_anchor)
write("app/src/main/AndroidManifest.xml", manifest)

# ------------------------------------------------- 5. 启动器界面：app-files/ 覆盖进源码树
app_files = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app-files")
if not os.path.isdir(app_files):
    raise SystemExit("[FAIL] 未找到启动器界面源码目录 app-files/")
copied = 0
for root, _dirs, files in os.walk(app_files):
    for name in files:
        src = os.path.join(root, name)
        rel = os.path.relpath(src, app_files)
        dst = os.path.join(TERMUX_DIR, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        log.append(rel)
        copied += 1
if not copied:
    raise SystemExit("[FAIL] app-files/ 是空的")
# 旧的单页 WebView 活动已被 RincyMainActivity 取代
stale = os.path.join(TERMUX_DIR, "app/src/main/java/com/termux/app/RincyWebActivity.java")
if os.path.exists(stale):
    os.remove(stale)
    log.append("删除 app/src/main/java/com/termux/app/RincyWebActivity.java")

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
# 安装器只给 bin/、libexec 等 chmod 0700，随包的 home/rincy-boot.sh 也需要可执行位
old_chmod = ('                                    if (zipEntryName.startsWith("bin/") || zipEntryName.startsWith("libexec") ||\n')
new_chmod = ('                                    if (zipEntryName.startsWith("bin/") || zipEntryName.startsWith("home/") || zipEntryName.startsWith("libexec") ||\n')
if old_chmod in text:
    text = text.replace(old_chmod, new_chmod)
write(installer, text)

# ------------------------------- 6b. TermuxShellUtils：补齐 LD_LIBRARY_PATH 与 OPENSSL_CONF
shell_utils = "termux-shared/src/main/java/com/termux/shared/shell/TermuxShellUtils.java"
text = read(shell_utils)
if "LD_LIBRARY_PATH=" not in text:
    tmpdir_line = '            environment.add("TMPDIR=" + TermuxConstants.TERMUX_TMP_PREFIX_DIR_PATH);\n'
    if tmpdir_line not in text:
        raise SystemExit("[FAIL] TermuxShellUtils 的环境注入锚点已变化")
    text = text.replace(tmpdir_line, tmpdir_line + '''            // Rincy: Termux 二进制的 DT_RUNPATH 里写死了 /data/data/com.termux/files/usr/lib，
            // 改了包名就解析不到；设备上若装了官方 Termux，那个路径还会因跨应用访问被拒。
            // 必须显式给出库路径（LD_LIBRARY_PATH 优先级高于 DT_RUNPATH），
            // 否则 bash / dpkg / pkg / node 等一律报 "library ... not found"。
            environment.add("LD_LIBRARY_PATH=" + TermuxConstants.TERMUX_LIB_PREFIX_DIR_PATH);
            // openssl 库里编译进的 OPENSSLDIR 同样指向旧包名，指到自带的那份配置。
            {
                String rincyOpensslConf = TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/etc/tls/openssl.cnf";
                if (!new java.io.File(rincyOpensslConf).exists())
                    rincyOpensslConf = TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/etc/ssl/openssl.cnf";
                if (new java.io.File(rincyOpensslConf).exists())
                    environment.add("OPENSSL_CONF=" + rincyOpensslConf);
            }
''')
    write(shell_utils, text)

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
