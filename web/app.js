// app.js — Rincy 前端
// 三屏布局（菜单/对话/调试）；调试屏每一项都对应后端真实参数，改动实时生效。
// 滑块 + 编辑框双向绑定；UI 只显示人话标签，参数名一个字不露。
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const app = $('#app');

const state = { agents: [], currentId: null, paramDefs: [], settings: null, params: {}, agent: null };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败（HTTP ${res.status}）`);
  return json;
}

// ---------- 折叠交互（状态存 localStorage，刷新保持） ----------
function isNarrow() { return window.matchMedia('(max-width: 767px)').matches; }

function setMenu(open, persist = true) {
  app.classList.toggle('menu-open', open);
  $('#btn-menu-arrow').textContent = open ? '‹' : '›';
  if (persist) saveState();
  syncOverlay();
}
function setDebug(open, persist = true) {
  app.classList.toggle('debug-open', open);
  if (persist) saveState();
  syncOverlay();
}
// 手机端互斥：开一个抽屉时另一个自动关
function openMenu() { setMenu(true); if (isNarrow()) setDebug(false); }
function openDebug() { setDebug(true); if (isNarrow()) setMenu(false); }

// 手机端：任一抽屉打开就显示遮罩（盖住对话屏），全关则隐藏
function syncOverlay() {
  const open = app.classList.contains('menu-open') || app.classList.contains('debug-open');
  $('#overlay').hidden = !(isNarrow() && open);
}

function saveState() {
  localStorage.setItem('rincy-ui', JSON.stringify({
    menuOpen: app.classList.contains('menu-open'),
    debugOpen: app.classList.contains('debug-open'),
  }));
}

function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('rincy-ui') || 'null'); } catch { saved = null; }
  const menuOpen = typeof saved?.menuOpen === 'boolean' ? saved.menuOpen : false;
  const debugOpen = typeof saved?.debugOpen === 'boolean' ? saved.debugOpen : false;
  setMenu(menuOpen, false);
  setDebug(debugOpen, false);
}

// ---------- 菜单屏：智能体列表（头像 + 名字 + 状态小圆点） ----------
function renderAgents() {
  const list = $('#agent-list');
  list.innerHTML = '';
  if (!state.agents.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = '还没有智能体，点 + 创建';
    list.append(empty);
  }
  for (const a of state.agents) {
    const item = document.createElement('button');
    item.className = 'agent-item' + (a.id === state.currentId ? ' active' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = a.name.slice(0, 1);
    const dot = document.createElement('span');
    dot.className = 'dot dot-ok'; // 绿色 = 正常
    avatar.append(dot);

    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = a.name;

    item.append(avatar, name);
    item.addEventListener('click', () => selectAgent(a.id).catch((e) => alert(e.message)));
    list.append(item);
  }
}

// ---------- 智能体选择与调试屏渲染 ----------
async function selectAgent(id) {
  state.currentId = id;
  const [{ agent }, { settings }] = await Promise.all([api(`/api/agents/${id}`), api('/api/settings')]);
  state.settings = settings;
  state.agent = agent;
  state.params = agent.params || {};
  $('#chat-title').textContent = agent.name;
  renderAgents();
  renderSliders();
  renderSwitches(agent);
  renderChoices(agent);
  renderTextFields(agent);
  renderCatchphrases(agent.catchphrases || []);
  renderAgentModel();
  await loadHistory();
}

// ---------- 滑块 + 编辑框双向绑定（改动实时生效，不点保存） ----------
let saveTimer = null;
function queueParamSave(name, value) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.currentId) return;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/params`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [name]: Number(value) }),
      });
      state.params = agent.params;
    } catch (e) { console.error(e.message); }
  }, 300);
}

function renderSliders() {
  for (const p of state.paramDefs) {
    const els = $$(`[data-param="${p.name}"]`);
    if (!els.length) continue;
    for (const el of els) {
      el.min = p.min; el.max = p.max; el.step = p.step;
      el.value = state.params[p.name] ?? p.def;
    }
  }
}

