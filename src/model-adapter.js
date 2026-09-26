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
async function chatStream({ modelConf, messages, params, onDelta, onThought, signal }) {
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
    temperature: params.temperature,
    max_tokens: params.maxReplyTokens,
    top_p: params.top_p,
    frequency_penalty: params.frequency_penalty,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'cloud') headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(chatEndpoint(baseUrl) || `${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

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
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '',
    thought = '';
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
        if (delta.content) { full += delta.content; onDelta(delta.content); }
        if (delta.reasoning_content) { thought += delta.reasoning_content; if (onThought) onThought(delta.reasoning_content); }
      } catch { /* 忽略无法解析的行（心跳/注释） */ }
    }
  }
  // 思考吐了一堆但正式回答为空 → 很可能是"回答长度"太小被思考吃光
  if (!full && thought) {
    throw new Error('这次没生成正式回答（模型把思考用足了额度）。试试在右边把「回答长度」调大一点。');
  }
  return full;
}

module.exports = { chatStream };
