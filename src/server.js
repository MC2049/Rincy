// server.js — Rincy 入口：小号大管家
// 静态文件 + 创建智能体 + 聊天（流式）+ memory.md 自动读写。
// 纪律：回复路径上任何一步失败都不吞消息——错误用人话发到流里。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const Busboy = require('busboy');
const memory = require('./memory');
const adapter = require('./model-adapter');
const i18n = require('./i18n');
const metasoul = require('./metasoul');
const websearch = require('./websearch');

const PORT = Number(process.env.RINCY_PORT || 3000);
const WEB_DIR = path.join(__dirname, '..', 'web');
const THEMES_BUILTIN_DIR = path.join(__dirname, '..', 'themes');
const THEMES_CUSTOM_DIR = path.join(config.DATA_DIR, 'themes');

// 版本号唯一来源：package.json（前端"设置"里显示用）
let APP_VERSION = '';
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || ''; } catch { /* 读不到就空着 */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('请求体太大')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('禁止访问'); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('页面不存在');
    return;
  }
  // WebView 对静态文件一律要求重新验证：升级覆盖文件后，前端立即是新代码
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
}

// system prompt：人设（SOUL.md）+ 行为规则（AGENTS.md）+ 参数块 + memory.md（始终注入）
function buildSystemPrompt(meta) {
  const dir = config.agentDir(meta.id);
  const parts = [];
  try { parts.push(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8')); } catch { /* 没有人设就跳过 */ }
  try { parts.push(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')); } catch { /* 没有规则就跳过 */ }
  parts.push(config.paramsBlock(meta.params));
  const mem = memory.readMemory(dir);
  if (mem) parts.push('## 共同的过去（记忆）\n\n' + mem);
  return parts.join('\n\n');
}

// 组 messages：
//   孟婆开（省上下文）：system + 当前这条消息
//     —— 完整记录留在本地存档，发给 API 的只有 memory.md
//   孟婆关（像普通聊天）：system + 完整对话记录 + 当前这条消息
//     —— 记录照常全量发送，memory.md 也一起发
function buildMessages(meta, text) {
  const dir = config.agentDir(meta.id);
  const messages = [{ role: 'system', content: buildSystemPrompt(meta) }];
  if (!meta.memory_warden?.enabled) {
    for (const e of memory.parseHistory(memory.readHistory(dir))) {
      if (!e.text) continue;
      messages.push({ role: e.who === '用户' ? 'user' : 'assistant', content: e.text });
    }
  }
  messages.push({ role: 'user', content: text });
  return messages;
}

// 聊天（SSE 流式）
async function handleChat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
  const meta = body?.agentId ? config.readAgent(body.agentId) : null;
  if (!meta) { sendJSON(res, 404, { error: '找不到这个智能体' }); return; }
  const regenerate = !!body?.regenerate; // 重生成：同一条用户消息换个回答
  const editing = !!body?.edit;          // 修改输入：替换上一条用户消息及其回复
  let text = String(body?.message || '').trim();
  const dir = config.agentDir(meta.id);
  const isSoul = metasoul.isMetasoul(meta);

  if (regenerate) {
    // 重生成前：把当前这条回答登记进它的版本表（回复分支浏览的数据来源）
    const before = memory.parseHistory(memory.readHistory(dir)).filter((e) => e.who !== '用户');
    if (before.length) memory.syncVariant(dir, before.length, before[before.length - 1]);
    // 去掉末尾的 AI 回复，用最后一条用户消息重新生成（不新增用户消息）
    memory.popLastAI(dir);
    text = memory.lastUserText(dir);
    if (!text) { sendJSON(res, 400, { error: '没有可重生成的内容' }); return; }
  } else if (editing) {
    // 去掉最后一条用户消息及其后的 AI 回复，用编辑后的文本重发
    if (!text) { sendJSON(res, 400, { error: '消息不能为空' }); return; }
    memory.popUserAndAfter(dir);
  } else if (!text) {
    sendJSON(res, 400, { error: '消息不能为空' }); return;
  }

  // ① 用户消息进完整本地存档（聊天框记录的来源；只是不发给 API，除非孟婆关闭）
  // （重生成模式不新增存档——用户消息本来就在）
  if (!regenerate) memory.appendHistory(dir, '用户', text);

  const messages = buildMessages(meta, text);
  // 元灵：system prompt 末尾追加所有其它智能体的内容快照 + 写回协议
  if (isSoul) {
    messages[0].content += '\n\n' + metasoul.buildSnapshot(config) + '\n\n' + metasoul.protocolBlock();
  }
  const params = config.clampParams(meta.params);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // 客户端断开（刷新页面/前端 6 分钟兜底中止）时不许炸进程：
  // ① 吞掉连接上的 error 事件；② 断开后中止上游模型请求，别浪费 token
  req.on('error', () => {});
  res.on('error', () => {});
  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });
  const send = (event, data) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
  };

  // 这个对话选用的模型配置（模型库里的某条）
  let modelConf = config.getAgentModel(meta);
  // 元灵开箱即用：自己没选模型时自动继承——
  // ① 优先用其它智能体正在用的模型（大家能聊通，它也能）；
  // ② 兜底取模型库里第一个配置完整的。
  // 这样可避免继承到一个用户从没用过、连不通的模型（比如被墙的官方端点）。
  if (!modelConf && isSoul) {
    const models = config.readSettings().models || [];
    const usable = (m) => m && m.baseUrl && m.model && (m.provider === 'local' || m.apiKey);
    const referenced = config.listAgents()
      .filter((a) => a.id !== metasoul.METASOUL_ID && a.model_id)
      .map((a) => a.model_id);
    for (const id of referenced.reverse()) {
      const m = models.find((x) => x.id === id);
      if (usable(m)) { modelConf = m; break; }
    }
    if (!modelConf) modelConf = models.find(usable) || null;
  }
  if (!modelConf) {
    send('error', { message: '这个对话还没选模型。到"设置"里添加并选一个模型，再聊。' });
    memory.rebuildMemory(dir, meta);
    res.end();
    return;
  }

  // 深度思考开关（agent.json 的 thinking.enabled，默认开）
  const thinkOn = !(meta.thinking && meta.thinking.enabled === false);
  // 联网搜索开关（agent.json 的 websearch.enabled，默认关）+ 当前启用的搜索引擎
  const webOn = !!(meta.websearch && meta.websearch.enabled === true);
  const searchEngine = webOn ? websearch.activeEngine(config.readSettings()) : null;
  const MAX_SEARCH_ROUNDS = 2; // 一次回答最多搜两轮，防失控

  let full = '', thoughtText = '';
  let applied = []; // 元灵写回结果（循环外声明：done 事件要用）
  const extraMsgs = []; // 搜索轮的回填消息（assistant 原文 + user 搜索结果），逐轮累积
  // 联网过程记录：既推给前端思考区，也累积进思考围栏（chat.md 存档）
  const note = (s) => { thoughtText += s; send('thought', { text: s }); };
  try {
    while (true) {
      const roundMessages = messages.slice();
      if (searchEngine) {
        roundMessages[0] = { ...roundMessages[0], content: roundMessages[0].content + '\n\n' + websearch.protocolBlock() };
      }
      roundMessages.push(...extraMsgs);

      let roundFull = '';
      roundFull = await adapter.chatStream({
        modelConf,
        messages: roundMessages,
        params,
        think: thinkOn,
        signal: upstreamAbort.signal,
        onDelta: (d) => send('delta', { text: d }),
        onThought: (t) => { thoughtText += t; send('thought', { text: t }); },
      });

      // 元灵：回复里的 ```metasoul 写回块在此落盘；用户只看到块外的正文（每轮都处理）
      applied = [];
      if (isSoul) {
        const parsed = metasoul.parseWrites(roundFull);
        const r = metasoul.applyOps(parsed.ops, config, meta.name);
        applied = r.applied;
        if (r.errors.length) send('metasoul', { errors: r.errors });
        roundFull = parsed.cleaned || metasoul.fallbackText(applied) || roundFull;
        if (applied.length) send('metasoul', { applied });
      }

      // 联网：模型输出 ```search 块（查引擎）或 ```open 块（抓网页）→ 执行 → 结果回填 → 再生成一轮
      const wantsSearch = searchEngine ? websearch.extractQueries(roundFull) : [];
      const wantsOpen = webOn ? websearch.extractUrls(roundFull) : [];
      if ((wantsSearch.length || wantsOpen.length) && extraMsgs.length / 2 < MAX_SEARCH_ROUNDS) {
        const found = [], fails = [];
        for (const q of wantsSearch) {
          note('\n🔎 ' + q + ' …');
          try {
            const results = await websearch.search(q, searchEngine, { signal: upstreamAbort.signal });
            found.push(websearch.formatResults(q, results));
            note('（' + results.length + ' 条结果）');
          } catch (e) {
            fails.push('搜索「' + q + '」：' + e.message);
            note('（搜索失败：' + e.message + '）');
          }
        }
        for (const u of wantsOpen) {
          note('\n🌐 ' + u + ' …');
          try {
            const page = await websearch.openUrl(u, { signal: upstreamAbort.signal });
            found.push(websearch.formatPage(page));
            note('（' + page.text.length + ' 字）');
          } catch (e) {
            fails.push('打开 ' + u + '：' + e.message);
            note('（打开失败：' + e.message + '）');
          }
        }
        extraMsgs.push({ role: 'assistant', content: roundFull });
        extraMsgs.push({
          role: 'user',
          content: found.length
            ? found.join('\n\n') + '\n\n（以上是刚查到的实时内容。请基于它们正式回答用户最初的问题，引用事实时附来源链接；不要再输出 search/open 块。）'
            : '（联网没有成功：' + fails.join('；') + '。请直接根据你已有的知识正式回答，不要再输出 search/open 块。）',
        });
        continue; // 带着结果再生成一轮
      }

      // 收尾轮：剥掉可能残留的 search 块，只留正文
      full = searchEngine ? websearch.stripBlocks(roundFull) : roundFull;
      break;
    }
    // ② 回复完成后：AI 回复（连同思考过程）进完整存档，并登记进版本表
    memory.appendHistory(dir, meta.name, full, thoughtText);
    const after = memory.parseHistory(memory.readHistory(dir)).filter((e) => e.who !== '用户');
    if (after.length) memory.syncVariant(dir, after.length, after[after.length - 1]);
    send('done', { full, applied });
  } catch (e) {
    // 失败不吞消息：人话报错发到流里，聊天框照常显示
    send('error', { message: e.message || '出了点问题，稍后再试' });
  }
  // 无论成败都重建 memory.md——存档是最新的，分层记忆跟着走
  memory.rebuildMemory(dir, meta);
  res.end();
}

