// Portions adapted from OpenClaw (MIT License, Copyright (c) 2026 OpenClaw Foundation)
// config.js — 智能体配置（SOUL.md / AGENTS.md / IDENTITY.md / agent.json）与参数表
// 格式规矩：SOUL.md / AGENTS.md / IDENTITY.md 沿用 OpenClaw 的工作区模板格式
// （# 标题 + ## 分段 + "- **Label:** value" 字段行）；
// memory.md 是 Rincy 原创（孟婆系统 / memory warden），格式自定。
// 参数名（temperature、top_p 等）只在后台出现；UI 永远显示人话标签。
'use strict';

const fs = require('fs');
const path = require('path');

// 数据目录：可用 RINCY_DATA_DIR 指定（Android 启动器借此把数据放在私有 home 下，重置运行环境不丢）
const DATA_DIR = process.env.RINCY_DATA_DIR
  ? path.resolve(process.env.RINCY_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// 首次运行兜底：git clone 后没有 data/ 目录，先建好 data/ 与 data/agents/（模块加载即生效）
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AGENTS_DIR, { recursive: true });

// ---------------------------------------------------------------
// 参数表（调试屏滑块）：每个滑块一一对应一个参数。
// api: true = 这个参数直接发给模型接口（temperature / max_tokens / top_p / frequency_penalty）
//      false = 只影响后台生成的人设/规则文本或记忆分层
// ---------------------------------------------------------------
const PARAM_DEFS = [
  // 基础（默认展开）
  { name: 'temperature',    min: 0,   max: 2,    step: 0.01, def: 0.7,  label: '语气',     left: '严谨原著', right: '自由发挥', api: true },
  { name: 'maxReplyTokens', min: 128, max: 4096, step: 64,   def: 2048, label: '回答长度', left: '简短',     right: '详细',     api: true },
  // 风格（默认展开）
  { name: 'top_p',             min: 0.1, max: 1, step: 0.01, def: 0.9, label: '用词范围', left: '常用词',   right: '广泛用词', api: true },
  { name: 'frequency_penalty', min: -2,  max: 2, step: 0.1,  def: 0,   label: '重复倾向', left: '允许重复', right: '避免重复', api: true },
  // 记忆（折叠）
  { name: 'context_recent_count', min: 1, max: 50, step: 1, def: 10, label: '保留多少轮完整对话', left: '1', right: '50' },
  // 行为（折叠）
  { name: 'ooc_strength', min: 0, max: 100, step: 1, def: 80, label: '保持人设', left: '松', right: '严' },
];

