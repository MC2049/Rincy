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
│     └── etc/profile.d/99-rincy.sh  ← 兜底：进 Termux 会话时自动拉起 Rincy
└── lib/arm64-v8a/libtermux.so       ← 终端 JNI（预编译，见下文“aarch64 宿主构建”）
```

> ⚠️ 目录约定：Termux 安装器把 zip 条目解到**前缀目录**下，而官方 bootstrap 顶层只有
> `bin/ etc/ lib/ ...`、没有 `home/`，所以上面这些 `home/*` 实际落在
> `files/usr/home/`。启动脚本与 Java 侧据此统一用 `$PREFIX/home` 定位载荷；
> 用户数据则放在真正的 `$HOME`（`files/home`）下。

首次打开：

1. `RincyMainActivity` 检查环境 → `TermuxInstaller` 把 `assets/bootstrap-aarch64.zip`
   解包到 `/data/data/com.rincy.launcher/files/usr`（中文进度提示）
2. 前台直接执行 `$PREFIX/home/rincy-boot.sh`：解包 `node-runtime.tar.gz`（若未解过），
   再用 `setsid node src/server.js` 把服务挂到独立会话（bootstrap 里没有 `nohup`）
3. 界面用 WebView 打开 `http://127.0.0.1:<端口>`（默认 4780）

界面结构（**打开应用不再进入 Termux 终端**）：

```
┌───────────────────────────────┐
│                               │
│   对话：Rincy 网页（WebView）  │
│                               │
├───────────────────────────────┤
│      💬 对话    ⚙️ 设置        │  ← 底部任务栏
└───────────────────────────────┘
```

- **对话**：全屏 WebView；服务未就绪时显示状态提示与「启动 / 重试」
- **设置**：启动 / 停止 / 重启、端口、玩家模式 / 开发模式、打开应用时自动启动
- **开发模式**额外提供：打开 Termux 终端、查看启动日志、重置运行环境，
  以及前缀 / 源码 / 数据 / 日志的实际路径

用户数据在 `$HOME/rincy-data`（`files/home/rincy-data`），与运行环境解耦，
「重置运行环境」不会丢智能体和设置。

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

## 为什么必须显式设置 LD_LIBRARY_PATH 和 OPENSSL_CONF

Termux 的二进制（`bash`、`dpkg`、`node`…）在编译时把 `DT_RUNPATH` 写成了**绝对路径**
`/data/data/com.termux/files/usr/lib`。包名改成 `com.rincy.launcher` 之后，这个 RUNPATH
指向的目录不存在；**如果设备上装了官方 Termux，那个目录还会「存在但不可读」**（跨应用私有目录
被拒），于是报：

```
CANNOT LINK EXECUTABLE ".../usr/bin/bash": library "libandroid-support.so" not found
CANNOT LINK EXECUTABLE "dpkg": library "libmd.so" not found
```

`LD_LIBRARY_PATH` 的搜索优先级高于 `DT_RUNPATH`，所以必须显式给出。补丁在这三处都设置了：

1. `termux-shared/.../TermuxShellUtils.setShellCommandShellEnvironment()` —— 终端会话与后台命令
   （同时补上 `OPENSSL_CONF`）
2. `RincyServer` 里启动脚本的 `ProcessBuilder` 环境（App 直接拉起服务时，父进程环境里没有这些）
3. `home/rincy-boot.sh` 与 `etc/profile.d/99-rincy.sh` 自身（脚本自给自足）

> ⚠️ Android 的 `linker64` **没有** `--library-path` 参数（用法只有 `linker64 program [args...]`，
> 传了会报 `error: expected absolute path: "--library-path"`），所以「用 linker64 包装每个二进制」
> 在 Android 10 上不可行；正确解法就是 `LD_LIBRARY_PATH`。

同理，openssl 库里编译进的 `OPENSSLDIR` 也指向 `com.termux`。用 `OPENSSL_CONF` 指到自带的
`$PREFIX/etc/tls/openssl.cnf`（Node 运行时里就带了这个文件，`etc/ssl` 作为备选）。否则在装有
官方 Termux 的设备上会报：

```
OpenSSL configuration error: Permission denied,
fopen(/data/data/com.termux/files/usr/etc/tls/openssl.cnf)
```

另外两点细节：

- 解包出来的文件**没有可执行位**（安装器只给 `bin/`、`libexec` 等 chmod 0700），
  所以 `apply_patches.py` 把 `home/` 也加进了 chmod 名单；profile 钩子同时用 `$PREFIX/bin/sh`
  显式解释启动脚本，不依赖可执行位。
- bootstrap 里**没有 `nohup`**（有 `setsid`），启动脚本用 `setsid` 把 node 挂到独立会话。

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
