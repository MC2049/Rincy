// Portions adapted from OpenClaw (MIT License, Copyright (c) 2026 OpenClaw Foundation)
// memory.js — 孟婆系统（memory warden）读写
// 职责（两件事）：
//   ① 维护 data/agents/<id>/history/ 下的完整本地存档（聊天框显示的记录也从这儿来，只是不发给 API）
//   ② 生成 data/agents/<id>/memory.md（分层记忆，每次请求只发这个给 API）
// 纪律：失败永不阻塞回复——任何读写挂了都返回空/降级，由调用方兜底。
'use strict';

const fs = require('fs');
const path = require('path');

// 遗忘速度 → 中期记忆层的保留倍数（相对近期轮数）：
//   较快 = 忘得快 = 中期层薄（1 倍）；标准 = 2 倍；较慢 = 忘得慢 = 中期层厚（3 倍）
//   不遗忘 = 全部对话完整保留在近期层，不分中期远期
const SPEED_MID_FACTOR = { fast: 1, standard: 2, slow: 3, never: Infinity };

function historyFile(agentDir) {
  return path.join(agentDir, 'history', 'chat.md');
}

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

// ① 完整本地存档：追加一条消息（人类可读的 Markdown，用户可直接打开看）
function appendHistory(agentDir, who, text, thought) {
  try {
    fs.mkdirSync(path.dirname(historyFile(agentDir)), { recursive: true });
    let block = `\n## [${now()}] ${who}\n\n${text || ''}\n`;
    // 深度思考的过程以 ```思考 围栏跟在本次回答后面，一并入档
    if (thought) block += `\n\`\`\`思考\n${thought}\n\`\`\`\n`;
    fs.appendFileSync(historyFile(agentDir), block, 'utf8');
  } catch (e) {
    console.error('[memory] 存档写入失败（不影响回复）：', e.message);
  }
}

function readHistory(agentDir) {
  try {
    return fs.readFileSync(historyFile(agentDir), 'utf8').trim();
  } catch {
    return '';
  }
}

// 从完整存档解析出 {ts, who, text} 数组（"## [时间] 谁" 为分隔）
function parseHistory(md) {
  const out = [];
  let cur = null, inThought = false;
  for (const line of String(md).split('\n')) {
    const m = line.match(/^## \[([^\]]*)\] (.+)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { ts: m[1], who: m[2].trim(), text: '', thought: '' };
      inThought = false;
    } else if (cur) {
      const t = line.trim();
      if (t === '```思考') { inThought = true; continue; }
      if (inThought && t === '```') { inThought = false; continue; }
      if (!t) continue;
      if (inThought) cur.thought += (cur.thought ? '\n' : '') + t;
      else cur.text += (cur.text ? '\n' : '') + t;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// 把条目数组写回完整存档（重生成/编辑消息时的历史裁剪用）
function writeHistory(agentDir, entries) {
  try {
    fs.mkdirSync(path.dirname(historyFile(agentDir)), { recursive: true });
    let md = '';
    for (const e of entries) {
      md += `\n## [${e.ts}] ${e.who}\n\n${e.text || ''}\n`;
      if (e.thought) md += `\n\`\`\`思考\n${e.thought}\n\`\`\`\n`;
    }
    fs.writeFileSync(historyFile(agentDir), md, 'utf8');
  } catch (e) {
    console.error('[memory] 存档回写失败（不影响回复）：', e.message);
  }
}

// 历史裁剪：
//   popLastAI        → 去掉末尾的 AI 回复（重生成：同一条用户消息重新生成）
//   popUserAndAfter  → 去掉最后一条用户消息及其后的所有内容（修改输入：编辑后重发）
// lastUserText → 最后一条用户消息文本（重生成要用它当提示），无则空串
function lastUserText(agentDir) {
  try {
    const entries = parseHistory(readHistory(agentDir));
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].who === '用户') return entries[i].text;
    }
  } catch { /* 读不到就当没有 */ }
  return '';
}
function popLastAI(agentDir) {
  try {
    const entries = parseHistory(readHistory(agentDir));
    while (entries.length && entries[entries.length - 1].who !== '用户') entries.pop();
    writeHistory(agentDir, entries);
  } catch (e) {
    console.error('[memory] 裁剪失败（不影响回复）：', e.message);
  }
}
function popUserAndAfter(agentDir) {
  try {
    const entries = parseHistory(readHistory(agentDir));
    let cut = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].who === '用户') { cut = i; break; }
    }
    writeHistory(agentDir, entries.slice(0, cut));
  } catch (e) {
    console.error('[memory] 裁剪失败（不影响回复）：', e.message);
  }
}

