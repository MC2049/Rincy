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
// 历史遗留 id：曾短暂改用过 'agent-meta'，启动时自动改名迁回
const LEGACY_IDS = ['agent-meta'];
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
  // 迁移：agents/agent-meta/（短暂用过的 id）改回 agents/metasoul/，历史与记忆全保留
  for (const legacy of LEGACY_IDS) {
    const from = path.join(AGENTS_DIR, legacy);
    const to = path.join(AGENTS_DIR, METASOUL_ID);
    if (legacy !== METASOUL_ID && fs.existsSync(from) && !fs.existsSync(to)) {
      try { fs.renameSync(from, to); } catch { /* 迁移失败则按新建处理 */ }
    }
  }
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
// 预算制：总预算 40KB，超出的智能体只进名单（id + 名字 + 简介），
// 保证 prompt 不会因为智能体太多被撑爆。
function buildSnapshot(config) {
  const agents = config.listAgents().filter((a) => a.id !== METASOUL_ID);
  if (!agents.length) {
    return '## 管辖范围\n\n（还没有其它智能体。用户创建后，你就能看到并管理它们。）';
  }
  const BUDGET = 40000;
  const parts = [`## 管辖范围（共 ${agents.length} 个智能体，内容已注入）`, ''];
  let used = 0;
  const skipped = [];
  for (const a of agents) {
    const header = `---\n### 智能体「${a.name}」（id: ${a.id}）`;
    if (used > BUDGET) { skipped.push(`- ${a.name}（id: ${a.id}）${a.description ? '：' + a.description : ''}`); continue; }
    const dir = config.agentDir(a.id);
    const read = (f, n) => { try { return clip(fs.readFileSync(path.join(dir, f), 'utf8'), n); } catch { return '（空）'; } };
    const block = [
      header + (a.description ? `\n简介：${a.description}` : ''),
      a.taboo ? `禁忌：${String(a.taboo).replace(/\n/g, '；')}` : '',
      (function () { let fl = []; try { fl = fs.readdirSync(config.agentDir(a.id)).filter((x) => x !== 'history'); } catch (e) { } return fl.length ? `文件：${fl.join('、')}` : ''; })(),
      '**SOUL.md**\n```\n' + read('SOUL.md', 2000) + '\n```',
      '**AGENTS.md**\n```\n' + read('AGENTS.md', 2000) + '\n```',
    ].filter(Boolean).join('\n') + '\n';
    used += block.length;
    parts.push(block);
  }
  if (skipped.length) {
    parts.push(`---\n### 其余 ${skipped.length} 个智能体（内容因篇幅未展开，只有名单）\n` + skipped.join('\n'));
  }
  return parts.join('\n');
}

// 操作协议说明（拼进 system prompt）
function protocolBlock() {
  return [
    '## 操作协议（你管理其它智能体的唯一方式）',
    '',
    '上面的「管辖范围」里是每个智能体的当前内容与文件清单。用户让你修改或创建智能体时，',
    '在回复里输出下面这种代码块（可多个），系统会替你执行，用户不会看到块本身：',
    '',
    '修改某个智能体目录下的任意文件或配置（file 是相对路径，可带子目录；',
    'SOUL.md / AGENTS.md / IDENTITY.md / memory.md / agent.json（参数配置）等都可以）：',
    '',
    '```metasoul',
    '{"op":"write","agent":"<智能体id>","file":"SOUL.md","content":"文件完整的新内容"}',
    '```',
    '',
    '新建智能体（带完整设定，推荐这种方式，建好后在界面上也能继续编辑）：',
    '',
    '```metasoul',
    '{"op":"create","name":"名字","description":"一句话简介","soul_profile":"大段详细人设","speech_style":"说话特征","address_user":"怎么称呼用户","catchphrases":["口头禅1"],"taboo":"禁忌","extra_requirements":"额外要求"}',
    '```',
    '',
    '规则：',
    '- 除 name 外 create 的字段都可省略；soul_profile 里写完整人设（经历、性格、说话习惯等）。',
    '- write 的 content 必须是文件完整的新内容（不是增量）；JSON 里换行写成 \\n。',
    '- 改 agent.json（temperature 等参数）时保持 JSON 合法，且不要动 id 和 builtin 字段。',
    '- 新建后记得在正文里告诉用户新智能体的名字。改动之外，用一句话说明你做了什么。',
    '- id 必须用「管辖范围」里括号中的原样 id。',
  ].join('\n');
}

