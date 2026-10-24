// app.js — Rincy 前端
// 三屏布局（菜单/对话/调试）；调试屏每一项都对应后端真实参数，改动实时生效。
// 滑块 + 编辑框双向绑定；UI 只显示人话标签，参数名一个字不露。
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const app = $('#app');

const state = { agents: [], currentId: null, paramDefs: [], settings: null, params: {}, agent: null };

// ---------- i18n：.lang 语言包（内置 zh-CN/en-US + 用户导入） ----------
// 字典 = 内置 zh-CN 打底 + 当前语言覆盖；缺键时回落中文，再回落键名
const i18nState = { lang: 'zh-CN', dict: {}, base: {} };

function t(key, vars) {
  let s = i18nState.dict[key] !== undefined ? i18nState.dict[key] : (i18nState.base[key] !== undefined ? i18nState.base[key] : key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

async function loadLangDict(code) {
  i18nState.lang = code || 'zh-CN';
  const [cur, base] = await Promise.all([
    api('/api/langs/' + encodeURIComponent(i18nState.lang)).catch(() => ({ dict: {} })),
    api('/api/langs/zh-CN').catch(() => ({ dict: {} })),
  ]);
  i18nState.dict = cur.dict || {};
  i18nState.base = base.dict || {};
}

// 把字典铺到静态 DOM：data-i18n=文本 / data-i18n-ph=占位符 / data-i18n-title=悬停提示
function applyI18n() {
  document.documentElement.lang = i18nState.lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

async function changeLanguage(code) {
  const { settings } = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: code }),
  });
  state.settings = settings;
  await loadLangDict(settings.language);
  applyI18n();
  renderLangList(); // 选项里的语言名要用新字典里的称呼
  await refreshAgents();
  if (state.agent) renderAgentModel();
}

function renderLangList() {
  const sel = $('#sel-lang');
  const current = (state.settings && state.settings.language) || 'zh-CN';
  api('/api/langs').then(({ langs }) => {
    sel.innerHTML = '';
    for (const l of langs) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name + (l.custom ? ' ⭐' : '');
      sel.append(o);
    }
    sel.value = current;
  }).catch(() => {});
}

async function api(path, opts) {
  // 15 秒兜底：服务无响应（常见于应用被系统后台冻结）时快速失败并提示，
  // 绝不让 init 无声挂住、把整个界面卡成"点什么都不动"
  let ctrl = null, timer = null;
  if (typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    timer = setTimeout(function () { ctrl.abort(); }, 15000);
    opts = Object.assign({}, opts, { signal: ctrl.signal });
  }
  try {
    const res = await fetch(path, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || t('common.request_fail', { code: res.status }));
    return json;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(t('common.svc_no_reply'));
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const menuOpen = typeof (saved && saved.menuOpen) === 'boolean' ? saved.menuOpen : false;
  const debugOpen = typeof (saved && saved.debugOpen) === 'boolean' ? saved.debugOpen : false;
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
    empty.textContent = t('menu.empty');
    list.append(empty);
  }
  // 元灵（内置）置顶，其余按创建时间倒序（后端已排好）
  const sorted = [...state.agents].sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
  for (const a of sorted) {
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

    if (a.builtin) {
      const badge = document.createElement('span');
      badge.className = 'builtin-badge';
      badge.textContent = t('menu.builtin_badge');
      item.append(badge);
    }

    const expBtn = document.createElement('button');
    expBtn.className = 'icon-btn small';
    expBtn.style.marginLeft = 'auto';
    expBtn.textContent = '↓';
    expBtn.title = t('common.export_agent');
    expBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open('/api/agents/export?agentId=' + encodeURIComponent(a.id), '_blank');
    });
    item.append(expBtn);

    // 元灵不能删（后端也会拒绝），只有普通智能体显示删除按钮
    if (!a.builtin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn small del-agent';
      delBtn.textContent = '×';
      delBtn.title = t('common.delete_agent_title');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAgentItem(a).catch((err) => alert(err.message));
      });
      item.append(delBtn);
    }

    item.addEventListener('click', () => selectAgent(a.id).catch((e) => alert(e.message)));
    list.append(item);
  }
}

async function deleteAgentItem(a) {
  if (!confirm(t('common.confirm_delete_agent', { name: a.name }))) return;
  const rec = streams.get(a.id);
  if (rec && !rec.finished) { rec.stopRequested = true; if (rec.abort) rec.abort.abort(); streams.delete(a.id); }
  await api('/api/agents/' + encodeURIComponent(a.id), { method: 'DELETE' });
  await refreshAgents();
  if (state.currentId === a.id) {
    state.currentId = null;
    state.agent = null;
    $('#chat-title').textContent = '';
    $('#chat-messages').innerHTML = '';
    const next = [...state.agents].sort((x, y) => (y.builtin ? 1 : 0) - (x.builtin ? 1 : 0))[0];
    if (next) await selectAgent(next.id);
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
      el.value = state.params[p.name] !== undefined ? state.params[p.name] : p.def;
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
        const word = Number(slider.value) >= mid
          ? t('param.' + p.name + '.right')
          : t('param.' + p.name + '.left');
        addHistory(t('common.just_now'), t('hist.param_set', { label: t('param.' + p.name + '.label'), word }));
      }, 300);
    };
    slider.addEventListener('change', () => { queueParamSave(p.name, slider.value); record(); });
    num.addEventListener('change', () => { queueParamSave(p.name, num.value); record(); });
  }
}