// ② 分层记忆重建（孟婆的核心）：
//    近期记忆 = 最近 N 条完整带时间戳的对话（N = params.context_recent_count）
//    中期记忆 = 再往前 M 条，压缩成摘要（M = N × 遗忘速度倍数；骨架版：截短，后续接模型摘要）
//    远期记忆 = 剩下的，只留要点关键词
function rebuildMemory(agentDir, meta) {
  const speed = meta?.memory_warden?.speed || 'standard';
  const recentCount = Math.max(1, Number(meta?.params?.context_recent_count) || 10);
  const midFactor = SPEED_MID_FACTOR[speed] ?? SPEED_MID_FACTOR.standard;

  const entries = parseHistory(readHistory(agentDir));
  let recent, mid, far;
  if (!Number.isFinite(midFactor)) {
    recent = entries; mid = []; far = []; // 不遗忘：全部完整保留
  } else {
    recent = entries.slice(-recentCount);
    const older = entries.slice(0, Math.max(0, entries.length - recentCount));
    const midCount = Math.min(older.length, recentCount * midFactor);
    mid = older.slice(-midCount);
    far = older.slice(0, Math.max(0, older.length - midCount));
  }

  const lines = ['# 记忆', ''];

  lines.push('## 近期记忆');
  if (!recent.length) lines.push('（还没有对话）');
  for (const e of recent) {
    lines.push(`- [${e.ts}] ${e.who}：${e.text}`);
    // 深度思考的摘要跟在对应回答后进记忆——模型记得自己当时是怎么想的
    if (e.who !== '用户' && e.thought) lines.push(`  - 思考摘要：${clip(e.thought, 100)}`);
  }
  lines.push('');

  lines.push('## 中期记忆（压缩摘要）');
  if (!mid.length) lines.push('（暂无）');
  for (const e of mid) lines.push(`- ${e.who}说过：${clip(e.text, 60)}…`);
  lines.push('');

  lines.push('## 远期记忆（要点关键词）');
  if (!far.length) lines.push('（暂无）');
  for (const e of far) lines.push(`- ${clip(e.text, 12)}…`);

  const md = lines.join('\n') + '\n';
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'memory.md'), md, 'utf8');
  } catch (e) {
    console.error('[memory] memory.md 写入失败（不影响回复）：', e.message);
  }
  return md;
}

function readMemory(agentDir) {
  try {
    return fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8');
  } catch {
    return '';
  }
}

// 清空聊天记录（不删人设）：完整存档重写为空 + memory.md 重建
function clearHistory(agentDir, meta) {
  try {
    fs.mkdirSync(path.dirname(historyFile(agentDir)), { recursive: true });
    fs.writeFileSync(historyFile(agentDir), '', 'utf8');
  } catch (e) {
    console.error('[memory] 清空存档失败：', e.message);
  }
  rebuildMemory(agentDir, meta);
}

// ---------- 回复分支（重生成的历史版本） ----------
// history/variants.json：{ "ai-N": [ {t, text, thought}, ... ] }
// ai-N = 存档里第 N 条 AI 回复（1 起数）；数组收齐这条回复的全部版本（含当前生效版），
// 当前生效哪个由 chat.md 的内容精确匹配得出。
function variantsFile(agentDir) { return path.join(agentDir, 'history', 'variants.json'); }
function loadVariants(agentDir) {
  try { return JSON.parse(fs.readFileSync(variantsFile(agentDir), 'utf8')); } catch { return {}; }
}
function saveVariants(agentDir, v) {
  try {
    fs.mkdirSync(path.join(agentDir, 'history'), { recursive: true });
    fs.writeFileSync(variantsFile(agentDir), JSON.stringify(v, null, 2), 'utf8');
  } catch (e) { console.error('[memory] 变体写入失败（不影响回复）：', e.message); }
}
// 把某条 AI 回复的当前内容登记进它的版本表（已存在同文本则跳过）
function syncVariant(agentDir, n, entry) {
  if (!(n >= 1) || !entry || entry.who === '用户') return;
  const all = loadVariants(agentDir);
  const key = String(n);
  const list = Array.isArray(all[key]) ? all[key] : [];
  if (!list.some((x) => x.text === entry.text)) list.push({ t: entry.ts, text: entry.text, thought: entry.thought || '' });
  all[key] = list;
  saveVariants(agentDir, all);
}
// 把第 n 条 AI 回复原地换成指定版本（文本 + 思考一起换）
function replaceEntryByAIIndex(agentDir, n, v) {
  const entries = parseHistory(readHistory(agentDir));
  let seen = 0;
  for (const e of entries) {
    if (e.who === '用户') continue;
    seen++;
    if (seen === n) {
      e.ts = v.t || e.ts;
      e.text = v.text || '';
      e.thought = v.thought || '';
      writeHistory(agentDir, entries);
      return true;
    }
  }
  return false;
}
// 给前端的历史元数据：{ "n": { count, pos } }，pos 为当前生效版本下标（0 起）
function variantMeta(agentDir) {
  const entries = parseHistory(readHistory(agentDir));
  const aiEntries = entries.filter((e) => e.who !== '用户');
  const all = loadVariants(agentDir);
  const out = {};
  for (const key of Object.keys(all)) {
    const n = Number(key);
    if (!(n >= 1 && n <= aiEntries.length)) continue;   // 条目已被编辑/清空：丢弃
    const list = all[key];
    if (!Array.isArray(list) || list.length < 2) continue; // 只有一个版本谈不上切换
    const cur = aiEntries[n - 1];
    let pos = list.findIndex((x) => x.text === cur.text);
    if (pos === -1) { list.push({ t: cur.ts, text: cur.text, thought: cur.thought || '' }); pos = list.length - 1; saveVariants(agentDir, all); }
    out[key] = { count: list.length, pos };
  }
  return out;
}

module.exports = { appendHistory, readHistory, parseHistory, writeHistory, lastUserText, popLastAI, popUserAndAfter, rebuildMemory, readMemory, clearHistory, loadVariants, saveVariants, syncVariant, replaceEntryByAIIndex, variantMeta };
