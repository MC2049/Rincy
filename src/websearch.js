// websearch.js — 联网能力：搜索 + 打开网页。直接抓"查看源代码"里那份服务端渲染的
// 原始 HTML 用正则解析，零依赖、不走任何厂商 API。
// 搜索引擎 = { id, name, url_template(%s=查询词), parser(bing|baidu|duckduckgo), ua }
// 块协议：```search 查询词``` / ```open 网址```，服务端拦截执行后把结果回填给模型。
'use strict';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PARSERS = ['bing', 'baidu', 'duckduckgo'];
const PAGE_TEXT_LIMIT = 3500; // 单个网页正文回填上限（字符），控上下文预算

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

function buildUrl(tpl, query) {
  if (!tpl || !String(tpl).includes('%s')) throw new Error('搜索地址里没有 %s 占位符');
  // 用函数形式替换，避免查询词里的 $ 序列被当作替换模式
  return String(tpl).replace('%s', () => encodeURIComponent(query));
}

const NAMED_ENTITIES = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '',
  quot: '"', apos: "'", lt: '<', gt: '>', amp: '&',
  middot: '·', hellip: '…', mdash: '—', ndash: '–', dash: '-',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  laquo: '«', raquo: '»', bull: '•', sect: '§', para: '¶',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&([a-z][a-z0-9]*);/gi, (all, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : all;
    });
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---- 解析器：必应（<li class="b_algo"> 结构） ----
function parseBing(html, limit) {
  const out = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const b of blocks) {
    const end = b.indexOf('</li>');
    const seg = b.slice(0, end === -1 ? 6000 : end);
    const link = seg.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeEntities(link[1]).trim();
    const title = stripTags(link[2]);
    if (!url || !title) continue;
    let snippet = '';
    const p = seg.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (p) snippet = stripTags(p[1]);
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- 解析器：百度（result c-container + h3>a + summary-text_* / s-data JSON） ----
// 链接优先取块上的 mu="真实地址"，退化用 h3>a 的百度跳转链接（浏览器能打开）
function parseBaidu(html, limit) {
  const out = [];
  const blocks = html.split(/<div[^>]+class="[^"]*(?:\bresult\b|c-container)[^"]*"/i).slice(1);
  for (const b of blocks) {
    const seg = b.slice(0, 20000);
    const mu = seg.match(/\smu="([^"]+)"/i);
    const link = seg.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link && !mu) continue;
    const url = decodeEntities(mu ? mu[1] : link[1]).trim();
    const title = link ? stripTags(link[2]) : '';
    if (!url || !title) continue;
    let snippet = '';
    const abs = seg.match(/<span[^>]+class="[^"]*summary-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      || seg.match(/<span[^>]+class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      || seg.match(/<div[^>]+class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (abs) snippet = stripTags(abs[1]);
    if (!snippet) snippet = digBaiduJson(seg); // 兜底：结果块内嵌的 <!--s-data:{...}--> JSON
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

// 从百度结果块内嵌的 s-data JSON 里挖摘要文本（summaryData/description/abstract）
function digBaiduJson(seg) {
  const m = seg.match(/<!--s-data:(\{[\s\S]*?\})-->/);
  if (!m) return '';
  try {
    const obj = JSON.parse(m[1]);
    const found = [];
    const dig = (o, depth) => {
      if (found.length >= 2 || depth > 8 || !o || typeof o !== 'object') return;
      if (typeof o === 'string') return;
      for (const k of ['description', 'abstract', 'text', 'introduction']) {
        if (typeof o[k] === 'string' && o[k].trim().length > 20) {
          const t = stripTags(o[k]);
          if (t && !found.includes(t)) found.push(t);
        }
      }
      for (const v of Object.values(o)) {
        if (found.length >= 2) break;
        if (v && typeof v === 'object') dig(v, depth + 1);
      }
    };
    dig(obj, 0);
    return found[0] || '';
  } catch { return ''; }
}

// ---- 解析器：DuckDuckGo html 版（result__a / result__snippet，链接要解 uddg 包装） ----
function unwrapDdg(u) {
  const s = decodeEntities(String(u));
  const m = s.match(/[?&]uddg=([^&]+)/);
  if (!m) return s;
  try { return decodeURIComponent(m[1]); } catch { return s; }
}

function parseDdg(html, limit) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const url = unwrapDdg(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet: '' });
  }
  const snips = [];
  const sre = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = sre.exec(html)) && snips.length < out.length) snips.push(stripTags(m[1]));
  out.forEach((r, i) => { r.snippet = snips[i] || ''; });
  return out;
}

const PARSER_FN = { bing: parseBing, baidu: parseBaidu, duckduckgo: parseDdg };