function bindSliders() {
  for (const p of state.paramDefs) {
    const slider = document.querySelector(`input[type="range"][data-param="${p.name}"]`);
    const num = document.querySelector(`input[type="number"][data-param="${p.name}"]`);
    if (!slider || !num) continue;

    const fmt = (v) => (Number(slider.step) < 1 ? Number(v).toFixed(2) : String(Math.round(v)));

    // 双向绑定：滑块拖动 → 编辑框同步；编辑框输入 → 滑块同步（越界拉回）
    slider.addEventListener('input', () => { num.value = fmt(slider.value); });
    num.addEventListener('input', () => {
      let v = Number(num.value);
      if (!Number.isFinite(v)) return;
      v = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
      slider.value = v;
    });

    // 松手记一条设定历史（300ms 防抖，拖完只加一条）
    let recordTimer = null;
    const record = () => {
      clearTimeout(recordTimer);
      recordTimer = setTimeout(() => {
        const mid = (Number(slider.min) + Number(slider.max)) / 2;
        const word = Number(slider.value) >= mid ? p.right : p.left;
        addHistory('刚刚', `${p.label}调到「${word}」`);
      }, 300);
    };
    slider.addEventListener('change', () => { queueParamSave(p.name, slider.value); record(); });
    num.addEventListener('change', () => { queueParamSave(p.name, num.value); record(); });
  }
}

// ---------- 开关（孟婆 / 权限） ----------
function renderSwitches(agent) {
  $('#sw-mengpo').checked = agent.memory_warden?.enabled ?? false;
  $('#speed-row').hidden = !$('#sw-mengpo').checked; // 孟婆关闭时遗忘速度不显示
  $('#sel-speed').value = agent.memory_warden?.speed || 'standard';
  $('#sw-self-edit').checked = agent.soul?.self_edit ?? false;
  $('#sw-history-visible').checked = agent.history?.visible ?? true;
}

function bindSwitches() {
  $('#sw-mengpo').addEventListener('change', async () => {
    $('#speed-row').hidden = !$('#sw-mengpo').checked;
    if (!state.currentId) return;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/memory-warden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: $('#sw-mengpo').checked }),
      });
      addHistory('刚刚', $('#sw-mengpo').checked ? '开启了孟婆系统' : '关闭了孟婆系统');
      state.params = agent.params;
    } catch (e) { alert(e.message); }
  });
  $('#sel-speed').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      await api(`/api/agents/${state.currentId}/memory-warden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed: $('#sel-speed').value }),
      });
      const word = { never: '不遗忘', slow: '较慢', standard: '标准', fast: '较快' }[$('#sel-speed').value];
      addHistory('刚刚', `遗忘速度调到「${word}」`);
    } catch (e) { alert(e.message); }
  });
  $('#sw-self-edit').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      await api(`/api/agents/${state.currentId}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ self_edit: $('#sw-self-edit').checked }),
      });
      addHistory('刚刚', $('#sw-self-edit').checked ? '允许修改人设' : '禁止修改人设');
    } catch (e) { alert(e.message); }
  });
  $('#sw-history-visible').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      await api(`/api/agents/${state.currentId}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history_visible: $('#sw-history-visible').checked }),
      });
    } catch (e) { alert(e.message); }
  });
}

// ---------- 三档选择（行为：表情/主动提问/回答格式） ----------
function renderChoices(agent) {
  const b = agent.behavior || {};
  $$('[data-behavior]').forEach((row) => {
    const key = row.dataset.behavior;
    row.querySelectorAll('.tag-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === (b[key] ?? ''));
    });
  });
}

function bindChoices() {
  $$('[data-behavior]').forEach((row) => {
    const key = row.dataset.behavior;
    row.querySelectorAll('.tag-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        row.querySelectorAll('.tag-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (!state.currentId) return;
        try {
          await api(`/api/agents/${state.currentId}/behavior`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: btn.dataset.value }),
          });
          addHistory('刚刚', `${row.previousElementSibling ? row.previousElementSibling.textContent : key}改为「${btn.textContent}」`);
        } catch (e) { alert(e.message); }
      });
    });
  });
}

// ---------- 口头禅（添加后显示为可删除标签；写进人设文件） ----------
function renderCatchphrases(list) {
  const box = $('#catch-tags');
  box.innerHTML = '';
  for (const phrase of list) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.textContent = phrase;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', async () => {
      if (!state.currentId) return;
      try {
        const { agent } = await api(`/api/agents/${state.currentId}/catchphrases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', text: phrase }),
        });
        renderCatchphrases(agent.catchphrases || []);
      } catch (e) { alert(e.message); }
    });
    chip.append(label, del);
    box.append(chip);
  }
}