// 解析回复里的操作块 → { cleaned, ops, bad }
// 支持两种写法：{"op":"write"/"create",...} 与旧格式 {"agent","file","content"}（等价 op=write）
function parseWrites(full) {
  const text = String(full || '');
  const ops = [];
  let bad = 0;
  const cleaned = text.replace(/```metasoul\s*\n?([\s\S]*?)```/g, (_m, body) => {
    try {
      const j = JSON.parse(body.trim());
      if (j.op === 'create' && typeof j.name === 'string' && j.name.trim()) {
        ops.push({ op: 'create', fields: j });
        return '';
      }
      const agent = typeof j.agent === 'string' ? j.agent.trim() : '';
      const file = typeof j.file === 'string' ? j.file.trim() : '';
      const content = typeof j.content === 'string' ? j.content : '';
      if (agent && file && (j.op === 'write' || (content && j.op === undefined))) {
        ops.push({ op: 'write', agent, file, content });
        return '';
      }
    } catch { /* JSON 坏了 */ }
    bad++;
    return '';
  });
  return { cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), ops, bad };
}

// 应用操作块 → { applied, errors }
// write：agents/<id>/ 下的任意文件与配置；create：新建智能体（可带完整人设字段）
function applyOps(ops, config) {
  const applied = [];
  const errors = [];
  for (const w of ops || []) {
    try {
      if (w.op === 'create') {
        const f = w.fields || {};
        const created = config.createAgent({ name: f.name, description: f.description });
        const patch = {};
        for (const key of ['soul_profile', 'speech_style', 'address_user', 'taboo', 'extra_requirements']) {
          if (typeof f[key] === 'string' && f[key].trim()) patch[key] = f[key];
        }
        if (Array.isArray(f.catchphrases) && f.catchphrases.length) patch.catchphrases = f.catchphrases;
        if (Object.keys(patch).length) config.updateAgent(created.id, patch);
        applied.push({ op: 'create', agent: created.id, name: created.name });
        continue;
      }
      // ---- write ----
      const rel = String(w.file || '').replace(/\\/g, '/').trim();
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
        throw new Error('文件路径不合法：' + w.file);
      }
      if (w.agent === METASOUL_ID && rel === 'agent.json') {
        throw new Error('元灵不能通过操作块修改自己的 agent.json');
      }
      const target = config.readAgent(w.agent);
      if (!target) throw new Error('智能体不存在：' + w.agent);
      const dir = config.agentDir(w.agent);
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error('文件路径越界：' + w.file);
      if (rel.endsWith('.json')) {
        let j;
        try { j = JSON.parse(w.content); } catch { throw new Error('JSON 文件内容不合法：' + rel); }
        if (rel === 'agent.json') {
          j.id = w.agent;                    // id 永远跟目录走，防止目录与内容自相矛盾
          if (target.builtin) j.builtin = true;
          w.content = JSON.stringify(j, null, 2);
        }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, w.content, 'utf8');
      applied.push({ op: 'write', agent: w.agent, name: target.name, file: rel });
    } catch (e) {
      errors.push({
        op: w.op, agent: w.agent || '',
        file: w.file || (w.fields && w.fields.name) || '',
        error: e.message,
      });
    }
  }
  return { applied, errors };
}

// 回复为空但只有操作块时，给用户一句可见的交代
function fallbackText(applied) {
  if (!applied.length) return '';
  const created = applied.filter((a) => a.op === 'create');
  const written = applied.filter((a) => a.op !== 'create');
  const bits = [];
  if (created.length) bits.push('已创建：' + created.map((a) => a.name).join('、'));
  if (written.length) bits.push('已修改 ' + written.length + ' 个文件：' + written.map((a) => a.name + '/' + a.file).join('、'));
  return bits.join('；') + '。';
}

module.exports = {
  METASOUL_ID, METASOUL_NAME, WRITABLE_FILES, isMetasoul,
  ensureMetasoul, buildSnapshot, protocolBlock, parseWrites, applyOps, fallbackText,
};
