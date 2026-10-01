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
function appendHistory(agentDir, who, text) {
  try {
    fs.mkdirSync(path.dirname(historyFile(agentDir)), { recursive: true });
    fs.appendFileSync(historyFile(agentDir), `\n## [${now()}] ${who}\n\n${text}\n`, 'utf8');
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
  let cur = null;
  for (const line of String(md).split('\n')) {
    const m = line.match(/^## \[([^\]]*)\] (.+)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { ts: m[1], who: m[2].trim(), text: '' };
    } else if (cur && line.trim()) {
      cur.text += (cur.text ? '\n' : '') + line.trim();
    }
  }
  if (cur) out.push(cur);
  return out;
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
  for (const e of recent) lines.push(`- [${e.ts}] ${e.who}：${e.text}`);
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

module.exports = { appendHistory, readHistory, parseHistory, rebuildMemory, readMemory, clearHistory };