// ---------- 开关（孟婆 / 权限） ----------
function renderSwitches(agent) {
  $('#sw-mengpo').checked = (agent.memory_warden && agent.memory_warden.enabled) === true;
  $('#speed-row').hidden = !$('#sw-mengpo').checked; // 孟婆关闭时遗忘速度不显示
  $('#sel-speed').value = (agent.memory_warden && agent.memory_warden.speed) || 'standard';
  $('#sw-self-edit').checked = (agent.soul && agent.soul.self_edit) === true;
  $('#sw-history-visible').checked = (agent.history && agent.history.visible) !== false;
  $('#sw-deep-think').checked = !(agent.thinking && agent.thinking.enabled === false);
  $('#sw-web-search').checked = !!(agent.websearch && agent.websearch.enabled === true);
  const rm = $('#btn-reset-metasoul'); if (rm) rm.hidden = !agent.builtin; // 只有元灵显示重置
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
      addHistory(t('common.just_now'), t($('#sw-mengpo').checked ? 'memory.warden.on' : 'memory.warden.off'));
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
      addHistory(t('common.just_now'), t('memory.speed_set', { word: t('memory.speed.' + $('#sel-speed').value) }));
    } catch (e) { alert(e.message); }
  });
  $('#sw-web-search').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ web_search: $('#sw-web-search').checked }),
      });
      state.agent = agent;
      addHistory(t('common.just_now'), t('perm.web_search'));
    } catch (e) { alert(e.message); }
  });
  $('#sw-deep-think').addEventListener('change', async () => {
    if (!state.currentId) return;
    try {
      const { agent } = await api(`/api/agents/${state.currentId}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deep_think: $('#sw-deep-think').checked }),
      });
      state.agent = agent;
      addHistory(t('common.just_now'), t($('#sw-deep-think').checked ? 'perm.deep_think' : 'perm.deep_think'));
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
      addHistory(t('common.just_now'), t($('#sw-self-edit').checked ? 'behavior.self_edit.on' : 'behavior.self_edit.off'));
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
      btn.classList.toggle('active', btn.dataset.value === (b[key] !== undefined ? b[key] : ''));
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
          addHistory(t('common.just_now'), t('behavior.changed', { field: row.previousElementSibling ? row.previousElementSibling.textContent : key, value: btn.textContent }));
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
    del.title = t('common.delete');
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
  const hint = (el.closest('.field') && el.closest('.field').querySelector('.saved-hint'));
  if (!hint) return;
  hint.textContent = t('common.saved');
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
  const models = (state.settings && state.settings.models) || [];
  if (!models.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = t('system.model_empty');
    sel.append(o);
  } else {
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = (m.provider === 'local' ? t('system.local_short') : t('system.cloud_short')) + (m.name || m.model || m.id);
      sel.append(o);
    }
  }
  sel.value = (state.agent && state.agent.model_id) || '';
  // 元灵没显式选模型时，后端会自动继承模型库里第一个可用模型——如实显示
  if ((state.agent && state.agent.builtin) && !(state.agent && state.agent.model_id) && models.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = t('system.model_auto');
    sel.append(o);
    sel.value = '';
  }
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

// ---------- 颜色集（color set）：主题色的升级形态 ----------
// 一个颜色集 = 一整束颜色变量（背景/面板/文本/边框/主色），相当于一个 class。
// 每套必须给全 8 个核心变量——切换时整束覆盖，绝不残留上一套的颜色。
// 午夜/樱花由此从 CSS 主题转正为内置颜色集；CSS 主题则退居框样式/布局层。
const COLOR_SETS = {
  'rin-warmgray-light': {
    name: 'Rin WarmGray Light',
    vars: {
      '--bg-base': '#ffffff', '--bg-panel': '#f9fafb',
      '--label-primary': '#0f1115', '--label-secondary': '#61666b', '--label-tertiary': '#81858c',
      '--border-light': 'rgba(0,0,0,.06)', '--border-medium': 'rgba(0,0,0,.12)',
      '--accent': '#544d4c',
    },
  },
  'rin-warmgray-dark': {
    name: 'Rin WarmGray Dark',
    vars: {
      '--bg-base': '#171614', '--bg-panel': '#201e1b',
      '--label-primary': '#e8e4df', '--label-secondary': '#a39d95', '--label-tertiary': '#6f6a63',
      '--border-light': 'rgba(255,255,255,.07)', '--border-medium': 'rgba(255,255,255,.14)',
      '--accent': '#8a7f76',
    },
  },
  'midnight': {
    name: '午夜',
    vars: {
      '--bg-base': '#0b1020', '--bg-panel': '#131a2e',
      '--label-primary': '#e6ebff', '--label-secondary': '#9aa7d0', '--label-tertiary': '#5f6c96',
      '--border-light': '#232c47', '--border-medium': '#35406b',
      '--accent': '#7c8cff',
    },
  },
  'sakura': {
    name: '樱花',
    vars: {
      '--bg-base': '#fff7f9', '--bg-panel': '#fdeef2',
      '--label-primary': '#43302e', '--label-secondary': '#8c6f6d', '--label-tertiary': '#b39a98',
      '--border-light': 'rgba(180,110,120,.14)', '--border-medium': 'rgba(180,110,120,.26)',
      '--accent': '#e2698b',
    },
  },
};
const DEFAULT_SET = 'rin-warmgray-light';
// 旧预设色板的颜色保留为"自定义主色"，迁移时不丢
const LEGACY_ACCENTS = { default: '#6366f1', ocean: '#0ea5e9', forest: '#10b981', sunset: '#f59e0b', rose: '#ec4899', warmgray: '#544d4c' };

function applyTheme(theme) {
  const th = theme || {};
  const set = COLOR_SETS[th.set] || COLOR_SETS[DEFAULT_SET];
  const vars = { ...set.vars };
  // 自定义主色：只覆盖 accent，其余颜色仍来自颜色集
  if (th.accent) vars['--accent'] = th.accent;
  for (const k of Object.keys(vars)) document.documentElement.style.setProperty(k, vars[k]);
}

// ---------- CSS 主题（.css 导入，选择即时生效） ----------
async function applyCssTheme(name) {
  const el = document.getElementById('custom-theme');
  if (!name) { if (el) el.remove(); return; }
  try {
    const res = await fetch('/api/themes/' + encodeURIComponent(name) + '/raw');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const css = await res.text();
    let style = el;
    if (!style) { style = document.createElement('style'); style.id = 'custom-theme'; document.head.append(style); }
    style.textContent = css;
  } catch { if (el) el.remove(); }
}

async function renderCssThemeList() {
  const sel = $('#sel-css-theme');
  try {
    const { themes, current } = await api('/api/themes');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = t('settings.no_css');
    sel.append(none);
    for (const th of themes) {
      const o = document.createElement('option');
      o.value = th.name;
      o.textContent = th.name + (th.custom ? ' ⭐' : '');
      sel.append(o);
    }
    sel.value = current || '';
  } catch { /* 列表拉不到就不动 */ }
}

function saveCssTheme(name) {
  const curTheme = (state.settings && state.settings.theme) || {};
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: { ...curTheme, css_name: name } }),
  }).then(async ({ settings }) => {
    state.settings = settings;
    await applyCssTheme(name);
    await renderCssThemeList();
  }).catch((e) => alert(e.message));
}

async function uploadFile(url, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(url, { method: 'POST', body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
  return json;
}

function bindLangAndCssTheme() {
  $('#sel-lang').addEventListener('change', () => changeLanguage($('#sel-lang').value).catch((e) => alert(e.message)));
  $('#btn-import-lang').addEventListener('click', () => $('#import-lang-file').click());
  $('#import-lang-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { code } = await uploadFile('/api/langs/import', file);
      await renderLangList();
      await changeLanguage(code); // 导入即切换，立见效果
      toast(t('common.import_ok', { n: 1 }));
    } catch (err) { alert(t('common.import_fail', { e: err.message })); }
    e.target.value = '';
  });
  $('#sel-css-theme').addEventListener('change', () => saveCssTheme($('#sel-css-theme').value));
  $('#btn-import-theme').addEventListener('click', () => $('#import-theme-file').click());
  $('#import-theme-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { name } = await uploadFile('/api/themes/import', file);
      saveCssTheme(name); // 导入即应用
      toast(t('common.import_ok', { n: 1 }));
    } catch (err) { alert(t('common.import_fail', { e: err.message })); }
    e.target.value = '';
  });
}

// ---------- 轻提示（右上角，自动消失） ----------
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

function renderSettingsDialog() {
  renderThemeUI();
  renderModelList();
}

function renderThemeUI() {
  // 局部变量叫 th，绝不叫 t——全局 t() 是翻译函数，遮蔽它就是 't is not a function'
  const th = (state.settings && state.settings.theme) || {};
  // 颜色集卡片：色块预览 = 该集的面板色+主色双色球
  const row = $('#cset-row');
  row.innerHTML = '';
  for (const id of Object.keys(COLOR_SETS)) {
    const cs = COLOR_SETS[id];
    const card = document.createElement('button');
    card.className = 'cset-card' + (th.set === id ? ' active' : '');
    const ball = document.createElement('span');
    ball.className = 'cset-ball';
    ball.style.background = 'linear-gradient(135deg, ' + cs.vars['--bg-base'] + ' 49%, ' + cs.vars['--accent'] + ' 51%)';
    ball.style.borderColor = cs.vars['--border-medium'];
    const label = document.createElement('span');
    label.className = 'cset-name';
    label.textContent = t('theme.set.' + id) || cs.name;
    card.append(ball, label);
    card.addEventListener('click', () => saveTheme({ set: id }));
    row.append(card);
  }
  const custom = !!(th.accent);
  $('#theme-custom-chec').checked = custom;
  $('#theme-custom-input').value = th.accent || COLOR_SETS[th.set || DEFAULT_SET].vars['--accent'];
}

function saveTheme(patch) {
  api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: { ...((state.settings && state.settings.theme) || {}), ...patch } }),
  }).then(({ settings }) => {
    state.settings = settings;
    applyTheme(settings.theme);
    renderThemeUI();
    const h = $('#theme-saved');
    h.textContent = t('common.saved');
    clearTimeout(h._t); h._t = setTimeout(() => { h.textContent = ''; }, 1500);
  }).catch((e) => alert(e.message));
}

// ---------- 搜索引擎库（全局设置；联网搜索用哪个引擎在这里管） ----------
let aeEditId = null; // null = 添加模式；非 null = 正在编辑的引擎 id

function searchConfig() {
  return (state.settings && state.settings.search) || { engines: [], active: '' };
}

async function postSearch(next) {
  const { settings } = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: next }),
  });
  state.settings = settings;
  renderEngineList();
}

function renderEngineList() {
  const box = $('#engine-list');
  box.innerHTML = '';
  const { engines, active } = searchConfig();
  if (!engines.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = t('engine.empty');
    box.append(empty);
    return;
  }
  for (const e of engines) {
    const row = document.createElement('div');
    row.className = 'model-item' + (e.id === active ? ' current' : '');
    row.style.cursor = 'pointer';
    row.title = t('engine.set_active');
    const info = document.createElement('div');
    info.className = 'model-info';
    const nm = document.createElement('div');
    nm.className = 'model-name';
    nm.textContent = (e.id === active ? '✓ ' : '') + (e.name || t('system.unnamed'));
    const sub = document.createElement('div');
    sub.className = 'model-sub';
    sub.textContent = e.url_template || '';
    info.append(nm, sub);
    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.style.marginLeft = 'auto';
    edit.textContent = '✎';
    edit.title = t('common.edit');
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); openEditEngineDialog(e); });
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = t('common.delete');
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(t('common.confirm_delete_engine'))) return;
      const cfg = searchConfig();
      const engines2 = cfg.engines.filter((x) => x.id !== e.id);
      if (!engines2.length) { alert(t('engine.last_one')); return; }
      const active2 = cfg.active === e.id ? engines2[0].id : cfg.active;
      try { await postSearch({ engines: engines2, active: active2 }); } catch (err) { alert(err.message); }
    });
    row.addEventListener('click', async () => {
      if (e.id === searchConfig().active) return;
      const cfg = searchConfig();
      try { await postSearch({ engines: cfg.engines, active: e.id }); } catch (err) { alert(err.message); }
    });
    row.append(info, edit, del);
    box.append(row);
  }
}

function fillEngineForm(e) {
  $('#ae-name').value = e.name || '';
  $('#ae-url').value = e.url_template || '';
  $('#ae-parser').value = e.parser || 'bing';
  $('#ae-ua').value = e.ua || '';
}

function openEditEngineDialog(e) {
  aeEditId = e.id;
  $('#ae-title').textContent = t('enginedlg.edit');
  fillEngineForm(e);
  $('#add-engine-dialog').showModal();
}

async function saveEngine() {
  const name = $('#ae-name').value.trim();
  const url_template = $('#ae-url').value.trim();
  const parser = $('#ae-parser').value;
  const ua = $('#ae-ua').value.trim();
  if (!url_template.includes('%s')) { alert(t('enginedlg.need_url')); return; }
  const cfg = searchConfig();
  const engines = [...(cfg.engines || [])];
  if (aeEditId) {
    const i = engines.findIndex((x) => x.id === aeEditId);
    if (i >= 0) engines[i] = { ...engines[i], name: name || engines[i].name, url_template, parser, ua };
  } else {
    const id = 'se-' + Date.now().toString(36);
    engines.push({ id, name: name || '搜索引擎', url_template, parser, ua });
    const active = cfg.active || id;
    await postSearch({ engines, active });
    aeEditId = null;
    $('#add-engine-dialog').close();
    return;
  }
  await postSearch({ engines, active: cfg.active });
  aeEditId = null;
  $('#add-engine-dialog').close();
}

function bindEngineDialog() {
  $('#btn-add-engine').addEventListener('click', () => {
    aeEditId = null;
    $('#ae-title').textContent = t('enginedlg.add');
    fillEngineForm({ name: '', url_template: 'https://www.bing.com/search?q=%s', parser: 'bing', ua: '' });
    $('#add-engine-dialog').showModal();
  });
  $('#btn-ae-save').addEventListener('click', () => saveEngine().catch((e) => alert(e.message)));
}

function renderModelList() {
  const box = $('#model-list');
  box.innerHTML = '';
  const models = (state.settings && state.settings.models) || [];
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = t('models.empty');
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
    nm.textContent = (m.provider === 'local' ? t('system.local') : t('system.cloud')) + ' · ' + (m.name || m.model || t('system.unnamed'));
    const sub = document.createElement('div');
    sub.className = 'model-sub';
    sub.textContent = m.model || m.baseUrl || '';
    info.append(nm, sub);
    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.style.marginLeft = 'auto';
    edit.textContent = '✎';
    edit.title = t('common.edit');
    edit.addEventListener('click', () => openEditModelDialog(m));
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = t('common.delete');
    del.addEventListener('click', async () => {
      if (!confirm(t('common.confirm_delete_model'))) return;
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
  $('#add-model-dialog h3').textContent = t('modeldlg.edit');
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
  if (!baseUrl || !model) { alert(t('common.need_base_model')); return; }
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
  renderEngineList();
  showSettingsZone('theme'); // 每次打开回到「主题」分区
  $('#settings-dialog').showModal();
}

// 设置页分区：主题 / 模型 / 网络
function showSettingsZone(zone) {
  $$('#sett-tabs .sett-tab').forEach((b) => b.classList.toggle('active', b.dataset.zone === zone));
  $$('#settings-dialog .sett-section[data-zone]').forEach((sec) => {
    sec.hidden = sec.dataset.zone !== zone;
  });
}

function bindSettingsDialog() {
  // 主题：自定义主色（只覆盖当前颜色集的 accent）
  $('#theme-custom-chec').addEventListener('change', () => {
    if ($('#theme-custom-chec').checked) {
      saveTheme({ accent: $('#theme-custom-input').value });
    } else {
      saveTheme({ accent: '' });
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
    $('#add-model-dialog h3').textContent = t('modeldlg.add');
    $('#am-key').value = '';
    fillModelForm({ provider: 'cloud', base: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4-flash-0731', name: '' });
    $('#add-model-dialog').showModal();
  });
  // 导出智能体（tar，不压缩）
  $('#btn-export-agents').addEventListener('click', async () => {
    try {
      const base = (typeof apiBase === 'function') ? apiBase() : '';
      const res = await fetch(base + '/api/agents/export');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const fm = cd.match(/filename="?([^";]+)"?/);
      const fname = (fm && fm[1]) || ('rincy-agents-' + new Date().toISOString().slice(0, 10) + '.tar');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { alert(t('common.export_fail', { e: e.message })); }
  });
  // 导入智能体
  $('#btn-import-agents').addEventListener('click', () => $('#import-agents-file').click());
  $('#import-agents-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const base = (typeof apiBase === 'function') ? apiBase() : '';
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(base + '/api/agents/import', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      alert(t('common.import_ok', { n: json.imported || 0 }));
      location.reload();
    } catch (err) { alert(t('common.import_fail', { e: err.message })); }
    e.target.value = '';
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

// ---------- 重生成 / 改上一条（聊天操作行） ----------
let editingLast = false;
function lastUserBubbleText() {
  const bubbles = $$('#chat-messages .bubble');
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].classList.contains('me')) {
      const tb = bubbles[i].querySelector('.text');
      return tb ? tb.textContent : '';
    }
  }
  return '';
}
function updateChatActions() {
  const row = $('#chat-actions');
  if (row) row.hidden = isReplying(state.currentId) || $$('#chat-messages .bubble').length === 0;
}
function cancelEdit() {
  editingLast = false;
  const hint = $('#edit-hint');
  if (hint) { hint.hidden = true; hint.innerHTML = ''; }
}
function bindChatActions() {
  const regen = $('#btn-regen'), editBtn = $('#btn-edit-last');
  if (regen) regen.addEventListener('click', () => { if (!isReplying(state.currentId)) send({ regenerate: true }); });
  if (editBtn) editBtn.addEventListener('click', () => {
    if (isReplying(state.currentId)) return;
    const lastText = lastUserBubbleText();
    if (!lastText) return;
    editingLast = true;
    $('#chat-input').value = lastText;
    const hint = $('#edit-hint');
    hint.hidden = false;
    hint.innerHTML = t('chat.editing') + ' <a href="#" id="edit-cancel" style="color:inherit">\u2715 ' + t('common.cancel') + '</a>';
    const c = $('#edit-cancel');
    if (c) c.addEventListener('click', (e) => { e.preventDefault(); cancelEdit(); });
    $('#chat-input').focus();
  });
}

// ---------- 清除记忆（对当前选中的智能体生效，所有智能体都可用） ----------
function bindClearMemory() {
  $('#btn-clear-memory').addEventListener('click', async () => {
    if (!state.currentId) { alert(t('chat.no_agent')); return; }
    const a = state.agents.find((x) => x.id === state.currentId);
    const name = a ? a.name : state.currentId;
    if (!confirm(t('mem.confirm', { name }))) return;
    await api(`/api/agents/${encodeURIComponent(state.currentId)}/clear`, { method: 'POST' });
    toast(t('mem.done'));
    await loadHistory();
  });
}

// ---------- 聊天记录（从完整本地存档渲染） ----------
/** 按当前查看的智能体的流状态刷新发送按钮/圆点。 */
function refreshChatUiState() {
  const replyingNow = isReplying(state.currentId);
  const sendBtn = $('#btn-send'), dot = $('#chat-dot');
  if (sendBtn) sendBtn.textContent = t(replyingNow ? 'chat.stop' : 'chat.send');
  if (dot) dot.className = replyingNow ? 'dot dot-run' : 'dot dot-ok';
}

async function loadHistory() {
  if (!state.currentId) return;
  // 该智能体若正在流式回复，先把直播气泡从 DOM 摘下（渲染完历史再接回去，内容继续直播）
  const rec = streams.get(state.currentId);
  const liveBubble = (rec && !rec.finished && rec.aiBubble) ? rec.aiBubble.div : null;
  if (liveBubble) liveBubble.remove();
  const { history, variants } = await api(`/api/agents/${state.currentId}/history`).catch(() => ({ history: '', variants: {} }));
  const msgs = $('#chat-messages');
  msgs.innerHTML = '';
  let cur = null, inThought = false;
  const bubbles = [];
  for (const line of String(history).split('\n')) {
    const m = line.match(/^## \[([^\]]*)\] (.+)$/);
    if (m) { if (cur) bubbles.push(cur); cur = { who: m[2].trim(), text: '', thought: '' }; inThought = false; continue; }
    if (!cur) continue;
    // 存档里的思考过程包在 ```思考 围栏里——必须单独归入 thought，
    // 否则刷新后思考内容会被当成正文拼到回答末尾（还渲染成代码框）
    const t = line.trim();
    if (t === '```思考') { inThought = true; continue; }
    if (inThought && t === '```') { inThought = false; continue; }
    if (!t) continue;
    if (inThought) cur.thought += (cur.thought ? '\n' : '') + t;
    else cur.text += (cur.text ? '\n' : '') + t;
  }
  if (cur) bubbles.push(cur);
  let aiN = 0;
  for (const b of bubbles) {
    if (b.who === '用户') { addBubble('me', b.text); continue; }
    aiN++;
    const vm = variants && variants[String(aiN)];
    addBubble('ai', b.text, { thought: b.thought, variants: vm, aiN });
  }
  if (liveBubble) {
    // 直播气泡接回末尾（进行中的回复还没进磁盘历史，挂在最后正是它的位置）
    msgs.append(liveBubble);
  } else if (!msgs.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = t('chat.empty');
    msgs.append(empty);
  }
  msgs.scrollTop = msgs.scrollHeight;
  refreshChatUiState();
  updateChatActions();
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
    // 表格：当前行含 | 且下一行是 |---|---| 分隔行
    if (ln.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}[-\s:|]*\|/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i++; }
      out.push('<table><thead><tr>' + head.map((h) => '<th>' + inlineMd(h) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    // 分隔线 --- *** ___
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(ln)) { out.push('<hr>'); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { out.push('<li>' + inlineMd(ln.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { out.push('<li>' + inlineMd(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue; }
    out.push(inlineMd(ln));
  }
  if (inCode) codeBuf.push('');
  flushCode();
  return out.join('\n');
}

function addBubble(who, text, opts = {}) {
  const msgs = $('#chat-messages');
  const hint = msgs.querySelector('.empty-hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = 'bubble ' + (who === 'me' ? 'me' : 'ai');
  // AI 历史气泡：思考过程以折叠块呈现（默认收起，点标签展开）
  if (who !== 'me' && opts.thought) {
    const th = document.createElement('div');
    th.className = 'thought folded';
    th.innerHTML = '<span class="thought-label">' + t('chat.thought_label') + '</span><span class="thought-caret">▾</span>';
    const thText = document.createElement('span');
    thText.className = 'thought-text';
    thText.textContent = opts.thought;
    th.append(thText);
    th.addEventListener('click', () => th.classList.toggle('folded'));
    div.append(th);
  }
  const tb = document.createElement('div');
  tb.className = 'text';
  // 用户消息保持纯文本；AI 消息渲染 markdown（历史记录里 AI 内容也正确显示）
  if (who === 'me') tb.textContent = text;
  else tb.innerHTML = renderMarkdown(text) || '…';
  div.append(tb);
  // 回复分支切换器：‹ 当前/共 N ›
  if (who !== 'me' && opts.variants && opts.variants.count > 1) {
    const nav = document.createElement('div');
    nav.className = 'variant-nav';
    nav.title = t('chat.variant_title');
    const prev = document.createElement('button'); prev.textContent = '‹';
    const label = document.createElement('span');
    const next = document.createElement('button'); next.textContent = '›';
    const paint = () => { label.textContent = (opts.variants.pos + 1) + '/' + opts.variants.count; };
    paint();
    const jump = async (dir) => {
      const count = opts.variants.count;
      const idx = (opts.variants.pos + dir + count) % count;
      try {
        await api('/api/agents/' + encodeURIComponent(state.currentId) + '/variant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ n: opts.aiN, idx }),
        });
        await loadHistory();
      } catch (e) { toast(e.message); }
    };
    prev.addEventListener('click', () => jump(-1));
    next.addEventListener('click', () => jump(1));
    nav.append(prev, label, next);
    div.append(nav);
  }
  msgs.append(div);
  msgs.scrollTop = msgs.scrollHeight;
  return t;
}

// ---------- 聊天（流式） ----------
// 并行聊天：每个智能体一条独立流，互不阻塞。key = agentId。
// 记录 { abort, aiBubble, full, stopRequested, waitingTimer, finished }；
// 切走时流式气泡从 DOM 摘下挂在记录里，切回来原样接上继续直播。
const streams = new Map();
const isReplying = (id) => { const s = streams.get(id); return !!(s && !s.finished); };
async function send(opts = {}) {
  const regenerate = !!opts.regenerate;
  const editing = !!opts.editing || editingLast; // 点过「改上一条」后，下次发送就是替换
  if (!regenerate) cancelEdit();
  const input = $('#chat-input');
  let text = (opts.message !== undefined) ? String(opts.message) : input.value.trim();
  if (regenerate) text = ''; // 正文由服务端从历史取
  else if (!text) return;
  const agentId = state.currentId;
  if (isReplying(agentId)) {
    // 自愈：历史请求已无活跃 abort（曾被异常卡死）就强制复位，绝不让界面无声卡死
    const rec = streams.get(agentId);
    if (!rec.abort) streams.delete(agentId);
    else return; // 这个智能体正在回复中：等停止或完成（不影响别的智能体）
  }
  if (!state.currentId) { alert(t('chat.no_agent')); return; }
  if (!regenerate) {
    input.value = '';
    // 编辑模式：先在 DOM 里移除被替换的上一组气泡（用户+AI），再放编辑后的消息
    if (editing) {
      const bubbles = $$('#chat-messages .bubble');
      if (bubbles.length >= 2) { bubbles[bubbles.length - 1].remove(); bubbles[bubbles.length - 2].remove(); }
      else if (bubbles.length === 1) bubbles[0].remove();
    }
    addBubble('me', text);
  } else {
    // 重生成：把最后一颗 AI 气泡从 DOM 里拿掉，新的回答原地长出来
    const bubbles = $$('#chat-messages .bubble');
    if (bubbles.length) bubbles[bubbles.length - 1].remove();
  }

  const rec = { abort: null, aiBubble: null, full: '', stopRequested: false, waitingTimer: null, finished: false };
  streams.set(agentId, rec);
  const sendBtn = $('#btn-send');
  const dot = $('#chat-dot');
  if (sendBtn) sendBtn.textContent = t('chat.stop'); // 进行中按钮变「停止」
  if (dot) dot.className = 'dot dot-run';

  // —— 从这里起全部纳入同一个 try/finally：任何一步抛错，
  //    finally 都会收尾记录/按钮/圆点，界面永不被楔死 ——
  const abort = new AbortController();
  rec.abort = abort;
  const hardStop = setTimeout(() => { rec.stopRequested = true; abort.abort(); }, 6 * 60 * 1000);
  let waitingTimer = null;
  let aiBubble = null;
  try {
    // AI 气泡带"思考区 + 回答区"，思考用浅色小字展示在回答上方
    aiBubble = (() => {
      const msgs = $('#chat-messages');
      const hint = msgs.querySelector('.empty-hint');
      if (hint) hint.remove();
      const div = document.createElement('div');
      div.className = 'bubble ai';
      const th = document.createElement('div');
      th.className = 'thought';
      th.hidden = false; // 一开始就可见："思考中…"是明确状态，不是无声等待
      th.innerHTML = '<span class="thought-label">' + t('chat.thinking') + '</span> <span class="thought-caret">▾</span><span class="thought-text"></span>';
      th.addEventListener('click', () => th.classList.toggle('folded')); // 思考区可折叠
      const tb = document.createElement('div');
      tb.className = 'text';
      tb.textContent = t('chat.thinking');
      div.append(th, tb);
      msgs.append(div);
      const thText = th.querySelector('.thought-text');
      msgs.scrollTop = msgs.scrollHeight;
      rec.aiBubble = { div, th, thText, t: tb };
      return rec.aiBubble;
    })();
    // 20 秒还没等到第一个字节就把状态说清楚（"思考中"→"模型还在想"）
    let gotAnything = false;
    rec.waitingTimer = waitingTimer = setTimeout(() => {
      if (!gotAnything && aiBubble) {
        aiBubble.thText.textContent = t('chat.waiting');
        $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
      }
    }, 20000);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regenerate
        ? { agentId: state.currentId, regenerate: true }
        : { agentId: state.currentId, message: text, edit: editing }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || t('common.request_fail', { code: res.status }));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '', curEvent = '', curLines;
    const handleData = (payload) => {
      const j = JSON.parse(payload);
      if (!gotAnything) {
        gotAnything = true;
        if (waitingTimer) clearTimeout(waitingTimer);
        aiBubble.thText.textContent = '';
        aiBubble.t.textContent = '';
      }
      if (curEvent === 'thought' && j.text) {
        aiBubble.th.hidden = false;
        aiBubble.thText.textContent += j.text;
        if (state.currentId === agentId && !aiBubble.th.classList.contains('folded')) stickToBottom();
      } else if (curEvent === 'delta' && j.text) {
        full += j.text; rec.full = full; aiBubble.t.innerHTML = renderMarkdown(full);
        if (state.currentId === agentId) stickToBottom();
      } else if (curEvent === 'metasoul' && (j.applied || j.errors)) {
        if (j.applied && j.applied.length) {
          toast(t('metasoul.toast', { n: j.applied.length }));
          refreshAgents();
        }
        if (j.errors && j.errors.length) toast(t('metasoul.fail', { e: j.errors[0].error }));
      } else if (curEvent === 'done' && typeof j.full === 'string') {
        aiBubble.t.innerHTML = renderMarkdown(j.full) || '…';
        if (j.applied && j.applied.length) refreshAgents();
        if (regenerate) loadHistory(); // 重生成后重载：挂上 ‹ n/m › 版本切换器
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
        const ln = line.trim();
        if (!ln) continue;
        if (ln.startsWith('event:')) { curEvent = ln.slice(6).trim(); continue; }
        if (!ln.startsWith('data:')) continue;
        const payload = ln.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { handleData(payload); } catch (e2) { /* 忽略解析不了的行 */ }
      }
    }
    if (!full && aiBubble.t.textContent === '…' && aiBubble.thText.textContent === '') aiBubble.t.textContent = t('chat.no_reply');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      if (rec.stopRequested) {
        if (aiBubble) aiBubble.t.innerHTML += '<span class="chat-stopped">' + t('chat.stopped') + '</span>';
      } else if (aiBubble) {
        aiBubble.t.textContent = t('chat.gave_up');
      }
    } else if (aiBubble) {
      aiBubble.t.textContent = e.message; // 其余错误照常显示在气泡里
    } else {
      alert(e.message);
    }
  } finally {
    clearTimeout(hardStop);
    if (rec.waitingTimer) clearTimeout(rec.waitingTimer);
    rec.finished = true;
    streams.delete(agentId);
    refreshChatUiState(); // 只刷新当前查看的智能体的按钮/圆点（后台流不抢界面）
    updateChatActions();
  }
}

// 「停止」：掐断当前请求。气泡和已生成的部分内容都保留，输入框立即可再用
function stopChat() {
  const rec = streams.get(state.currentId);
  if (rec && !rec.finished) {
    rec.stopRequested = true;
    if (rec.abort) rec.abort.abort(); // 掐断当前查看的智能体的流，气泡保留已生成内容
    return;
  }
  refreshChatUiState(); // 没有活跃流（历史卡死）：按钮立刻复位
}

// ---------- 分支智能体（duplicate/fork） ----------
function bindForkAgent() {
  const btn = $('#btn-fork-agent');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state.currentId) { alert(t('chat.no_agent')); return; }
    const a = state.agents.find((x) => x.id === state.currentId);
    if (!confirm(t('perm.fork_confirm', { name: a ? a.name : state.currentId }))) return;
    const { agent } = await api(`/api/agents/${encodeURIComponent(state.currentId)}/fork`, { method: 'POST' });
    toast(t('perm.fork_done', { name: agent.name }));
    await refreshAgents();
    await selectAgent(agent.id);
  });
}

// ---------- 元灵重置（builtin 不能删，但可恢复出厂） ----------
function bindResetMetasoul() {
  const btn = $('#btn-reset-metasoul');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm(t('perm.reset_confirm'))) return;
    await api('/api/agents/metasoul/reset', { method: 'POST' });
    toast(t('perm.reset_done'));
    await refreshAgents();
    await selectAgent('metasoul');
  });
}