async function addCatchphrase() {
  const input = $('#catch-input');
  const text = input.value.trim();
  if (!text || !state.currentId) return;
  try {
    const { agent } = await api(`/api/agents/${state.currentId}/catchphrases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', text }),
    });
    input.value = '';
    renderCatchphrases(agent.catchphrases || []);
  } catch (e) { alert(e.message); }
}

// ---------- 文字配置（身份/说话方式/行为文本域） ----------
// blur 时保存（打字不下发），保存成功在字段旁闪一下"已保存"
const textFieldToAgentKey = {
  name: 'name',
  description: 'description',
  soul: 'soul_profile',
  address_user: 'address_user',
  speech_style: 'speech_style',
  taboo: 'taboo',
  extra_requirements: 'extra_requirements',
};

function renderTextFields(agent) {
  const a = agent || {};
  const v = {
    name: a.name || '',
    description: a.description || '',
    soul: a.soul_profile || '',
    address_user: a.address_user || '',
    speech_style: a.speech_style || '',
    taboo: a.taboo || '',
    extra_requirements: a.extra_requirements || '',
  };
  $$('[data-textfield]').forEach((el) => {
    const k = el.dataset.textfield;
    if (k in v) el.value = v[k];
  });
}

function flashSaved(el) {
  const hint = el.closest('.field')?.querySelector('.saved-hint');
  if (!hint) return;
  hint.textContent = '已保存';
  clearTimeout(hint._t);
  hint._t = setTimeout(() => { hint.textContent = ''; }, 1500);
}

function bindTextField(el) {
  el.addEventListener('blur', async () => {
    if (!state.currentId) { flashSaved(el); return; }
    const field = el.dataset.textfield;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/text-fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value: el.value }),
      });
      state.agent = agent;
      state.agents = state.agents
        .map((x) => (x.id === agent.id ? agent : x))
        .filter(Boolean);
      // 改名字：菜单列表 + 对话标题立即刷新，不等切智能体
      if (field === 'name') {
        $('#chat-title').textContent = agent.name;
        renderAgents();
      }
      flashSaved(el);
    } catch (e) { alert(e.message); }
  });
}

function bindTextFields() {
  $$('[data-textfield]').forEach(bindTextField);
}

// ---------- 系统：当前对话选用的模型（模型库在全局设置里管理） ----------
function renderAgentModel() {
  const sel = $('#sel-agent-model');
  sel.innerHTML = '';
  const models = state.settings?.models || [];
  if (!models.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '（还没添加模型，去设置里加）';
    sel.append(o);
  } else {
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = (m.provider === 'local' ? '本地·' : '云端·') + (m.name || m.model || m.id);
      sel.append(o);
    }
  }
  sel.value = state.agent?.model_id || '';
}

function bindAgentModel() {
  $('#sel-agent-model').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: $('#sel-agent-model').value }),
      });
      state.agent = agent;
    } catch (e) { alert(e.message); }
  });
}

// ---------- 全局设置（主题色 + 模型库） ----------
const THEME_PRESETS = {
  default: '#6366f1', ocean: '#0ea5e9', forest: '#10b981',
  sunset: '#f59e0b', rose: '#ec4899',
};

function applyTheme(theme) {
  const t = theme || { mode: 'preset', preset: 'default', accent: '' };
  const accent = t.mode === 'custom' && t.accent ? t.accent : (THEME_PRESETS[t.preset] || THEME_PRESETS.default);
  document.documentElement.style.setProperty('--accent', accent);
}

function renderSettingsDialog() {
  renderThemeUI();
  renderModelList();
}

function renderThemeUI() {
  const t = state.settings?.theme || {};
  $$('#theme-row .swatch').forEach((sw) => {
    sw.classList.toggle('active', t.mode === 'preset' && sw.dataset.preset === t.preset);
  });
  $('#theme-custom-chec').checked = t.mode === 'custom';
  $('#theme-custom-input').value = t.accent || (THEME_PRESETS[t.preset] || THEME_PRESETS.default);
}

function saveTheme(patch) {
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: { ...(state.settings?.theme || {}), ...patch } }),
  }).then(({ settings }) => {
    state.settings = settings;
    applyTheme(settings.theme);
    renderThemeUI();
    const h = $('#theme-saved');
    h.textContent = '已保存';
    clearTimeout(h._t); h._t = setTimeout(() => { h.textContent = ''; }, 1500);
  }).catch((e) => alert(e.message));
}

function renderModelList() {
  const box = $('#model-list');
  box.innerHTML = '';
  const models = state.settings?.models || [];
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = '还没有模型，点"添加模型"。';
    box.append(empty);
    return;
  }
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'model-item';
    const info = document.createElement('div');
    info.className = 'model-info';
    const nm = document.createElement('div');
    nm.className = 'model-name';
    nm.textContent = (m.provider === 'local' ? '本地' : '云端') + ' · ' + (m.name || m.model || '(未命名)');
    const sub = document.createElement('div');
    sub.className = 'model-sub';
    sub.textContent = m.model || m.baseUrl || '';
    info.append(nm, sub);
    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.textContent = '✎';
    edit.title = '编辑';
    edit.addEventListener('click', () => openEditModelDialog(m));
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', async () => {
      if (!confirm('删除这个模型？用它对话的智能体会失效。')) return;
      await modelDelete(m.id);
    });
    row.append(info, edit, del);
    box.append(row);
  }
}

async function modelDelete(id) {
  await api(`/api/models/${id}`, { method: 'DELETE' });
  const { settings } = await api('/api/settings');
  state.settings = settings;
  renderModelList();
  renderAgentModel();
}

function fillModelForm({ provider, base, model, name }) {
  $('#am-base').value = base || $('#am-base').value;
  $('#am-model').value = model || $('#am-model').value;
  $('#am-name').value = name || '';
  $('#am-base').dataset.provider = provider || 'cloud';
}

let amEditId = null; // null = 添加模式；非 null = 正在编辑的模型 id

function openEditModelDialog(m) {
  amEditId = m.id;
  $('#add-model-dialog h3').textContent = '编辑模型';
  $('#am-name').value = m.name || '';
  $('#am-base').value = m.baseUrl || '';
  $('#am-key').value = m.apiKey || '';
  $('#am-model').value = m.model || '';
  $('#am-base').dataset.provider = m.provider || 'cloud';
  $('#add-model-dialog').showModal();
}

async function saveNewModel() {
  const name = $('#am-name').value.trim();
  const baseUrl = $('#am-base').value.trim();
  const apiKey = $('#am-key').value.trim();
  const model = $('#am-model').value.trim();
  if (!baseUrl || !model) { alert('接口地址和模型名必填'); return; }
  const provider = $('#am-base').dataset.provider === 'local' ? 'local' : 'cloud';
  if (amEditId) {
    // 编辑已有模型
    await api(`/api/models/${encodeURIComponent(amEditId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, baseUrl, apiKey, model }),
    });
  } else {
    await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, baseUrl, apiKey, model }),
    });
  }
  amEditId = null;
  const { settings } = await api('/api/settings');
  state.settings = settings;
  renderModelList();
  renderAgentModel();
  $('#add-model-dialog').close();
}