// 路由
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/agents' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
      try { sendJSON(res, 200, { ok: true, agent: config.createAgent(body || {}) }); }
      catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }
    if (p === '/api/agents' && req.method === 'GET') {
      sendJSON(res, 200, { agents: config.listAgents() });
      return;
    }
    if (p === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res);
      return;
    }
    if (p === '/api/params' && req.method === 'GET') {
      // 参数表（滑块渲染用）：参数名的唯一来源是 config.js，UI 只显示人话标签
      sendJSON(res, 200, { params: config.PARAM_DEFS });
      return;
    }
    // ---- 语言包（.lang）----
    if (p === '/api/langs' && req.method === 'GET') {
      sendJSON(res, 200, { langs: i18n.listLangs(), current: config.readSettings().language || i18n.DEFAULT_LANG });
      return;
    }
    if (p === '/api/langs/import' && req.method === 'POST') {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } });
      let saved = null, pending = 0, done = false;
      const finish = () => { if (done && pending === 0) sendJSON(res, 200, { ok: true, code: saved }); };
      busboy.on('file', (_name, file, info) => {
        pending++;
        const fname = path.basename(info.filename || 'custom.lang');
        const chunks = [];
        file.on('data', (c) => chunks.push(c));
        file.on('end', () => {
          try { saved = i18n.saveLang(fname, Buffer.concat(chunks).toString('utf8')); }
          catch (e) { sendJSON(res, 400, { error: '导入失败：' + e.message }); }
          pending--; finish();
        });
      });
      busboy.on('finish', () => { done = true; finish(); if (done && pending === 0 && saved === null && !res.writableEnded) sendJSON(res, 400, { error: '导入失败：没收到文件' }); });
      busboy.on('error', () => sendJSON(res, 400, { error: '导入失败：文件格式不对' }));
      req.pipe(busboy);
      return;
    }
    const lm = p.match(/^\/api\/langs\/([^/]+)$/);
    if (lm && req.method === 'GET') {
      const code = i18n.safeCode(decodeURIComponent(lm[1]));
      if (!code) { sendJSON(res, 400, { error: '语言代码不合法' }); return; }
      sendJSON(res, 200, { code, dict: i18n.loadDict(code) });
      return;
    }
    if (lm && req.method === 'DELETE') {
      try { i18n.deleteLang(decodeURIComponent(lm[1])); sendJSON(res, 200, { ok: true }); }
      catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    // ---- CSS 主题 ----
    // 主题名文件名安全：防路径穿越
    function safeThemeName(raw) {
      const n = String(raw || '').trim().replace(/\.css$/i, '');
      if (!n || n.length > 60) return '';
      if (/[\\/:*?"<>|]|\.\./.test(n)) return '';
      return n;
    }
    function listThemes() {
      const out = new Map();
      for (const [dir, source] of [[THEMES_BUILTIN_DIR, 'builtin'], [THEMES_CUSTOM_DIR, 'custom']]) {
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.css')); } catch { continue; }
        for (const f of files) {
          const name = f.slice(0, -4);
          const prev = out.get(name);
          out.set(name, { name, source, builtin: source === 'builtin' || Boolean(prev && prev.builtin) });
        }
      }
      return [...out.values()];
    }
    if (p === '/api/themes' && req.method === 'GET') {
      sendJSON(res, 200, { themes: listThemes(), current: (config.readSettings().theme || {}).css_name || '' });
      return;
    }
    if (p === '/api/themes/import' && req.method === 'POST') {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } });
      let saved = null, pending = 0, done = false, failed = false;
      const finish = () => { if (done && pending === 0 && !failed) sendJSON(res, 200, { ok: true, name: saved }); };
      busboy.on('file', (_name, file, info) => {
        pending++;
        const fname = path.basename(info.filename || 'theme.css');
        const chunks = [];
        file.on('data', (c) => chunks.push(c));
        file.on('end', () => {
          const name = safeThemeName(fname);
          if (!name) { failed = true; sendJSON(res, 400, { error: '导入失败：文件名不合法' }); return; }
          try {
            fs.mkdirSync(THEMES_CUSTOM_DIR, { recursive: true });
            fs.writeFileSync(path.join(THEMES_CUSTOM_DIR, name + '.css'), Buffer.concat(chunks), 'utf8');
            saved = name;
          } catch (e) { failed = true; sendJSON(res, 400, { error: '导入失败：' + e.message }); }
          pending--; finish();
        });
      });
      busboy.on('finish', () => { done = true; finish(); if (done && pending === 0 && saved === null && !failed && !res.writableEnded) sendJSON(res, 400, { error: '导入失败：没收到文件' }); });
      busboy.on('error', () => sendJSON(res, 400, { error: '导入失败：文件格式不对' }));
      req.pipe(busboy);
      return;
    }
    const tm = p.match(/^\/api\/themes\/([^/]+)(\/raw)?$/);
    if (tm && tm[2] && req.method === 'GET') {
      // 原样吐 CSS：自定义同名覆盖内置
      const name = safeThemeName(decodeURIComponent(tm[1]));
      if (!name) { res.writeHead(400); res.end('bad name'); return; }
      let file = path.join(THEMES_CUSTOM_DIR, name + '.css');
      if (!fs.existsSync(file)) file = path.join(THEMES_BUILTIN_DIR, name + '.css');
      if (!fs.existsSync(file)) { sendJSON(res, 404, { error: '主题不存在' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(fs.readFileSync(file));
      return;
    }
    if (tm && !tm[2] && req.method === 'DELETE') {
      const name = safeThemeName(decodeURIComponent(tm[1]));
      const f = path.join(THEMES_CUSTOM_DIR, name + '.css');
      if (!name || !fs.existsSync(f)) { sendJSON(res, 400, { error: '主题不存在或不是导入的' }); return; }
      fs.rmSync(f);
      // 如果正在用这个主题就退回默认
      const s = config.readSettings();
      if ((s.theme || {}).css_name === name) config.writeSettings({ theme: { css_name: '' } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (p === '/api/version' && req.method === 'GET') {
      sendJSON(res, 200, { version: APP_VERSION });
      return;
    }

    // ---- 智能体导入/导出（tar，不压缩）----
    // 注意：必须放在下面的 :id 正则路由之前，否则 export/import 会被当成智能体 id
    if (p === '/api/agents/export' && req.method === 'GET') {
      try {
        // 从 URL 解析 agentId（支持单个智能体导出）
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const agentId = urlObj.searchParams.get('agentId');
        const fname = agentId ? 'rincy-agent-' + agentId + '-' + new Date().toISOString().slice(0, 10) + '.tar' : 'rincy-agents-' + new Date().toISOString().slice(0, 10) + '.tar';
        const buf = await config.exportAgents(agentId || null);
        res.writeHead(200, {
          'Content-Type': 'application/x-tar',
          'Content-Disposition': 'attachment; filename="' + fname + '"',
          'Content-Length': buf.length,
        });
        res.end(buf);
      } catch (e) { sendJSON(res, 500, { error: '导出失败：' + e.message }); }
      return;
    }
    if (p === '/api/agents/import' && req.method === 'POST') {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
      let gotFile = false;
      busboy.on('file', (name, file) => {
        gotFile = true;
        const chunks = [];
        file.on('data', (c) => chunks.push(c));
        file.on('end', () => {
          config.importAgents(Buffer.concat(chunks))
            .then((r) => {
              // 导入包里可能带着别的安装的元灵目录：身份强制归位
              config.ensureMetasoul();
              sendJSON(res, 200, { ok: true, imported: r.imported });
            })
            .catch((e) => sendJSON(res, 400, { error: '导入失败：' + e.message }));
        });
      });
      busboy.on('finish', () => { if (!gotFile) sendJSON(res, 400, { error: '导入失败：没收到文件' }); });
      busboy.on('error', () => sendJSON(res, 400, { error: '导入失败：文件格式不对' }));
      req.pipe(busboy);
      return;
    }
    const m = p.match(/^\/api\/agents\/([^/]+)(\/(history|params|memory-warden|behavior|flags|catchphrases|files|clear|text-fields|model|reset|fork|variant))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[3] || null;
      const meta = config.readAgent(id);
      if (!meta) { sendJSON(res, 404, { error: '找不到这个智能体' }); return; }

      if (action === 'history' && req.method === 'GET') {
        // 查看历史存档（界面"查看历史存档"入口；受 history.visible 控制）
        if (meta.history && meta.history.visible === false) { sendJSON(res, 403, { error: '这个智能体关闭了历史存档查看' }); return; }
        sendJSON(res, 200, { history: memory.readHistory(config.agentDir(id)), variants: memory.variantMeta(config.agentDir(id)) });
        return;
      }
      if (action === 'params' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const next = config.updateAgent(id, { params: body || {} });
        memory.rebuildMemory(config.agentDir(id), next); // context_recent_count 变了，重建分层
        sendJSON(res, 200, { ok: true, agent: next });
        return;
      }
      if (action === 'memory-warden' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const next = config.updateAgent(id, { memory_warden: body || {} });
        memory.rebuildMemory(config.agentDir(id), next);
        sendJSON(res, 200, { ok: true, agent: next });
        return;
      }
      if (action === 'behavior' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const next = config.updateAgent(id, { behavior: body || {} }); // 重渲染 AGENTS.md
        sendJSON(res, 200, { ok: true, agent: next });
        return;
      }
      if (action === 'flags' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const patch = {};
        if (body && typeof body.self_edit === 'boolean') patch.soul = { self_edit: body.self_edit };
        if (body && typeof body.history_visible === 'boolean') patch.history = { visible: body.history_visible };
        if (body && typeof body.deep_think === 'boolean') patch.thinking = { enabled: body.deep_think };
        if (body && typeof body.web_search === 'boolean') patch.websearch = { enabled: body.web_search };
        sendJSON(res, 200, { ok: true, agent: config.updateAgent(id, patch) });
        return;
      }
      if (action === 'catchphrases' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const list = [...(meta.catchphrases || [])];
        const text = String(body?.text || '').trim();
        if (body?.action === 'add' && text) {
          if (!list.includes(text)) list.push(text);
        } else if (body?.action === 'remove' && text) {
          const i = list.indexOf(text);
          if (i >= 0) list.splice(i, 1);
        }
        const beforeFiles = config.capturePersona(config.agentDir(id));
        const next = config.updateAgent(id, { catchphrases: list }); // 重渲染 SOUL.md
        config.logPersonaChanges(next, beforeFiles, config.capturePersona(config.agentDir(id)), '用户');
        sendJSON(res, 200, { ok: true, agent: next });
        return;
      }
      if (action === 'text-fields' && req.method === 'POST') {
        // 文字配置统一接口：按 field 写对应 md 文件
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const mapping = {
          name: 'name',
          description: 'description',
          soul: 'soul_profile',            // 详细人设 → SOUL.md 正文
          address_user: 'address_user',     // 怎么称呼你 → SOUL.md
          speech_style: 'speech_style',     // 说话特征 → SOUL.md
          taboo: 'taboo',                   // 禁忌 → AGENTS.md
          extra_requirements: 'extra_requirements', // 额外要求 → AGENTS.md
        };
        const key = mapping[body?.field];
        if (!key) { sendJSON(res, 400, { error: '不认识的字段: ' + (body?.field || '') }); return; }
        const patch = { [key]: String(body?.value ?? '').trim() };
        const beforeFiles = config.capturePersona(config.agentDir(id));
        const next = config.updateAgent(id, patch); // 重渲染 SOUL.md / AGENTS.md / IDENTITY.md
        config.logPersonaChanges(next, beforeFiles, config.capturePersona(config.agentDir(id)), '用户');
        // 改名字要同时保证 IDENTITY 的 Name 也是新名字
        sendJSON(res, 200, { ok: true, agent: next });
        return;
      }
      if (action === 'model' && req.method === 'POST') {
        // 给当前对话选模型（模型库里的 model_id）
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const mid = String(body?.modelId || '');
        const models = config.readSettings().models;
        if (!mid) { sendJSON(res, 400, { error: '请先选一个模型' }); return; }
        if (!models.some((x) => x.id === mid)) { sendJSON(res, 400, { error: '这个模型已不存在' }); return; }
        sendJSON(res, 200, { ok: true, agent: config.updateAgent(id, { model_id: mid }) });
        return;
      }
      if (action === 'files' && req.method === 'GET') {
        // 查看原始配置文件（高级模式）
        const dir = config.agentDir(id);
        const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
        sendJSON(res, 200, {
          soul: read('SOUL.md'),
          agents: read('AGENTS.md'),
          identity: read('IDENTITY.md'),
          memory: read('memory.md'),
          changes: read('history/changes.md'),
        });
        return;
      }
      if (action === 'variant' && req.method === 'POST') {
        // 切换某条 AI 回复的历史版本（回复分支浏览）：原地替换存档条目并重建记忆
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const n = Number(body && body.n), idx = Number(body && body.idx);
        const agentDir = config.agentDir(id);
        const list = memory.loadVariants(agentDir)[String(n)];
        if (!Array.isArray(list) || !(idx >= 0 && idx < list.length)) { sendJSON(res, 400, { error: '没有这个版本' }); return; }
        if (!memory.replaceEntryByAIIndex(agentDir, n, list[idx])) { sendJSON(res, 400, { error: '这条回复已不存在' }); return; }
        memory.rebuildMemory(agentDir, config.readAgent(id));
        sendJSON(res, 200, { ok: true, entry: list[idx], variants: memory.variantMeta(agentDir) });
        return;
      }
      if (action === 'clear' && req.method === 'POST') {
        // 清空聊天记录（不删人设）
        memory.clearHistory(config.agentDir(id), meta);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (action === 'fork' && req.method === 'POST') {
        // 复制/分支：完整拷贝人设与对话历史，得到独立的新智能体
        // 命名：Rin → Rin.<:1（.<: 是象形的 fork 符号，读作 fork）；再分支持续递增
        try {
          const created = config.duplicateAgent(id);
          sendJSON(res, 200, { ok: true, agent: created });
        } catch (e) { sendJSON(res, 400, { error: e.message }); }
        return;
      }
      if (action === 'reset' && req.method === 'POST') {
        // 元灵重置：不能删除，但可以恢复出厂（清掉被写回/改坏的文件，按内置模板重建）
        if (!meta.builtin || !metasoul.isMetasoul(meta)) { sendJSON(res, 403, { error: '只有元灵支持重置' }); return; }
        fs.rmSync(config.agentDir(id), { recursive: true, force: true });
        config.ensureMetasoul();
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (!action && req.method === 'DELETE') {
        // 删除智能体：元灵（builtin）在 config.deleteAgent 里拒绝
        try {
          config.deleteAgent(id);
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 403, { error: e.message });
        }
        return;
      }
      if (!action && req.method === 'GET') {
        sendJSON(res, 200, { agent: meta });
        return;
      }
      sendJSON(res, 405, { error: '方法不支持' });
      return;
    }
    if (p === '/api/settings') {
      if (req.method === 'GET') { sendJSON(res, 200, { settings: config.readSettings() }); return; }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        sendJSON(res, 200, { ok: true, settings: config.writeSettings(body || {}) });
        return;
      }
    }
    if (p === '/api/models') {
      if (req.method === 'GET') { sendJSON(res, 200, { models: config.readSettings().models }); return; }
      if (req.method === 'POST') {
        // 全局设置里添加一个模型
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
        const m = config.addModel(body || {});
        sendJSON(res, 200, { ok: true, model: m });
        return;
      }
    }
    const mm = p.match(/^\/api\/models\/([^/]+)$/);
    if (mm && req.method === 'DELETE') {
      config.deleteModel(decodeURIComponent(mm[1]));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (mm && (req.method === 'PUT' || req.method === 'PATCH')) {
      // 修改模型
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: '请求格式不对' }); return; }
      try {
        const m = config.updateModel(decodeURIComponent(mm[1]), body || {});
        sendJSON(res, 200, { ok: true, model: m });
      } catch (e) {
        sendJSON(res, 404, { error: e.message });
      }
      return;
    }
    if (p.startsWith('/api/')) { sendJSON(res, 404, { error: '接口不存在' }); return; }
    serveStatic(res, p);
  } catch (e) {
    // 纪律：这里的 catch 是最后防线，绝不能让进程死掉——
    // SSE 已开头就往流里发 error 事件并收尾；没开头才回 500 JSON。
    console.error('[server] 请求处理失败：', e);
    if (res.headersSent) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ message: '服务器出了点问题：' + e.message })}\n\n`); } catch { /* 连接已断 */ }
      try { res.end(); } catch { /* 连接已断 */ }
    } else {
      sendJSON(res, 500, { error: '服务器出了点问题：' + e.message });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Rincy 已启动：http://127.0.0.1:${PORT}`);
});

// ---------- 进程级保命（聊天应用的纪律：任何情况都不许整个服务死掉） ----------
// 背景：SSE 流式中客户端断开（刷新页面/中止请求）时，往已销毁的套接字写数据
// 会触发流上的 error 事件——它不在任何 try/catch 的调用栈里，直接杀死进程。
// 设备上实测：服务反复崩溃-复活，用户点发送正好撞上死窗口，全部失败。
process.on('uncaughtException', (e) => {
  console.error('[server] 未捕获异常（已吞掉，服务继续）：', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[server] 未处理的 Promise 拒绝（已吞掉，服务继续）：', e);
});
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { socket.destroy(); }
});
