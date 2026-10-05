# Rincy

**用你最顺手的方式，创建属于你的智能体。**

Rincy 是 Rin AI 家族的第一款产品。

开源、本地运行、面向所有人。

不是 SaaS。数据在你自己的设备上。

---

## Rin 这个名字

Rin comes from ~~the author's crush~~ a common name of girl.

And Rin is not.

---

## Rincy 是什么

- 一个**本地运行**的智能体运行器。打开浏览器就能用。

- 支持 **OpenAI 兼容接口**和 **Ollama**，一套逻辑跑通两边。

- 所有数据存在你硬盘上的 Markdown 文件里，没有数据库，没有云端。

- 配置文件（人设、行为规则、记忆）沿用 OpenClaw 的格式，有实战验证。

- 界面平实，没有术语。滑块、按钮、输入框，普通人一看就懂。

## Rincy 不是什么

- 不是 SaaS。没有账号、没有注册、没有实名。

- 不是内容服务。不生产、不分发、不托管任何对话内容。

- 不是平台。没有人能远程关停你的智能体。

---

## 核心特性

### 三屏布局

菜单 / 对话 / 调试，三屏都能折叠。对话永远是主屏。

### 孟婆系统（可选，默认关闭）

记忆分层管理。近期记忆带完整时间戳，中期压成摘要，远期模糊成要点。

每次请求只发 `memory.md`，不发完整对话记录。省上下文，防人设崩坏。

### 双接口支持

一个 `model-adapter.js` 同时适配 OpenAI Chat Completion 和 Ollama。

在设置里选“云端”或“本地”，不用改任何代码。

### 配置文件沿用 OpenClaw 格式

- `SOUL.md` — 人设

- `AGENTS.md` — 行为规则（canonical 主文件）

- `IDENTITY.md` — 身份卡

- `memory.md` — 分层记忆

所有文件都是纯文本。随时可以用编辑器打开看。

### 平实 UI

界面只有滑块、按钮、输入框。没有术语。

参数名（temperature、top_p、frequency_penalty）只出现在后台，UI 上永远只显示“语气”“用词范围”“重复倾向”。

---

## 快速开始

### 你需要什么

- Node.js 18 或更高版本

- 一个模型来源：OpenAI 兼容 API 的密钥，或者本地运行的 Ollama

### 启动

```bash

git clone https://github.com/MC2049/Rincy.git

cd Rincy

node src/server.js

```

> 首次运行时如果提示缺少依赖，`start.sh` 会自动安装（需要联网，安装后可离线使用）。

然后在浏览器打开 `http://127.0.0.1:3000`。

如果你想用自定义端口：

```bash

RINCY_PORT=3080 node src/server.js

```

---

## 支持的模型提供商

在“设置 → 添加模型”里可以配置。所有提供商都走 OpenAI 兼容格式。

| 提供商 | 接口地址 | 备注 |
| :--- | :--- | :--- |
| **OpenRouter** | `https://openrouter.ai/api/v1` | 一个 Key 通多家模型，有免费额度 |
| **NVIDIA NIM** | `https://integrate.api.nvidia.com/v1` | 免费额度充足，需申请权限 |
| **阿里云百炼（千问）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 新用户 100 万 Tokens 免费额度 |
| **智谱 AI（Z.ai）** | `https://open.bigmodel.cn/api/paas/v4` | GLM-4.7-Flash 免费 |
| **Ollama（本地）** | `http://127.0.0.1:11434` | 完全本地，不需要联网 |

也支持手动填入任何 OpenAI 兼容的接口地址。

---

## 项目结构

```

Rincy/

├── src/

│ ├── server.js # 入口。静态文件 + 创建智能体 + 聊天

│ ├── model-adapter.js # 统一 OpenAI / Ollama 调用

│ ├── memory.js # 孟婆系统读写

│ └── config.js # 读写 SOUL.md / AGENTS.md / IDENTITY.md

├── web/

│ ├── index.html

│ ├── style.css

│ └── app.js

├── data/ # 用户数据（智能体、记忆）

├── scripts/

│ ├── start.sh

│ └── start.bat

├── DESIGN_NOTES.md # 架构设计笔记

├── README.md

└── LICENSE

```

---

## 数据存在哪里

所有数据都在 `data/` 目录下：

```

data/agents/<智能体ID>/

├── SOUL.md # 人设

├── AGENTS.md # 行为规则

├── IDENTITY.md # 身份卡

├── memory.md # 分层记忆（只发这个给 API）

└── history/

└── chat.md # 完整本地存档（永不发 API）

```

你可以随时打开这些文件看，备份，复制，迁移。

---

## Android 版计划

有 APK 计划，但**暂不发布**。

优先走两条路：

1. **源码 + 构建脚本**：用户在 Termux 里自己编译、自己签名、自己装

2. **Termux 脚本**：用户在 Termux 里装 Node，直接跑 Rincy

**不注册 Google 开发者，不提交任何身份信息。**

坚定支持 [Keep Android Open](https://keepandroidopen.org/) 运动。

~~等 F-Droid 那边的情况明朗了，再评估是否正式发布 APK。~~

安卓nodejs有点难，先不做，上面那句话请忽略，AI瞎说的

---

## 立场

本项目为**开源软件**，非 SaaS。

- 不申请任何备案。

- 坚定支持 Keep Android Open 运动。

- 反对“**谷修**”（Google Revisionists）式的平台修正主义——即以“修正”为名，行收紧用户自由之实的平台行为。

- 不会主动配合任何所谓未成年人保护政策。除非 API 端要求——那也是 API 的事，与本软件无关。

- 坚决反对以安全为名的互联网过度实名化。

- 不会主动要求收集实名信息。如果你遇到了，很有可能是盗版或病毒。

- 如果这样做意味着违规，我们会更换平台。

### 责任边界

Rincy 是本地运行的软件工具，不是内容服务。

它本身不生产、不分发、不托管任何内容。所有对话内容由用户输入，经用户自己配置的 API 处理后返回。

如果发生非法内容，那是 API 端的事，由 API 提供方依据其所在地法律和平台政策处理。Rincy 不介入、不替代、不越权。

Rincy 只对自己 UI 层的内容负责：不预置违法角色、不内置违法提示词、不引导违法用途。

---

## 许可证

MIT License

部分代码改编自 [OpenClaw](https://github.com/openclaw/openclaw)（MIT License，Copyright (c) 2026 OpenClaw Foundation）。相关文件顶部保留原始版权声明。

---

*Rin Is Not Code Yet. 你不需要懂代码，就能拥有自己的智能体。*