// 读全局设置到 state，供选模型/主题/模型库用
async function loadSettings() {
  const { settings } = await api('/api/settings');
  state.settings = settings;
}

function openSettingsDialog() {
  renderSettingsDialog();
  $('#settings-dialog').showModal();
}

function bindSettingsDialog() {
  // 主题：预置色板
  $$('#theme-row .swatch').forEach((sw) => {
    sw.addEventListener('click', () => saveTheme({ mode: 'preset', preset: sw.dataset.preset, accent: '' }));
  });
  // 主题：自定义主色开关
  $('#theme-custom-chec').addEventListener('change', () => {
    if ($('#theme-custom-chec').checked) {
      saveTheme({ mode: 'custom', accent: $('#theme-custom-input').value });
    } else {
      saveTheme({ mode: 'preset', accent: '' });
    }
  });
  $('#theme-custom-input').addEventListener('input', () => {
    if ($('#theme-custom-chec').checked) saveTheme({ accent: $('#theme-custom-input').value });
  });
}

function bindAddModelDialog() {
  $('#btn-add-model').addEventListener('click', () => {
    // 打开前用当前选中的模型信息预填（默认用 NVIDIA 模板）
    amEditId = null;
    $('#add-model-dialog h3').textContent = '添加模型';
    $('#am-key').value = '';
    fillModelForm({ provider: 'cloud', base: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4-flash-0731', name: '' });
    $('#add-model-dialog').showModal();
  });
  // 预置模板点击 → 填字段
  $$('#preset-row .preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      $$('#preset-row .preset-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      $('#am-base').value = card.dataset.base || '';
      $('#am-model').value = card.dataset.model || '';
      $('#am-name').value = '';
      $('#am-base').dataset.provider = card.dataset.provider || 'cloud';
    });
  });
  $('#btn-am-save').addEventListener('click', () => saveNewModel().catch((e) => alert(e.message)));
}

