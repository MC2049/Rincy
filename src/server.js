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

const PORT = Number(process.env.RINCY_PORT || 3000);
const WEB_DIR = path.join(__dirname, '..', 'web');

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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
  const text = String(body?.message || '').trim();
  if (!text) { sendJSON(res, 400, { error: '消息不能为空' }); return; }

  const dir = config.agentDir(meta.id);

  // ① 用户消息进完整本地存档（聊天框记录的来源；只是不发给 API，除非孟婆关闭）
  memory.appendHistory(dir, '用户', text);

  const messages = buildMessages(meta, text);
  const params = config.clampParams(meta.params);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // 这个对话选用的模型配置（模型库里的某条）
  const modelConf = config.getAgentModel(meta);
  if (!modelConf) {
    send('error', { message: '这个对话还没选模型。到"设置"里添加并选一个模型，再聊。' });
    memory.rebuildMemory(dir, meta);
    res.end();
    return;
  }

  let full = '';
  try {
    full = await adapter.chatStream({
      modelConf,
      messages,
      params,
      onDelta: (d) => send('delta', { text: d }),
      onThought: (t) => send('thought', { text: t }),
    });
    // ② 回复完成后：AI 回复进完整存档
    memory.appendHistory(dir, meta.name, full);
    send('done', { full });
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
    // ---- 智能体导入/导出（tar，不压缩）----
    // 注意：必须放在下面的 :id 正则路由之前，否则 export/import 会被当成智能体 id
    if (p === '/api/agents/export' && req.method === 'GET') {
      try {
        const buf = await config.exportAgents();
        res.writeHead(200, {
          'Content-Type': 'application/x-tar',
          'Content-Disposition': 'attachment; filename="rincy-agents-' + new Date().toISOString().slice(0, 10) + '.tar"',
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
            .then((r) => sendJSON(res, 200, { ok: true, imported: r.imported }))
            .catch((e) => sendJSON(res, 400, { error: '导入失败：' + e.message }));
        });
      });
      busboy.on('finish', () => { if (!gotFile) sendJSON(res, 400, { error: '导入失败：没收到文件' }); });
      busboy.on('error', () => sendJSON(res, 400, { error: '导入失败：文件格式不对' }));
      req.pipe(busboy);
      return;
    }
    const m = p.match(/^\/api\/agents\/([^/]+)(\/(history|params|memory-warden|behavior|flags|catchphrases|files|clear|text-fields|model))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[3] || null;
      const meta = config.readAgent(id);
      if (!meta) { sendJSON(res, 404, { error: '找不到这个智能体' }); return; }

      if (action === 'history' && req.method === 'GET') {
        // 查看历史存档（界面"查看历史存档"入口；受 history.visible 控制）
        if (!meta.history?.visible) { sendJSON(res, 403, { error: '这个智能体关闭了历史存档查看' }); return; }
        sendJSON(res, 200, { history: memory.readHistory(config.agentDir(id)) });
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
        const next = config.updateAgent(id, { catchphrases: list }); // 重渲染 SOUL.md
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
        const next = config.updateAgent(id, patch); // 重渲染 SOUL.md / AGENTS.md / IDENTITY.md
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
        });
        return;
      }
      if (action === 'clear' && req.method === 'POST') {
        // 清空聊天记录（不删人设）
        memory.clearHistory(config.agentDir(id), meta);
        sendJSON(res, 200, { ok: true });
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
    sendJSON(res, 500, { error: '服务器出了点问题：' + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Rincy 已启动：http://127.0.0.1:${PORT}`);
});
