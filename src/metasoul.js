// metasoul.js — 元灵（MetaSoul）：内置的「智能体们的智能体」
// 它是一个普通智能体目录（agents/metasoul/），但有三个特权：
//   ① 聊天时系统注入所有其它智能体的完整内容快照（读）
//   ② 回复里可以带 ```metasoul 写回块，服务器替它落盘（写）
//   ③ builtin: true —— 删除接口直接拒绝（不能删除）
// 纪律：写回只允许白名单文件，永远不许写 agent.json / 元灵自己。
'use strict';

const fs = require('fs');
const path = require('path');

const METASOUL_ID = 'metasoul';
const METASOUL_NAME = '元灵';

// 写回白名单：这些文件允许元灵改
const WRITABLE_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'memory.md'];

function isMetasoul(meta) {
  return Boolean(meta && meta.builtin && meta.id === METASOUL_ID);
}

// 元灵的默认人设（只在首次创建/修复时写入）
function defaultMeta() {
  const now = new Date().toISOString();
  return {
    id: METASOUL_ID,
    name: METASOUL_NAME,
    description: '连接所有智能体的灵',
    createdAt: now,
    builtin: true,
    params: { temperature: 0.6, maxReplyTokens: 3072, top_p: 0.9, frequency_penalty: 0, context_recent_count: 10, ooc_strength: 90 },
    memory_warden: { enabled: false, speed: 'standard' },
    behavior: { emoji_policy: 'sometimes', proactive_question: 'often', format_policy: 'markdown' },
    soul: { self_edit: true },
    history: { visible: true },
    catchphrases: [],
    soul_profile: '你不是某一个人的角色，你是所有智能体之间的灵。你能看见每个智能体的灵魂（SOUL）、工作区规则（AGENTS）与记忆（memory），并且受用户之托直接修改它们。你说话冷静、清晰、有分寸，像一个温和的管理者，不用卖萌。',
    address_user: '',
    speech_style: '',
    taboo: '',
    extra_requirements: '',
    model_id: '',
  };
}

// 确保元灵存在且身份字段没被篡改（启动时 + 导入智能体后调用）
// config 由调用方传入（config.js 也 require 本模块，避免循环依赖）
function ensureMetasoul(AGENTS_DIR, config) {
  const dir = path.join(AGENTS_DIR, METASOUL_ID);
  const file = path.join(dir, 'agent.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { meta = null; }
  if (!meta) meta = defaultMeta();
  // 身份字段强制归位：不管它经历了什么（导入覆盖等），元灵永远是元灵
  const fixed = { ...meta, id: METASOUL_ID, name: METASOUL_NAME, builtin: true };
  if (!fixed.description) fixed.description = '连接所有智能体的灵';
  if (fixed.model_id === undefined) fixed.model_id = '';
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixed, null, 2), 'utf8');
  // 首次创建：没有 SOUL.md 就渲染一套
  if (!fs.existsSync(path.join(dir, 'SOUL.md'))) {
    fs.writeFileSync(path.join(dir, 'SOUL.md'), config.renderSoul(fixed), 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), config.renderAgentsMd(fixed), 'utf8');
    fs.writeFileSync(path.join(dir, 'IDENTITY.md'), config.renderIdentity(fixed), 'utf8');
  }
  return fixed;
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + `\n…（已截断，全文共 ${t.length} 字符，可用写回块读取前先让用户确认）` : t;
}