// ---------- 新建智能体 ----------
async function createAgent() {
  const name = $('#new-agent-name').value.trim();
  const desc = $('#new-agent-desc').value.trim();
  if (!name) { alert(t('common.need_name')); return; }
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
  const { soul, agents, memory, changes } = await api(`/api/agents/${state.currentId}/files`);
  const parts = [soul, agents, memory];
  if (changes) parts.push(t('files.changes_header') + '\n\n' + changes);
  $('#files-content').textContent = parts.filter(Boolean).join('\n\n---\n\n') || t('common.files_empty');
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

  await loadSettings();
  // 语言先行：先铺字典再渲染任何 UI 文本
  await loadLangDict((state.settings && state.settings.language));
  applyI18n();

  loadState();
  bindSliders();
  bindSwitches();
  bindChoices();
  bindAgentModel();
  bindTextFields();
  bindClearMemory();
  bindChatActions();
  bindResetMetasoul();
  bindForkAgent();
  bindSettingsDialog();
  bindAddModelDialog();
  bindEngineDialog();
  // 设置页分区切换
  $$('#sett-tabs .sett-tab').forEach((b) => b.addEventListener('click', () => showSettingsZone(b.dataset.zone)));
  bindLangAndCssTheme();
  applyTheme((state.settings && state.settings.theme));
  await applyCssTheme(((state.settings && state.settings.theme && state.settings.theme.css_name) || ''));
  renderLangList();
  await renderCssThemeList();
  api('/api/version').then(({ version }) => {
    $('#app-version').textContent = 'Rincy v' + (version || '?');
  }).catch(() => {});

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

  $('#btn-new').addEventListener('click', () => $('#new-agent-dialog').showModal());
  $('#btn-new-create').addEventListener('click', () => createAgent().catch((e) => alert(e.message)));
  $('#btn-settings').addEventListener('click', openSettingsDialog); // 设置 = 全局设置

  $('#btn-catch-add').addEventListener('click', addCatchphrase);
  $('#catch-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCatchphrase(); });

  $('#btn-view-config').addEventListener('click', () => viewFiles().catch((e) => alert(e.message)));

  await refreshAgents();
  if (state.agents.length) await selectAgent(state.agents[0].id);
}


// —— 立即绑定（刻意在 init 之前生效）：数据没加载完、甚至服务无响应时，
//    发送/停止也必须可点，界面永不"无声全死" ——
$('#btn-send').addEventListener('click', () => {
  if (isReplying(state.currentId)) stopChat();
  else send();
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!isReplying(state.currentId)) send(); }
});

let initRetryTimer = null;
function bootBanner(msg) {
  var b = document.getElementById('boot-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'boot-banner';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b3261e;color:#fff;padding:10px 14px;font:14px/1.5 sans-serif;';
    document.body.appendChild(b);
  }
  b.textContent = msg;
}
function bootBannerClear() {
  var b = document.getElementById('boot-banner');
  if (b && b.parentNode) b.parentNode.removeChild(b);
}
function bootInit() {
  if (initRetryTimer) { clearTimeout(initRetryTimer); initRetryTimer = null; }
  init().then(bootBannerClear).catch((e) => {
    bootBanner(t('common.boot_fail', { e: e.message }));
    initRetryTimer = setTimeout(bootInit, 5000); // 切回应用/恢复后自动重试
  });
}
bootInit();