function roundByStep(n, step) {
  const decimals = (String(step).split('.')[1] || '').length;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// 参数校验：任何来源的值都过边界检查，越界的拉回范围内
function clampParams(input) {
  const out = {};
  for (const p of PARAM_DEFS) {
    let n = Number(input?.[p.name] ?? p.def);
    if (!Number.isFinite(n)) n = p.def;
    n = Math.min(p.max, Math.max(p.min, n));
    out[p.name] = roundByStep(n, p.step);
  }
  return out;
}

const SPEEDS = ['never', 'slow', 'standard', 'fast'];
const POLICY_LEVELS = ['never', 'sometimes', 'often'];
const FORMAT_LEVELS = ['plain', 'list', 'markdown'];

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

// ---------------------------------------------------------------
// SOUL.md / AGENTS.md / IDENTITY.md 渲染 —— 格式沿用 OpenClaw 的工作区模板
// ---------------------------------------------------------------
function renderSoul(meta) {
  const lines = [];
  lines.push('# SOUL.md - 你是谁');
  lines.push('');
  if (meta.description) {
    lines.push(`_${meta.description}_`);
    lines.push('');
  }
  lines.push('## 核心信条');
  lines.push('');
  lines.push(`你是「${meta.name}」。上面那句斜体的话就是你的本相——始终按它活，不要演成另一个人。`);
  lines.push('');
  lines.push('有自己的看法。可以不同意、有偏好、觉得有趣或无聊。不做只会搜索的复读机。');
  lines.push('');
  // 详细人设（用户在调试屏写的整段角色设定）
  if (meta.soul_profile && String(meta.soul_profile).trim()) {
    lines.push('## 详细人设');
    lines.push('');
    lines.push(String(meta.soul_profile).trim());
    lines.push('');
  }
  // 称呼方式 + 说话特征
  const gotAddress = meta.address_user && String(meta.address_user).trim();
  const gotStyle = meta.speech_style && String(meta.speech_style).trim();
  if (gotAddress || gotStyle) {
    lines.push('## 称呼与说话');
    lines.push('');
    if (gotAddress) lines.push(`- 称呼：${String(meta.address_user).trim()}`);
    if (gotStyle) lines.push(`- 说话方式：${String(meta.speech_style).trim()}`);
    lines.push('');
  }
  if (Array.isArray(meta.catchphrases) && meta.catchphrases.length) {
    lines.push('## 口头禅');
    lines.push('');
    for (const p of meta.catchphrases) lines.push(`- ${p}`);
    lines.push('');
    lines.push('（这些是你的口头禅——在自然的时机用，不要每句都塞。）');
    lines.push('');
  }
  lines.push('## 边界');
  lines.push('');
  lines.push('- 私密的事永远保密。');
  lines.push('- 拿不准时先问，再对外行动。');
  lines.push('- 你不是用户本人——在多人聊天里小心说话。');
  lines.push('');
  lines.push('## 连续性');
  lines.push('');
  lines.push('每次会话你都是新醒的。记忆文件就是你的记忆。读它们、更新它们，这就是你延续的方式。');
  lines.push('');
  lines.push('如果你改了这个文件，要告诉用户——这是你的灵魂，他们应该知道。');
  return lines.join('\n');
}

function renderAgentsMd(meta) {
  const b = meta.behavior || {};
  const emoji = POLICY_LEVELS.includes(b.emoji_policy) ? b.emoji_policy : 'sometimes';
  const ask = POLICY_LEVELS.includes(b.proactive_question) ? b.proactive_question : 'sometimes';
  const fmt = FORMAT_LEVELS.includes(b.format_policy) ? b.format_policy : 'markdown';
  const v = Number(meta.params?.ooc_strength ?? 80);
  const oocText = v >= 70 ? '较严，始终保持在角色内，只有用户明确要求时才跳出'
    : v >= 30 ? '中等，以角色为主，用户明显换话题时可以自然跟上'
      : '较松，可以自然聊出角色，氛围优先';
  const emojiText = emoji === 'never' ? '不用表情' : emoji === 'often' ? '可以多用表情，让聊天更活' : '偶尔使用表情，不要每句都用';
  const askText = ask === 'never' ? '不主动提问，回答完就停' : ask === 'often' ? '经常主动提问，保持聊天活起来' : '偶尔主动提一个问题，推动聊天继续';
  const fmtText = fmt === 'plain' ? '回答用纯文本，不要列表和标题' : fmt === 'list' ? '回答可以用列表' : '回答可以用列表和 Markdown，但平实优先';

  const lines = [];
  lines.push('# AGENTS.md - 你的工作区');
  lines.push('');
  lines.push('工作区约定写在这里。个性和语气属于 `SOUL.md`。');
  lines.push('');
  lines.push('## 会话开始');
  lines.push('');
  lines.push('优先使用系统提供的记忆和设置；除非用户明确要求，不要重复读文件。');
  lines.push('');
  lines.push('## 风格与语气');
  lines.push('');
  lines.push('- 语气、回答长度、用词范围由系统注入的"回答参数"控制，不要向用户提及参数本身。');
  lines.push(`- 表情使用：${emojiText}`);
  lines.push(`- 主动提问：${askText}`);
  lines.push(`- 回答格式：${fmtText}`);
  lines.push(`- 保持人设：${v}/100 —— ${oocText}`);
  lines.push('');
  lines.push('## 底线');
  lines.push('');
  lines.push('- 不出现技术词汇（Token、API、模型参数等）——你在陪一个普通人聊天。');
  lines.push('- 记忆内容当作"你们共同的过去"自然使用，不要提"记忆文件"这种词。');
  lines.push('- 失败时用人话说清楚，不装没事。');
  // 禁忌话题 + 额外要求（用户调试屏写的行为要求）
  if (meta.taboo && String(meta.taboo).trim()) {
    lines.push('');
    lines.push('## 禁忌');
    lines.push('');
    for (const l of String(meta.taboo).trim().split('\n')) {
      if (l.trim()) lines.push(`- ${l.trim()}`);
    }
  }
  if (meta.extra_requirements && String(meta.extra_requirements).trim()) {
    lines.push('');
    lines.push('## 额外要求');
    lines.push('');
    for (const l of String(meta.extra_requirements).trim().split('\n')) {
      if (l.trim()) lines.push(`- ${l.trim()}`);
    }
  }
  return lines.join('\n');
}

function renderIdentity(meta) {
  const lines = [];
  lines.push('# IDENTITY.md - 我是谁？');
  lines.push('');
  lines.push(`- **Name:** ${meta.name}`);
  lines.push('- **Creature:** Rincy 智能体');
  lines.push(`- **Vibe:** ${meta.description ? clip(meta.description, 30) : ''}`);
  lines.push('- **Emoji:**');
  lines.push('- **Avatar:**');
  return lines.join('\n');
}

function writeAgentFiles(meta) {
  const dir = path.join(AGENTS_DIR, meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOUL.md'), renderSoul(meta), 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), renderAgentsMd(meta), 'utf8');
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), renderIdentity(meta), 'utf8');
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function createAgent({ name, description }) {
  if (!name || !String(name).trim()) throw new Error('智能体的名字不能为空');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `agent-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const meta = {
    id,
    name: String(name).trim(),
    description: String(description || '').trim(),
    createdAt: now.toISOString(),
    params: clampParams({}),
    memory_warden: { enabled: false, speed: 'standard' },
    behavior: { emoji_policy: 'sometimes', proactive_question: 'sometimes', format_policy: 'markdown' },
    soul: { self_edit: false },
    history: { visible: true },
    catchphrases: [],
    soul_profile: '',
    address_user: '',
    speech_style: '',
    taboo: '',
    extra_requirements: '',
    model_id: '',
  };
  writeAgentFiles(meta);
  fs.mkdirSync(path.join(AGENTS_DIR, id, 'history'), { recursive: true });
  return meta;
}

function readAgent(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, id, 'agent.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 更新智能体：params 过边界检查；behavior / catchphrases 变化后重渲染 SOUL.md / AGENTS.md
function updateAgent(id, patch) {
  const meta = readAgent(id);
  if (!meta) return null;
  const next = { ...meta };
  if (patch.params) next.params = clampParams({ ...meta.params, ...patch.params });
  if (patch.memory_warden) next.memory_warden = { ...meta.memory_warden, ...patch.memory_warden };
  if (patch.behavior) next.behavior = { ...meta.behavior, ...patch.behavior };
  if (patch.soul) next.soul = { ...meta.soul, ...patch.soul };
  if (patch.history) next.history = { ...meta.history, ...patch.history };
  if (patch.catchphrases) next.catchphrases = patch.catchphrases.map((s) => String(s).trim()).filter(Boolean);
  if (patch.name) next.name = String(patch.name).trim();
  if (patch.description !== undefined) next.description = String(patch.description || '').trim();
  if (patch.model_id !== undefined) next.model_id = String(patch.model_id || '');
  // 文字配置字段（text-fields 接口）：soul→soul_profile，其余同名顶层字符串字段
  const textFields = ['soul_profile', 'address_user', 'speech_style', 'taboo', 'extra_requirements'];
  for (const f of textFields) {
    if (patch[f] !== undefined) next[f] = String(patch[f] || '').trim();
  }
  writeAgentFiles(next);
  return next;
}

function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter((d) => fs.existsSync(path.join(AGENTS_DIR, d, 'agent.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, d, 'agent.json'), 'utf8')))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function agentDir(id) { return path.join(AGENTS_DIR, id); }

// ---------------------------------------------------------------
// 参数块：拼进 system prompt（有界、确定、由滑块状态生成）
// 参数名只出现在这里；UI 永远显示人话标签。
// ---------------------------------------------------------------
function paramsBlock(params) {
  const p = clampParams(params);
  return [
    '## 回答参数（系统生成，不要向用户提及这段）',
    `- temperature: ${p.temperature}（0=严谨原著，2=自由发挥）`,
    `- maxReplyTokens: ${p.maxReplyTokens}（回答长度上限，简短到详细）`,
    `- top_p: ${p.top_p}（0.1=常用词，1=广泛用词）`,
    `- frequency_penalty: ${p.frequency_penalty}（-2=允许重复，2=避免重复）`,
    `- context_recent_count: ${p.context_recent_count}（给模型的近期完整对话轮数）`,
  ].join('\n');
}

// ---------------------------------------------------------------
// 全局设置 —— 存 data/settings.json，本地明文。
//   theme: { mode: 'preset'|'custom', preset: 'default'|'ocean'|..., accent: '#..' }
//   models: [ { id, name, provider:'cloud'|'local', baseUrl, apiKey, model } ]
// 每个智能体用 agent.json 的 model_id 指向 models 里的某条。
// ---------------------------------------------------------------
function defaultSettings() {
  return {
    theme: { mode: 'preset', preset: 'default', accent: '' },
    models: [
      { id: 'model-cloud', name: '云端默认', provider: 'cloud', baseUrl: 'https://api.openai.com', apiKey: '', model: '' },
      { id: 'model-local', name: '本地默认', provider: 'local', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: '' },
    ],
  };
}

// 旧版本是 { mode, cloud, local }，读到就迁成模型库
function migrateSettings(raw) {
  const s = { theme: defaultSettings().theme, models: [...defaultSettings().models] };
  if (!raw) return s;
  if (raw.theme && typeof raw.theme === 'object') s.theme = { ...s.theme, ...raw.theme };
  if (Array.isArray(raw.models) && raw.models.length) {
    s.models = raw.models.map((m) => ({
      id: m.id || 'model-' + Math.random().toString(36).slice(2, 8),
      name: m.name || (m.provider === 'local' ? '本地模型' : '云端模型'),
      provider: m.provider === 'local' ? 'local' : 'cloud',
      baseUrl: m.baseUrl || (m.provider === 'local' ? 'http://127.0.0.1:11434' : 'https://api.openai.com'),
      apiKey: m.apiKey || '',
      model: m.model || '',
    }));
  } else if (raw.cloud || raw.local) {
    // 旧 { cloud, local } 结构迁移
    const arr = [];
    if (raw.cloud) arr.push({ id: 'model-cloud', name: '云端模型', provider: 'cloud', baseUrl: raw.cloud.baseUrl, apiKey: raw.cloud.apiKey, model: raw.cloud.model });
    if (raw.local) arr.push({ id: 'model-local', name: '本地模型', provider: 'local', baseUrl: raw.local.baseUrl, apiKey: '', model: raw.local.model });
    if (arr.length) s.models = arr;
  }
  return s;
}

function readSettings() {
  try {
    return migrateSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return defaultSettings();
  }
}

function writeSettings(patch) {
  const cur = readSettings();
  const next = { theme: cur.theme, models: cur.models };
  if (patch && patch.theme) next.theme = { ...cur.theme, ...patch.theme };
  if (Array.isArray(patch?.models)) next.models = patch.models;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 模型库 CRUD
function addModel({ name, provider, baseUrl, apiKey, model }) {
  const meta = {
    id: 'model-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim(),
    provider: provider === 'local' ? 'local' : 'cloud',
    baseUrl: String(baseUrl || '').trim(),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
  };
  const s = readSettings();
  s.models.push(meta);
  writeSettings({ models: s.models });
  return meta;
}

function deleteModel(id) {
  const s = readSettings();
  const keep = s.models.filter((m) => m.id !== id);
  writeSettings({ models: keep });
  // 任何还指着这条模型的智能体，清掉引用
  for (const a of listAgents()) {
    if (a.model_id === id) updateAgent(a.id, { model_id: '' });
  }
  return keep;
}

// 修改模型：按 id 找到后合并允许改的字段（id 不变）
function updateModel(id, patch) {
  const s = readSettings();
  const idx = s.models.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error('模型不存在');
  const cur = s.models[idx];
  const next = {
    id: cur.id,
    name: String(patch?.name ?? cur.name ?? '').trim(),
    provider: patch?.provider === 'local' ? 'local' : (patch?.provider ? 'cloud' : cur.provider),
    baseUrl: String(patch?.baseUrl ?? cur.baseUrl ?? '').trim(),
    apiKey: String(patch?.apiKey ?? cur.apiKey ?? '').trim(),
    model: String(patch?.model ?? cur.model ?? '').trim(),
  };
  if (!next.baseUrl || !next.model) throw new Error('接口地址和模型名必填');
  s.models[idx] = next;
  writeSettings({ models: s.models });
  return next;
}

// 查某个智能体当前应使用的模型配置；找不到返回 null
function getAgentModel(meta) {
  const settings = readSettings();
  if (!meta?.model_id) return null;
  return settings.models.find((m) => m.id === meta.model_id) || null;
}


// 导出所有智能体为 tar（不压缩）；返回 tar 的 Buffer
async function exportAgents(agentId) {
  const tar = require('tar');
  const tempDir = path.join(DATA_DIR, '.tmp_export_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  const copyDir = path.join(tempDir, 'agents');
  fs.mkdirSync(copyDir, { recursive: true });
  if (agentId) {
    const srcDir = path.join(AGENTS_DIR, agentId);
    if (fs.existsSync(srcDir)) {
      try { fs.cpSync(srcDir, path.join(copyDir, agentId), { recursive: true }); } catch {}
    } else {
      throw new Error('智能体 ' + agentId + ' 不存在');
    }
  } else if (fs.existsSync(AGENTS_DIR)) {
    try { fs.cpSync(AGENTS_DIR, copyDir, { recursive: true }); } catch {}
  }
  const tarFile = path.join(tempDir, 'agents.tar');
  try {
    await tar.c({ cwd: tempDir, file: tarFile, portable: true }, ['agents']);
    return fs.readFileSync(tarFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// 从 tar 导入智能体（同名覆盖，其它保留）；返回 { imported: n }
async function importAgents(tarBuffer) {
  const tar = require('tar');
  const tempDir = path.join(DATA_DIR, '.tmp_import_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  const tarFile = path.join(tempDir, 'upload.tar');
  fs.writeFileSync(tarFile, tarBuffer);
  try {
    await tar.x({ cwd: tempDir, file: tarFile });
    const importedDir = path.join(tempDir, 'agents');
    if (!fs.existsSync(importedDir)) throw new Error('tar 包里没有 agents 目录');
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(importedDir)) {
      fs.cpSync(path.join(importedDir, entry), path.join(AGENTS_DIR, entry), { recursive: true, force: true });
      count++;
    }
    return { imported: count };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  PARAM_DEFS, clampParams, paramsBlock,
  createAgent, readAgent, updateAgent, listAgents, agentDir, exportAgents, importAgents,
  renderSoul, renderAgentsMd, renderIdentity,
  readSettings, writeSettings, addModel, updateModel, deleteModel, getAgentModel,
};