// ---------- 聊天记录（从完整本地存档渲染） ----------
async function loadHistory() {
  if (!state.currentId) return;
  const { history } = await api(`/api/agents/${state.currentId}/history`).catch(() => ({ history: '' }));
  const msgs = $('#chat-messages');
  msgs.innerHTML = '';
  let cur = null;
  const bubbles = [];
  for (const line of String(history).split('\n')) {
    const m = line.match(/^## \[([^\]]*)\] (.+)$/);
    if (m) { if (cur) bubbles.push(cur); cur = { who: m[2].trim(), text: '' }; }
    else if (cur && line.trim()) cur.text += (cur.text ? '\n' : '') + line.trim();
  }
  if (cur) bubbles.push(cur);
  for (const b of bubbles) addBubble(b.who === '用户' ? 'me' : 'ai', b.text);
  if (!msgs.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '还没有聊天记录，说第一句话吧';
    msgs.append(empty);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// 只有用户已在底部附近（距底 <50px）时才自动滚到底——往上翻不打断
function stickToBottom() {
  const m = $('#chat-messages');
  if (m.scrollHeight - m.scrollTop - m.clientHeight < 50) m.scrollTop = m.scrollHeight;
}

// ---------- 安全的轻量 markdown 渲染 ----------
// 零第三方依赖。输入先整体 HTML 转义（防 XSS），再做词法替换。
// 重点支持代码块（围栏 + 行内），也照顾标题/列表/粗斜体/引用/安全链接。
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 行内：`code`、**粗**、*斜*、[链接](http(s))（只放行 http/https）
function inlineMd(s) {
  let t = s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

function renderMarkdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let inCode = false, codeBuf = [];
  const flushCode = () => {
    if (!codeBuf.length) return;
    out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');
    codeBuf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fence = ln.match(/^```(\S*)/);
    if (fence) {
      if (inCode) { inCode = false; flushCode(); }
      else { flushCode(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }
    if (!ln.trim()) { out.push(''); continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    const bq = ln.match(/^&gt;\s?(.*)$/);
    if (bq) { out.push('<blockquote>' + inlineMd(bq[1]) + '</blockquote>'); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { out.push('<li>' + inlineMd(ln.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { out.push('<li>' + inlineMd(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue; }
    out.push(inlineMd(ln));
  }
  if (inCode) codeBuf.push('');
  flushCode();
  return out.join('\n');
}

function addBubble(who, text) {
  const msgs = $('#chat-messages');
  const hint = msgs.querySelector('.empty-hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = 'bubble ' + (who === 'me' ? 'me' : 'ai');
  const t = document.createElement('div');
  t.className = 'text';
  // 用户消息保持纯文本；AI 消息渲染 markdown（历史记录里 AI 内容也正确显示）
  if (who === 'me') t.textContent = text;
  else t.innerHTML = renderMarkdown(text) || '…';
  div.append(t);
  msgs.append(div);
  msgs.scrollTop = msgs.scrollHeight;
  return t;
}

// ---------- 聊天（流式） ----------
let replying = false;
async function send() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || replying) return;
  if (!state.currentId) { alert('先在左边创建一个智能体'); return; }
  input.value = '';
  addBubble('me', text);

  replying = true;
  const dot = $('#chat-dot');
  dot.className = 'dot dot-run'; // 蓝色 = 进行中
  // AI 气泡带"思考区 + 回答区"，思考用浅色小字展示在回答上方
  const aiBubble = (() => {
    const msgs = $('#chat-messages');
    const hint = msgs.querySelector('.empty-hint');
    if (hint) hint.remove();
    const div = document.createElement('div');
    div.className = 'bubble ai';
    const th = document.createElement('div');
    th.className = 'thought';
    th.hidden = true;
    th.innerHTML = '<span class="thought-label">思考中…</span> <span class="thought-text"></span>';
    const t = document.createElement('div');
    t.className = 'text';
    t.textContent = '…';
    div.append(th, t);
    msgs.append(div);
    const thText = th.querySelector('.thought-text');
    msgs.scrollTop = msgs.scrollHeight;
    return { div, th, thText, t };
  })();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: state.currentId, message: text }),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `请求失败（HTTP ${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '', curEvent = '', curLines;
    const handleData = (payload) => {
      const j = JSON.parse(payload);
      if (curEvent === 'thought' && j.text) {
        aiBubble.th.hidden = false;
        aiBubble.thText.textContent += j.text;
        stickToBottom();
      } else if (curEvent === 'delta' && j.text) {
        full += j.text; aiBubble.t.innerHTML = renderMarkdown(full); stickToBottom();
      } else if (j.message) {
        aiBubble.t.textContent = j.message; // 人话报错，不吞消息
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      curLines = buf.split('\n');
      buf = curLines.pop() || '';
      for (const line of curLines) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('event:')) { curEvent = t.slice(6).trim(); continue; }
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { handleData(payload); } catch { /* 忽略解析不了的行 */ }
      }
    }
    if (!full && aiBubble.t.textContent === '…' && aiBubble.thText.textContent === '') aiBubble.t.textContent = '（没有收到回复）';
  } catch (e) {
    aiBubble.t.textContent = e.message;
  } finally {
    replying = false;
    dot.className = 'dot dot-ok'; // 绿色 = 正常
  }
}

// ---------- 新建智能体 ----------
async function createAgent() {
  const name = $('#new-agent-name').value.trim();
  const desc = $('#new-agent-desc').value.trim();
  if (!name) { alert('先给智能体起个名字'); return; }
  const { agent } = await api('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: desc }),
  });
  $('#new-agent-name').value = '';
  $('#new-agent-desc').value = '';
  $('#new-agent-dialog').close();
  await refreshAgents();
  await selectAgent(agent.id);
}

async function refreshAgents() {
  const { agents } = await api('/api/agents');
  state.agents = agents;
  renderAgents();
}

// ---------- 查看原始配置文件 / 设定历史 ----------
async function viewFiles() {
  if (!state.currentId) return;
  const { soul, agents, memory } = await api(`/api/agents/${state.currentId}/files`);
  $('#files-content').textContent = [soul, agents, memory].filter(Boolean).join('\n\n---\n\n') || '（还没有内容）';
  $('#files-dialog').showModal();
}

function addHistory(time, text) {
  const tl = $('#timeline');
  const item = document.createElement('div');
  item.className = 'tl-item';
  const timeSpan = document.createElement('span');
  timeSpan.className = 'tl-time';
  timeSpan.textContent = time;
  item.append(timeSpan);
  item.append(document.createTextNode(text));
  tl.prepend(item);
}

// ---------- 初始化 ----------
async function init() {
  const { params } = await api('/api/params');
  state.paramDefs = params;

  loadState();
  bindSliders();
  bindSwitches();
  bindChoices();
  bindAgentModel();
  bindTextFields();
  bindSettingsDialog();
  bindAddModelDialog();
  await loadSettings();
  applyTheme(state.settings?.theme);

  $('#btn-menu-toggle').addEventListener('click', () => {
    app.classList.contains('menu-open') ? setMenu(false) : openMenu();
  });
  $('#btn-menu-arrow').addEventListener('click', () => {
    app.classList.contains('menu-open') ? setMenu(false) : openMenu();
  });
  $('#btn-debug-toggle').addEventListener('click', () => {
    app.classList.contains('debug-open') ? setDebug(false) : openDebug();
  });
  $('#btn-debug-close').addEventListener('click', () => setDebug(false));
  $('#overlay').addEventListener('click', () => { setMenu(false); setDebug(false); });

  $('#btn-send').addEventListener('click', send);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });

  $('#btn-new').addEventListener('click', () => $('#new-agent-dialog').showModal());
  $('#btn-new-create').addEventListener('click', () => createAgent().catch((e) => alert(e.message)));
  $('#btn-settings').addEventListener('click', openSettingsDialog); // 设置 = 全局设置

  $('#btn-catch-add').addEventListener('click', addCatchphrase);
  $('#catch-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCatchphrase(); });

  $('#btn-view-config').addEventListener('click', () => viewFiles().catch((e) => alert(e.message)));

  await refreshAgents();
  if (state.agents.length) await selectAgent(state.agents[0].id);
}

init().catch((e) => {
  document.body.innerHTML = `<p style="color:#c00;padding:20px;">启动失败：${e.message}</p>`;
});
