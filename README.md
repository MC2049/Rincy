# Rincy

**Rin Is Not Code Yet** — 面向非专业用户的 AI 智能体运行器。用户不需要懂代码，就能创建和使用自己的 AI 智能体。

Rin AI 家族的第一款产品。架构思路参考 [OpenClaw](https://github.com/openclaw/openclaw)（MIT），Node.js 从零重写，零第三方依赖。

## 怎么运行

需要 Node.js 18+（用了内置 fetch）。零第三方依赖，不用 npm install。

```sh
./scripts/start.sh        # Linux / macOS / Android Termux
scripts\start.bat         # Windows
```

启动后浏览器打开 http://127.0.0.1:3000

## 怎么用（防劝退三步）

1. **创建智能体**：输入名字和一段描述（比如"一个外冷内热的吸血鬼伯爵"）——后台自动生成人设和行为规则文件，用户不用管。
2. **设置模型**：选"云端模型"（填 API 密钥）或"本地模型"（Ollama），就这两项。
3. **聊天**：像聊天软件一样，回复是流式的（一个字一个字往外蹦）。

## 调试屏（说人话，不露技术词）

调试屏按分组展示，每个滑块一一对应一个后端真实参数，滑块右边有编辑框（双向绑定）。

| 分组 | 界面 | 左端 | 右端 | 背后参数 |
| --- | --- | --- | --- | --- |
| 基础 | 语气 | 严谨原著 | 自由发挥 | temperature |
| 基础 | 回答长度 | 简短 | 详细 | max_tokens（maxReplyTokens） |
| 风格 | 用词范围 | 常用词 | 广泛用词 | top_p |
| 风格 | 重复倾向 | 允许重复 | 避免重复 | frequency_penalty |
| 风格 | 口头禅 | 输入框 + 添加 | — | 写进 SOUL.md 的文本规则 |
| 记忆 | 保留多少轮完整对话 | 1 | 50 | context_recent_count |
| 记忆 | 开启孟婆系统 | 开关 | — | memory_warden.enabled |
| 记忆 | 遗忘速度 | 下拉 | — | memory_warden.speed（孟婆开启时显示） |
| 行为 | 表情使用 | 不用/偶尔/频繁 | — | AGENTS.md 的 emoji_policy |
| 行为 | 主动提问 | 不主动/偶尔/频繁 | — | AGENTS.md 的 proactive_question |
| 行为 | 回答格式 | 纯文本/允许列表/允许 Markdown | — | AGENTS.md 的 format_policy |
| 行为 | 保持人设 | 松 | 严 | AGENTS.md 的 ooc_strength（0-100） |
| 权限 | 允许智能体修改自己的人设 | 开关 | — | soul.self_edit |
| 权限 | 允许查看历史存档 | 开关 | — | history.visible |
| 系统 | 模型来源 | 云端/本地 | — | provider |
| 系统 | 模型名称 | 下拉或输入框 | — | model_name |

改动实时生效（下一条消息就用新参数，不需要点保存）。参数名只出现在后台代码和 system prompt 里，UI 永远显示人话标签。不设快捷按钮（没法映射到参数的不做）。

## 孟婆系统（memory warden，记忆管理，可开关）

- **每次请求只上传 memory.md**（分层记忆），不上传完整对话记录——省上下文，防人设崩坏。
- **孟婆关闭时**：像普通聊天一样发完整对话记录，memory.md 也一起发。
- memory.md 分层：近期记忆（完整带时间戳，条数 = context_recent_count）/ 中期记忆（压缩摘要，条数 = 近期 × 遗忘速度倍数）/ 远期记忆（要点关键词）。
- 遗忘速度四档：不遗忘（全部完整保留）/ 较慢（中期层 3 倍）/ 标准（2 倍）/ 较快（1 倍）。
- **完整聊天记录始终保留在本地**（`data/agents/<id>/history/`），聊天框显示的记录就是从这儿来的；界面有"查看历史存档"入口（受 history.visible 开关控制）。

## 配置文件格式

SOUL.md / AGENTS.md / IDENTITY.md 沿用 OpenClaw 的工作区模板格式（`#` 标题 + `##` 分段 + `- **Label:** value` 字段行）；memory.md 是 Rincy 原创（孟婆系统），格式自定。

## 项目结构

```
src/
  server.js         入口：静态文件 + 创建智能体 + 聊天（流式）
  model-adapter.js  统一 OpenAI / Ollama 调用（流式默认开）
  memory.js         孟婆系统：完整存档 + 分层 memory.md
  config.js         参数表 + SOUL.md / AGENTS.md / IDENTITY.md 生成
web/                前端（原生 HTML/CSS/JS，零依赖）
data/               用户数据（智能体、记忆、设置）
scripts/            启动和构建脚本
DESIGN_NOTES.md     OpenClaw 架构分析
```

## 当前状态（骨架版）

- ✅ 创建智能体 → 发消息 → 流式回复（核心链路）
- ✅ 滑块 + 编辑框双向绑定（一一对应参数）
- ✅ 孟婆系统：分层记忆、遗忘速度四档、可开关、清空记录不删人设、查看历史存档
- ⬜ 中期摘要接模型（当前骨架版是截短占位）
- ✅ 口头禅（写进 SOUL.md）
- ⬜ 快捷设定按钮——已决定不做（没法映射到参数）
- ⬜ 中英双语 + "使用中文术语"开关
- ⬜ 高级模式（查看/编辑 SOUL.md、AGENTS.md）
