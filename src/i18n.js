// i18n.js — 语言包（.lang）加载与合并
// .lang 格式：每行 `key = value`；# 或 ; 开头是注释；空行忽略；[xxx] 段头忽略。
// 特殊键 `__lang_name__` = 这个语言包的自我称呼（显示在语言选择器里）。
// 优先级：内置（repo lang/ 目录）→ 用户导入（data/lang/ 目录，同名键覆盖内置）。
// 失败纪律：任何读不了/解析不了的文件都跳过，不阻塞启动。
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RINCY_DATA_DIR
  ? path.resolve(process.env.RINCY_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BUILTIN_DIR = path.join(__dirname, '..', 'lang');
const CUSTOM_DIR = path.join(DATA_DIR, 'lang');

const DEFAULT_LANG = 'zh-CN';

// 解析 .lang 文本 → { name, dict }
function parseLang(text) {
  const dict = {};
  let name = '';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) continue; // 段头，忽略
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!key) continue;
    if (key === '__lang_name__') { name = val; continue; }
    dict[key] = val;
  }
  return { name, dict };
}

function readLangFile(file) {
  try { return parseLang(fs.readFileSync(file, 'utf8')); } catch { return { name: '', dict: {} }; }
}

// 列出可用语言：内置 + 自定义（自定义同名时标记 custom，仍以内置为底）
function listLangs() {
  const out = new Map();
  for (const dir of [BUILTIN_DIR, CUSTOM_DIR]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.lang')); } catch { continue; }
    for (const f of files) {
      const code = f.slice(0, -'.lang'.length);
      const { name } = readLangFile(path.join(dir, f));
      const prev = out.get(code);
      out.set(code, {
        code,
        name: name || (prev && prev.name) || code,
        builtin: dir === BUILTIN_DIR,
        custom: dir === CUSTOM_DIR || Boolean(prev && prev.custom),
      });
    }
  }
  return [...out.values()];
}

// 合并某个语言的完整字典：zh-CN 打底 → 该语言内置 → 该语言用户导入（后者覆盖前者）
function loadDict(code) {
  const c = String(code || DEFAULT_LANG);
  const dict = {};
  const layers = [
    path.join(BUILTIN_DIR, DEFAULT_LANG + '.lang'), // 中文打底：任何语言缺键都回落中文
    path.join(BUILTIN_DIR, c + '.lang'),
    path.join(CUSTOM_DIR, c + '.lang'),
  ];
  for (const f of layers) {
    if (!fs.existsSync(f)) continue;
    Object.assign(dict, readLangFile(f).dict);
  }
  return dict;
}

// 语言代码合法性：文件名安全（防路径穿越）
function safeCode(raw) {
  const c = String(raw || '').trim().replace(/\.lang$/i, '');
  if (!c || c.length > 40) return '';
  if (/[\\/:*?"<>|]|\.\./.test(c)) return '';
  return c;
}

// 保存用户导入的语言包 → data/lang/<code>.lang
function saveLang(code, text) {
  const c = safeCode(code);
  if (!c) throw new Error('语言代码不合法');
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  fs.writeFileSync(path.join(CUSTOM_DIR, c + '.lang'), String(text), 'utf8');
  return c;
}

// 删除用户导入的语言包（内置的不许删）
function deleteLang(code) {
  const c = safeCode(code);
  if (!c) throw new Error('语言代码不合法');
  const f = path.join(CUSTOM_DIR, c + '.lang');
  if (!fs.existsSync(f)) throw new Error('这个语言包不存在或不是导入的');
  fs.rmSync(f);
  return c;
}

module.exports = { DEFAULT_LANG, listLangs, loadDict, saveLang, deleteLang, safeCode, parseLang };
