# 发布规则（Rincy 本体 + 启动器）

> 本体（payload，本仓库）与启动器（Termux fork，独立源码树）**版本各自独立**，发布互不捆绑。

## 版本号 x.y.z

- **x++** 革命性更新
- **y++** 中等更新（功能级）
- **z++** 小修小补（修复、措辞）

## 发什么（核心：只发变了的那个）

| 改动 | 发布物 |
|---|---|
| 只更新本体 | **只发** `rincy-payload-x.y.z.zip`（不重发任何 APK） |
| 只更新启动器 | **只发** APK（full；lite 变体若也变了则一并发）——不重发 payload zip |
| 两者都更新 | 各发各的：payload zip + APK |

## 禁止事项

- ❌ 启动器更新时把没变的 payload zip 再传一遍
- ❌ 本体更新时重发没变的 APK（lite/full 内嵌载荷随启动器自己的版本走）
- ❌ 已发布 release 不原地改资产；换二进制时**删除重发**（新 patch 版）

## lite 变体备注

- 包名 `com.rincy.launcher.lite`，libnode（nodejs-mobile v18.20.4）进程内嵌入，无 bootstrap
- 数据目录按包名隔离，与 full 可并存
- 载荷兼容性以 Node 18 为底线验证
