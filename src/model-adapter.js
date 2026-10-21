// model-adapter.js — 统一 OpenAI Chat Completion / Ollama 调用
// 两种协议一个壳：云端走 OpenAI 官方接口，本地走 Ollama 的 OpenAI 兼容端点（/v1/chat/completions）。
// 流式输出默认开（SSE）。零第三方依赖，只用全局 fetch（Node 18+ 内置）。
// 失败抛人话错误，由 server 发到流里——不吞消息。
'use strict';

// 拼出 OpenAI 兼容的 chat/completions 端点。容忍 baseUrl 带不带 /v1，甚至直接就是完整端点：
//   .../v1/chat/completions  → 原样
//   .../v1                  → 拼 /chat/completions
//   ...（如 api.openai.com）→ 拼 /v1/chat/completions
function chatEndpoint(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

// 发起流式聊天。onDelta(text) 逐段回调正式回答；onThought(text) 回调思考过程（reasoning 模型）。返回完整回复文本。
async function chatStream({ modelConf, messages, params, onDelta, onThought, signal, think = true }) {
  const mc = modelConf || {};
  const provider = mc.provider === 'local' ? 'local' : 'cloud';
  const baseUrl = String(mc.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(mc.apiKey || '');
  const model = String(mc.model || '');

  if (!model) throw new Error('这个对话还没选好模型。先在左边设置里挑一个，再聊。');
  if (provider === 'cloud' && !apiKey) throw new Error('这个云端模型还没填密钥。先在设置里补上，再聊。');

  const body = {
    model,
    messages,
    stream: true,
    // 深度思考开关：关掉时带上 enable_thinking=false（Qwen3/百炼等端点尊重此参数，
    // 不识别的端点会忽略——那种模型思考起来照样收，只是不再展示/入档）
    ...(think === false ? { enable_thinking: false } : {}),
    temperature: params.temperature,
    max_tokens: params.maxReplyTokens,
    top_p: params.top_p,
    frequency_penalty: params.frequency_penalty,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'cloud') headers.Authorization = `Bearer ${apiKey}`;

  // 两级超时，把"网络不通"和"模型慢"区分开，绝不永远停在"思考中"：
  // ① 25 秒等不到响应头 → 大概率端点被拦（实测：握手通、GET 秒回、
  //    但推理请求的响应被网络静默吞掉）——快速失败并说清楚；
  // ② 5 分钟总上限 → 流式进行中太慢才放弃。
  // 调用方传了 signal 就同时尊重它。
  const ctrl = new AbortController();
  let phase = '连接中';
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const headersTimer = setTimeout(() => { phase = '等待响应'; ctrl.abort(); }, 25 * 1000);
  const overallTimer = setTimeout(() => { phase = '响应超时'; ctrl.abort(); }, 5 * 60 * 1000);
  if (typeof headersTimer.unref === 'function') headersTimer.unref();
  if (typeof overallTimer.unref === 'function') overallTimer.unref();

  let res;
  try {
    res = await fetch(chatEndpoint(baseUrl) || `${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    // 响应头到了：清掉"连不上"判定，只留总上限
    clearTimeout(headersTimer);
  } catch (e) {
    clearTimeout(headersTimer);
    clearTimeout(overallTimer);
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      if (phase === '等待响应') {
        throw new Error('连不上模型端点：25 秒内没有任何响应字节。'
          + '你的网络到「' + baseUrl + '」的推理请求被拦了（握手能通但响应收不到）。'
          + '换一个国内可达的接口（如智谱 open.bigmodel.cn），或给手机配代理。');
      }
      if (phase === '响应超时') {
        throw new Error('模型 5 分钟都没回话，先放弃了。可以再试一次，或把「回答长度」调小一点。');
      }
      throw new Error('连接模型端点失败（' + (baseUrl || '未知地址') + '）。');
    }
    throw new Error('连不上模型接口：' + (e?.message || e));
  }
  // （总上限定时器在读循环的 finally 里清理——此处绝不能再 getReader，会把流锁死）

  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* 读不到就略过 */ }
    throw new Error(`模型请求失败（HTTP ${res.status}）${detail ? '：' + detail : ''}`);
  }

  // 解析 SSE：data: {...}\n\n。
  // 注意 reasoning 云模型（如 NVIDIA 上的 DeepSeek）会先吐一段思考过程
  // （delta.reasoning_content），最后才给正式回答（delta.content）。
  // 只把 content 当正式回复推给用户；思考过程不展示。若 content 为空
  // （多是 maxReplyTokens 被思考过程耗尽），给一个人话提示而非空回复。
  // 注意：getReader() 只能调用一次——再调会抛 "ReadableStream is locked"。
  const reader = res.body.getReader();
  const clearOverall = () => clearTimeout(overallTimer);
  reader.closed.then(clearOverall, clearOverall); // 流结束/中断时清掉 5 分钟总上限
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '',
    thought = '';
  // ----  思考标签剥离（流式状态机） ----
  // 有的模型不走 delta.reasoning_content，而是把思考混在 content 里输出
  // （…；enable_thinking 也压不住）。这里把标签内外的内容分开：
  // 标签外 → 正式回答（onDelta / full）；标签内 → 思考（onThought / thought）。
  // 标签可能被流式分片从中间截断，用 thinkCarry 保存疑似半截标签的尾巴。
  const THINK_OPEN = '<andestat>', THINK_CLOSE = '</andestat>';
  let thinkMode = false; // false=标签外（正式回答），true=标签内（思考）
  let thinkCarry = '';
  // buf 尾部最长有多少字符是 tag 的前缀（用于跨分片识别半截标签）
  const partialTail = (buf, tag) => {
    for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
      if (buf.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };
  const feedContent = (text) => {
    let buf = thinkCarry + text;
    thinkCarry = '';
    let out = '', th = '';
    while (buf) {
      const tag = thinkMode ? THINK_CLOSE : THINK_OPEN;
      const i = buf.indexOf(tag);
      if (i === -1) {
        const keep = partialTail(buf, tag);
        if (keep > 0) {
          if (thinkMode) th += buf.slice(0, buf.length - keep); else out += buf.slice(0, buf.length - keep);
          thinkCarry = buf.slice(buf.length - keep);
        } else {
          if (thinkMode) th += buf; else out += buf;
        }
        buf = '';
      } else {
        if (thinkMode) th += buf.slice(0, i); else out += buf.slice(0, i);
        buf = buf.slice(i + tag.length);
        thinkMode = !thinkMode;
      }
    }
    if (out) { full += out; onDelta(out); }
    if (th) {
      thought += th;
      if (onThought && think !== false) onThought(th); // 开关关着：不外发
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta || {};
          if (delta.content) feedContent(delta.content);
          if (delta.reasoning_content) {
            thought += delta.reasoning_content;
            if (onThought && think !== false) onThought(delta.reasoning_content); // 开关关着：不外发
          }
        } catch { /* 忽略无法解析的行（心跳/注释） */ }
      }
    }
  } finally {
    clearOverall();
    // 收尾：半截标签没等到另一半的尾巴按当前模式归位，绝不让字符凭空消失
    if (thinkCarry) {
      if (thinkMode) { thought += thinkCarry; if (onThought && think !== false) onThought(thinkCarry); }
      else { full += thinkCarry; onDelta(thinkCarry); }
      thinkCarry = '';
    }
  }
  // 思考吐了一堆但正式回答为空 → 很可能是"回答长度"太小被思考吃光
  if (!full && thought) {
    throw new Error('这次没生成正式回答（模型把思考用足了额度）。试试在右边把「回答长度」调大一点。');
  }
  return full;
}

module.exports = { chatStream };
