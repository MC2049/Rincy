# Rincy 启动器（Android）

把 Rincy 做成**自带运行环境**的 Android 启动器：安装后首次打开即自动部署，无需用户进 Termux 手工操作。

- 包名 `com.rincy.launcher`（与官方 Termux 的 `com.termux` 隔离，不覆盖你已装的 Termux）
- 应用名 `Rincy`
- 单 ABI `arm64-v8a`
- `targetSdkVersion 28`（Android 10/SDK 29 起，应用私有目录内的可执行文件才允许运行——Node 与 bootstrap 里的二进制都在私有目录）
- APK 体积约 130MB，其中 ~123MB 是内置的 bootstrap（Termux rootfs + Node 运行时 + Rincy 源码）

## 它是怎么工作的

```
APK
├── assets/bootstrap-aarch64.zip     ← 首次启动解包到私有目录
│     ├── (Termux bootstrap 原有内容，前缀已改写为 com.rincy.launcher)
│     ├── home/node-runtime.tar.gz   ← Node 24 运行时（含 npm/corepack）
│     ├── home/rincy/                ← Rincy 源码（含 node_modules: busboy + tar）
│     ├── home/rincy-boot.sh         ← 启动脚本
│     └── etc/profile.d/99-rincy.sh  ← 会话启动时自动拉起 Rincy
└── lib/arm64-v8a/libtermux.so       ← 终端 JNI（预编译，见下文“aarch64 宿主构建”）
```

首次打开：

1. `TermuxInstaller` 把 `assets/bootstrap-aarch64.zip` 解包到
   `/data/data/com.rincy.launcher/files/usr`
2. 打开终端会话时执行 `etc/profile.d/99-rincy.sh` → `home/rincy-boot.sh`
3. 启动脚本解包 `node-runtime.tar.gz`（若未解过），然后
   `RINCY_PORT=4780 nohup node src/server.js`，日志写到 `~/rincy-boot.log`
4. `RincyWebActivity`（WebView）打开 `http://127.0.0.1:4780`

> 想直接看界面：Termux 会话起来后按返回，或从启动器里打开 `RincyWebActivity`。

## 为什么 bootstrap 走 assets，而不是官方那种 native blob

上游 Termux 用 `app/src/main/cpp/termux-bootstrap-zip.S` 的 `.incbin` 把 zip 编进
`libtermux-bootstrap.so`，这要求能跑 NDK 工具链。本仓库同时提供了
**aarch64 宿主机（如 ARM 服务器 / 手机上用 proot）** 的构建方式，那里跑不了 Google 的
x86_64 NDK 与 aapt2，因此改成：

- `TermuxInstaller.loadZipBytes(Context)` 直接从 `assets/bootstrap-aarch64.zip` 读字节
- 去掉 `app` 与 `terminal-emulator` 两处 `externalNativeBuild`
- `terminal-emulator` 需要的 `libtermux.so` 用**官方同版本 APK 里的预编译库**（`jniLibs`）

这样整条构建链不需要 NDK，只需要 JDK 11 + Android SDK（platform-30 / build-tools 30.0.3）
\+ Gradle 7.2。

## 构建步骤

### 0. 准备目录

```bash
android-launcher/
├── scripts/apply_patches.py     # 源码补丁
├── scripts/build-apk.sh         # 一键构建
├── scripts/repack_bootstrap.py  # 生成自定义 bootstrap
├── termux-app/                  # termux-app v0.118.3 源码（git clone）
├── bootstrap-aarch64-repacked.zip
└── libtermux.so
```

### 1. 取 termux-app 源码与预编译 libtermux.so

```bash
git clone --branch v0.118.3 --depth 1 https://github.com/termux/termux-app.git termux-app

# libtermux.so：从官方 arm64 APK 里取（版本必须与源码一致）
curl -LO https://github.com/termux/termux-app/releases/download/v0.118.3/\
termux-app_v0.118.3+github-debug_arm64-v8a.apk
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('termux-app_v0.118.3+github-debug_arm64-v8a.apk')
open('libtermux.so','wb').write(z.read('lib/arm64-v8a/libtermux.so'))
PY
```

### 2. 生成自定义 bootstrap

需要先备好（脚本会从 Termux 仓库解析依赖闭包）：

- `vendor/bootstrap-aarch64.zip` —— 官方 bootstrap（v0.118.3 对应
  `bootstrap-aarch64.zip`，见 termux-app 的 `app/build.gradle` 里 `downloadBootstraps` 的 URL 与 SHA256）