// 通用抓取：UA/Accept-Language + 12 秒兜底 + 外部中止信号透传 + 字符集探测
async function fetchPage(url, ua, opts = {}) {
  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    // 字符集：Content-Type 头 → <meta charset>（GBK 站点常见），都不 recogniz 用 utf-8
    let cs = 'utf-8';
    const ct = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i);
    if (ct) cs = ct[1];
    else {
      const head = buf.slice(0, 2048).toString('latin1');
      const mm = head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/charset=([\w-]+)/i);
      if (mm) cs = mm[1];
    }
    let text;
    try { text = new TextDecoder(cs, { fatal: false }).decode(buf); }
    catch { text = buf.toString('utf8'); }
    return { html: text, finalUrl: res.url || url };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('抓取超时或已中止');
    throw new Error(e.message || '网络请求失败');
  } finally {
    clearTimeout(timer);
  }
}

// 搜索：抓引擎结果页 → 解析
async function search(query, engine, opts = {}) {
  query = String(query || '').trim().slice(0, 200);
  if (!query) throw new Error('查询词是空的');
  const url = buildUrl(engine && engine.url_template, query);
  const { html } = await fetchPage(url, engine && engine.ua, opts);
  const fn = PARSER_FN[(engine && engine.parser) || 'bing'] || parseBing;
  const results = fn(html, opts.limit || 6);
  if (!results.length) throw new Error('没有解析到结果（页面结构可能变了，或被反爬拦截——试试换浏览器 UA 或换个引擎）');
  return results;
}

// 打开网页：抓正文 → 去脚本/样式/注释/标签 → 折叠空白 → 截断
async function openUrl(rawUrl, opts = {}) {
  let url = String(rawUrl || '').trim().replace(/[)>'"]+$/, '');
  if (!url) throw new Error('网址是空的');
  if (/^www\./i.test(url)) url = 'https://' + url;
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 网址');
  const { html, finalUrl } = await fetchPage(url, opts.ua, opts);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]).slice(0, 120) : '';
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|template)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(body).replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  if (!text || text.length < 30) throw new Error('页面没有可读正文（可能是 JS 渲染或反爬页）');
  return { title, url: finalUrl, text: clip(text, opts.limit || PAGE_TEXT_LIMIT) };
}

// 搜索结果 → 回填给模型的纯文本（有界：6 条 × 摘要 200 字）
function formatResults(query, results) {
  const lines = ['以下是「' + query + '」的实时搜索结果：'];
  (results || []).forEach((r, i) => {
    lines.push('[' + (i + 1) + '] ' + r.title);
    lines.push('    ' + r.url);
    if (r.snippet) lines.push('    ' + clip(r.snippet, 200));
  });
  return lines.join('\n');
}

// 网页正文 → 回填给模型的纯文本
function formatPage(page) {
  return '以下是网页「' + (page.title || '无标题') + '」（' + page.url + '）的正文内容：\n' + page.text;
}

// system prompt 追加的联网协议（对齐元灵写回块的思路：块协议 + 服务端拦截）
function protocolBlock() {
  return [
    '【联网能力】你可以联网，有两种方式：',
    '① 搜索：输出语言标记为 search 的代码块，块内每行一个查询词（最多 2 行）：',
    '```search',
    '查询词',
    '```',
    '② 打开网页：输出语言标记为 open 的代码块，块内每行一个网址（最多 2 行）：',
    '```open',
    'https://example.com/page',
    '```',
    '输出这些块的那一轮不要写正式回答；系统会执行搜索/抓取网页并把结果回填给你，之后你再正式作答，引用事实时附上来源链接。',
    '需要某个网页的完整内容（比如搜索结果里的某条）时，用 ② 打开它的网址。',
    '不需要联网时就正常回答，不要输出这些块。',
  ].join('\n');
}

// 从一轮回复里提取指定块（search/open）的内容行（去重，最多 2 个）
function extractBlockLines(text, tag, max) {
  const out = [];
  const re = new RegExp('```' + tag + '[^\\S\\n]*\\r?\\n([\\s\\S]*?)```', 'gi');
  let m;
  while ((m = re.exec(String(text || '')))) {
    for (const line of m[1].split(/\r?\n/)) {
      const q = line.replace(/^[-*•\s]*\d*[.、)]?\s*/, '').trim();
      if (q && !out.includes(q)) out.push(q);
      if (out.length >= max) return out;
    }
  }
  return out;
}

const extractQueries = (text) => extractBlockLines(text, 'search', 2);
const extractUrls = (text) => extractBlockLines(text, 'open', 2);

// 把 search/open 块从正文里剥掉（最终回答不允许残留块）
function stripBlocks(text) {
  return String(text || '')
    .replace(/```search[\s\S]*?```/gi, '')
    .replace(/```open[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 从全局设置里取当前启用的搜索引擎
function activeEngine(settings) {
  const s = (settings && settings.search) || {};
  const list = Array.isArray(s.engines) ? s.engines : [];
  return list.find((e) => e && e.id === s.active) || list[0] || null;
}

module.exports = {
  DEFAULT_UA, PARSERS, PAGE_TEXT_LIMIT, buildUrl, search, openUrl,
  formatResults, formatPage, protocolBlock, extractQueries, extractUrls, stripBlocks, activeEngine,
};