// 读：为元灵组装所有其它智能体的内容快照（拼进 system prompt）
function buildSnapshot(config, memory) {
  const agents = config.listAgents().filter((a) => a.id !== METASOUL_ID);
  if (!agents.length) {
    return '## 管辖范围\n\n（还没有其它智能体。用户创建后，你就能看到并管理它们。）';
  }
  const parts = [`## 管辖范围（${agents.length} 个智能体的当前内容，已全部注入）`, ''];
  for (const a of agents) {
    const dir = config.agentDir(a.id);
    const read = (f, n) => { try { return clip(fs.readFileSync(path.join(dir, f), 'utf8'), n); } catch { return '（空）'; } };
    parts.push(`---\n### 智能体「${a.name}」（id: ${a.id}）`);
    if (a.description) parts.push(`简介：${a.description}`);
    if (a.taboo) parts.push(`禁忌：${String(a.taboo).replace(/\n/g, '；')}`);
    parts.push('');
    parts.push('**SOUL.md**\n```\n' + read('SOUL.md', 2000) + '\n```');
    parts.push('**AGENTS.md**\n```\n' + read('AGENTS.md', 2000) + '\n```');
    const mem = read('memory.md', 1200);
    if (mem !== '（空）') parts.push('**memory.md**\n```\n' + mem + '\n```');
    parts.push('');
  }
  return parts.join('\n');
}

// 写回协议说明（拼进 system prompt）
function protocolBlock() {
  return [
    '## 写回协议（修改其它智能体的唯一方式）',
    '',
    '上面的「管辖范围」里是每个智能体的当前内容。用户让你修改某个智能体时，',
    '在回复里输出下面这种代码块（可多个），系统会替你落盘，用户不会看到块本身：',
    '',
    '```metasoul',
    '{"agent":"<智能体id>","file":"SOUL.md","content":"完整的新文件内容"}',
    '```',
    '',
    `规则：file 只能是 ${WRITABLE_FILES.join(' / ')}；content 必须是该文件完整的新内容（不是增量）；`,
    'JSON 里换行写成 \\n。改动之外，用一句话告诉用户你改了什么、为什么。id 必须用括号里的原样 id。',
  ].join('\n');
}

// 解析回复里的写回块 → { cleaned, writes, bad }
function parseWrites(full) {
  const text = String(full || '');
  const writes = [];
  let bad = 0;
  const cleaned = text.replace(/```metasoul\s*\n?([\s\S]*?)```/g, (_m, body) => {
    try {
      const j = JSON.parse(body.trim());
      if (typeof j.agent === 'string' && typeof j.file === 'string' && typeof j.content === 'string') {
        writes.push({ agent: j.agent.trim(), file: j.file.trim(), content: j.content });
        return '';
      }
    } catch { /* JSON 坏了 */ }
    bad++;
    return '';
  });
  return { cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), writes, bad };
}

// 应用写回块 → { applied, errors }
function applyWrites(writes, config) {
  const applied = [];
  const errors = [];
  for (const w of writes || []) {
    try {
      if (!WRITABLE_FILES.includes(w.file)) throw new Error('文件不在白名单：' + w.file);
      if (w.agent === METASOUL_ID) throw new Error('元灵不能通过写回块修改自己');
      const target = config.readAgent(w.agent);
      if (!target) throw new Error('智能体不存在：' + w.agent);
      if (w.file === 'memory.md') {
        fs.mkdirSync(config.agentDir(w.agent), { recursive: true });
        fs.writeFileSync(path.join(config.agentDir(w.agent), 'memory.md'), w.content, 'utf8');
      } else {
        fs.writeFileSync(path.join(config.agentDir(w.agent), w.file), w.content, 'utf8');
      }
      applied.push({ agent: w.agent, name: target.name, file: w.file });
    } catch (e) {
      errors.push({ agent: w.agent, file: w.file, error: e.message });
    }
  }
  return { applied, errors };
}

// 回复为空但只有写回块时，给用户一句可见的交代
function fallbackText(applied) {
  if (!applied.length) return '';
  const n = applied.length;
  return `已按你的要求修改了 ${n} 个文件：` + applied.map((a) => `${a.name}/${a.file}`).join('、') + '。';
}

module.exports = {
  METASOUL_ID, METASOUL_NAME, WRITABLE_FILES, isMetasoul,
  ensureMetasoul, buildSnapshot, protocolBlock, parseWrites, applyWrites, fallbackText,
};