- `vendor/node-deb/*.deb` —— Node 运行时及其依赖（`nodejs-lts`、`libc++`、`openssl`、
  `c-ares`、`libicu`、`libsqlite`、`zlib`、`ca-certificates`、`resolv-conf`，来自
  <https://packages.termux.dev/apt/termux-main/>）

```bash
cd android-launcher
RINCY_SRC_ZIP=./vendor/bootstrap-aarch64.zip \
RINCY_DEB_DIR=./vendor/node-deb \
RINCY_SOURCE_DIR=/path/to/Rincy \
python3 scripts/repack_bootstrap.py ./bootstrap-aarch64-repacked.zip
```

脚本做的事：

1. 遍历官方 bootstrap 的所有条目，把文本里的
   `/data/data/com.termux/files` 改写成 `/data/data/com.rincy.launcher/files`
   （Node 二进制无硬编码前缀，已核实；少数 `.so` 里残留短前缀只影响 apt/termux-exec，本启动器不使用 apt）
2. 把 9 个 deb 里的 `usr/` 内容打成 `home/node-runtime.tar.gz`
   （保留权限/软链，交给 Termux 自带 `tar` 解包，避开 dpkg 前缀不匹配）
3. 把 Rincy 源码（含 `node_modules`）放进 `home/rincy/`
4. 写入 `home/rincy-boot.sh` 与 `etc/profile.d/99-rincy.sh`

### 3. 构建

```bash
cd android-launcher
RINCY_TERMUX_DIR=./termux-app \
RINCY_BOOTSTRAP_ZIP=./bootstrap-aarch64-repacked.zip \
RINCY_LIBTERMUX_SO=./libtermux.so \
JAVA_HOME=/opt/jdk/jdk-11.0.32.1+1 \
ANDROID_HOME=/opt/android-sdk \
RINCY_GRADLE_ZIP=/path/to/gradle-7.2-all.zip \
./scripts/build-apk.sh
```

产物：`termux-app/app/build/outputs/apk/debug/*.apk`

**两个环境相关的坑（脚本已自动处理）：**

| 问题 | 处理 |
| --- | --- |
| Gradle wrapper 联网下载超时 | 传 `RINCY_GRADLE_ZIP`，脚本把 `distributionUrl` 改成 `file:` |
| aarch64 宿主：AGP 自带 aapt2 是 x86_64，直接执行 `Illegal instruction` | 脚本用 `qemu-x86_64-static` 包装成 wrapper，并写入 `android.aapt2FromMavenOverride` |

（`terminal-emulator` 原本也要 NDK 编译 `libtermux.so`，已改为使用预编译库，见上。）

### 4. 安装与首次启动

```bash
adb install -r termux-app/app/build/outputs/apk/debug/*.apk
```

设备端不需要 root。首次打开会解包（约 10–30 秒），之后 Rincy 监听 `127.0.0.1:4780`。

排查用：

```bash
# 设备内（Termux 会话或 adb shell）
cat /data/data/com.rincy.launcher/files/home/rincy-boot.log
```

## 与上游的差异（补丁清单）

见 `scripts/apply_patches.py`，全部为字面替换，包含：

1. `app/build.gradle`：`applicationId`/`manifestPlaceholders` 改名；移除 `externalNativeBuild`
   与 `ndkVersion`；加 `aaptOptions.noCompress "zip"`；禁用 `downloadBootstraps`
2. `TermuxConstants`：`TERMUX_PACKAGE_NAME`、`TERMUX_APP_NAME`
3. `app/src/main/res/values/strings.xml`：`<!ENTITY TERMUX_APP_NAME>`
4. `AndroidManifest.xml`：注册 `RincyWebActivity`
5. 新增 `RincyWebActivity.java`
6. `TermuxInstaller.java`：`loadZipBytes` 改为读 assets
7. `terminal-emulator/build.gradle`：去 NDK，`abiFilters` 只留 `arm64-v8a`
8. 放入 `assets/bootstrap-aarch64.zip` 与 `jniLibs/arm64-v8a/libtermux.so`

## 许可与署名

本启动器是 [termux-app](https://github.com/termux/termux-app)（GPLv3）的衍生作品，
同样以 GPLv3 发布；已按上游文档要求完成包名/应用名替换，未使用 Termux 商标。
内置组件：Termux bootstrap（GPLv3 等）、Node.js（MIT）、Rincy（本仓库）。
