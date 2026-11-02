'use strict';
/**
 * Provider 层：把「调 LLM」和「算向量」这两件外部依赖抽象掉。
 *
 * 这是整套系统可移植的关键 —— 核心逻辑不关心你用谁家的模型，
 * 只要求实现两个方法：
 *   chat(messages, opts) -> Promise<string>        返回助手回复正文
 *   embed(texts)         -> Promise<Float32Array[]> 返回归一化向量
 *
 * 内置三种：
 *   openai()  OpenAI 兼容端点（OpenAI / DeepSeek / Ollama / LM Studio / vLLM / 任意中转）
 *   offline() 纯离线：LLM 走内置规则，向量走字符 n-gram。能跑通全流程，质量有限
 *   mock()    测试用：脚本化返回，可断言调用序列
 */

const { hashEmbed, normalize } = require('./vector');

/** 带超时和重试的 fetch。超时用 AbortController，别让一次卡死拖垮整条管线。 */
async function postJSON(url, body, { headers = {}, timeoutMs = 60000, retries = 1, label = '请求' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`响应不是合法 JSON：${text.slice(0, 300)}`);
      }
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`${label}超时（${timeoutMs}ms）`) : e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * OpenAI 兼容 provider。
 * 只要服务端实现了 /chat/completions 和 /embeddings，这里就能用。
 *
 * @param {object} opts
 *   baseUrl   形如 https://api.deepseek.com/v1（会自动去掉尾部斜杠）
 *   apiKey    Bearer token
 *   chatModel 对话模型名
 *   embedModel 向量模型名
 *   dim       向量维度；填了就对返回值做校验，不填则透传
 *   timeoutMs 单次请求超时
 */
function openai(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('[provider] openai: 缺少 baseUrl');
  const headers = Object.assign(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}, opts.headers || {});
  const chatModel = opts.chatModel || '';
  const embedModel = opts.embedModel || '';
  const timeoutMs = opts.timeoutMs || 60000;
  const dim = opts.dim || 0;

  return {
    name: `openai(${baseUrl})`,
    dim,

    async chat(messages, o = {}) {
      const body = {
        model: o.model || chatModel,
        messages,
        temperature: o.temperature !== undefined ? o.temperature : 0.3,
        stream: false
      };
      if (o.maxTokens) body.max_tokens = o.maxTokens;
      if (o.json) body.response_format = { type: 'json_object' };
      const data = await postJSON(`${baseUrl}/chat/completions`, body, {
        headers, timeoutMs: o.timeoutMs || timeoutMs, label: 'LLM 请求'
      });
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`[provider] LLM 响应缺少 choices[0].message.content：${JSON.stringify(data).slice(0, 300)}`);
      }
      return content;
    },

    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      const data = await postJSON(`${baseUrl}/embeddings`, {
        model: embedModel, input: list, encoding_format: 'float'
      }, { headers, timeoutMs, label: '向量请求' });
      const rows = data?.data;
      if (!Array.isArray(rows) || rows.length !== list.length) {
        throw new Error(`[provider] 向量响应数量不符：请求 ${list.length}，返回 ${Array.isArray(rows) ? rows.length : 'n/a'}`);
      }
      // 按 index 排序：某些中转不保证顺序
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map((r) => normalize(r.embedding, dim || undefined));
    }
  };
}

/**
 * 纯离线 provider。
 *
 * LLM 侧不真的调用模型，而是用一组正则从对话里抽事件——
 * 「我在<地点>做了<事情>」「我喜欢<东西>」这类显式表达能抽到，
 * 隐含表达抽不到。意义在于：没有 API Key 也能把整条管线跑起来、
 * 验证存储/检索/衰减都正常，也方便写不依赖网络的测试。
 */
function offline(opts = {}) {
  const dim = opts.dim || 512;
  return {
    name: 'offline',
    dim,

    async chat(messages) {
      const prompt = messages.map((m) => m.content).join('\n');
      if (prompt.includes('主题归纳任务')) return summarizeByRules(prompt);
      if (prompt.includes('事件提取任务')) return JSON.stringify(extractByRules(prompt));
      if (prompt.includes('概念归纳任务')) return JSON.stringify(conceptsByRules(prompt));
      if (prompt.includes('实体关系提取任务')) return JSON.stringify([]);
      if (prompt.includes('事件关系提取任务')) return JSON.stringify(linkEvents(prompt));
      return '[]';
    },

    async embed(texts) {
      return (Array.isArray(texts) ? texts : [texts]).map((t) => hashEmbed(t, dim));
    }
  };
}

/**
 * 中文没有词边界，纯正则抠出来的「名词」经常带上时间词、情态动词和尾巴。
 * 与其把正则写到天荒地老，不如「先宽抓、后清洗」：
 * 反复剥掉前缀的时间/情态词与后缀的动词/语气词，剥到不动为止。
 */
const TIME_WORDS = [
  '今天', '明天', '后天', '昨天', '前天', '周末', '这周', '上周', '下周',
  '这个月', '上个月', '下个月', '今年', '去年', '明年',
  '早上', '上午', '中午', '下午', '晚上', '待会', '一会儿', '现在', '刚才'
];
const MODALS = ['想', '要', '会', '打算', '准备', '应该', '可以', '能', '得', '想'];
const TAILS = [
  '吃饭', '看电影', '逛逛', '旅行', '散步', '聊天', '玩', '去',
  '了', '的', '吧', '呢', '啊', '嘛', '哦'
];
/** 清洗后若只剩这些词，说明没抽到真名词，丢弃。 */
const STOPWORDS = new Set(['我', '你', '他', '她', '它', '我们', '你们', '他们', '这个', '那个', '什么', '天气']);
/** 以这些字开头的「名词」基本是「到时候」「处理」这类误切，直接丢弃。 */
const BAD_PREFIX = /^[时候处底面边点期]|^[一二三四五六七八九十]?[个次]/;
/** 纯应答，不含任何事实。 */
const ACK = /^(好的?|嗯+|哦+|行|可以|记住了|知道了|我记下了|没问题|收到)[，。！？、\s]*$/;

function cleanNoun(s) {
  let t = String(s || '').trim();
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const w of TIME_WORDS) {
      if (t.startsWith(w)) { t = t.slice(w.length); changed = true; }
    }
    for (const w of MODALS) {
      if (t.startsWith(w)) { t = t.slice(w.length); changed = true; }
    }
    for (const w of TAILS) {
      if (t.length >= w.length && t.endsWith(w)) { t = t.slice(0, -w.length); changed = true; }
    }
    if (!changed) break;
  }
  t = t.trim();
  if (t.length < 2 || t.length > 12) return '';
  if (STOPWORDS.has(t)) return '';
  if (BAD_PREFIX.test(t)) return '';
  return t;
}

/**
 * 「去/到」后面接的东西。
 * `到(?!时|底|处)` 是为了避开「到时候」这类固定搭配 ——
 * 否则 AI 一句「好的，我记下了，到时候提醒你」会被抠出一个假地点。
 */
const GO_RE = /(?:去|到(?!时|底|处))([^\s，。！？]{2,10})/;

/**
 * 从事实抽取提示词的「对话记录」段落里用规则抠事件。
 *
 * 只能抓显式表达（「我喜欢X」「约定X」「去X」），隐含表达抓不到，
 * 抽出的实体也难免有噪声。它的定位是「没有模型时让系统别瘫」，不是替代 LLM。
 */
function extractByRules(prompt) {
  const marker = '## 对话记录';
  const idx = prompt.indexOf(marker);
  const body = idx >= 0 ? prompt.slice(idx + marker.length) : prompt;
  const stop = body.indexOf('## 输出格式');
  const convo = (stop >= 0 ? body.slice(0, stop) : body).trim();

  const events = [];
  const push = (Event, Importance, Entities) => {
    const clean = String(Event).trim();
    if (clean.length < 4) return;
    const ents = [...new Set(Entities.map(cleanNoun).filter(Boolean))];
    if (events.some((e) => e.Event === clean)) return;
    events.push({ Event: clean, Importance, Entities: ents });
  };

  for (const raw of convo.split('\n')) {
    // 去掉「说话人:」前缀
    const text = raw.replace(/^[^:：]{0,12}[:：]/, '').trim();
    if (text.length < 4) continue;
    if (ACK.test(text)) continue;

    // 名字
    const name = /(?:我叫|名字(?:是|叫)|叫我)([^\s，。！？]{2,8})/.exec(text);
    if (name) {
      const who = cleanNoun(name[1]);
      if (who) { push(`用户的名字是${who}`, 0.6, [who]); continue; }
    }

    // 偏好 / 厌恶
    const pref = /我(?:最|很|超|特别|非常)?(喜欢|爱|讨厌|不喜欢|害怕)([^\s，。！？]{2,12})/.exec(text);
    if (pref) {
      const thing = cleanNoun(pref[2]);
      const good = pref[1] === '喜欢' || pref[1] === '爱';
      if (thing) {
        push(`用户${good ? '喜欢' : '不喜欢'}${thing}`, good ? 0.7 : 0.75, [thing]);
        continue;
      }
    }

    // 约定 / 承诺
    const promise = /(约定|答应|说好|承诺)([^\s，。！？]{2,24})/.exec(text);
    if (promise) {
      const place = GO_RE.exec(text);
      const where = place ? cleanNoun(place[1]) : '';
      // 「去看电影」这类宾语是动词短语，清洗后为空 —— 那就老老实实不带实体，
      // 而不是硬塞一个「看电影」进去冒充名词。
      push(text, 0.78, where ? [where] : []);
      continue;
    }

    // 去到某处
    const place = GO_RE.exec(text);
    if (place) {
      const where = cleanNoun(place[1]);
      if (where) { push(text, 0.6, [where]); continue; }
    }

    // 学做某事 / 得到某物
    const got = /(?:学会|学了|做了|买了|收到)([^\s，。！？]{2,10})/.exec(text);
    if (got) {
      const thing = cleanNoun(got[1]);
      if (thing) { push(text, 0.65, [thing]); continue; }
    }
  }
  return events.slice(0, 8);
}

/** 把事件里的实体映射成概念：这里只能给出通用兜底类别。 */
function conceptsByRules(prompt) {
  const idx = prompt.indexOf('## 实体清单');
  if (idx < 0) return {};
  const body = prompt.slice(idx).split('## 输出格式')[0];
  const out = {};
  for (const raw of body.split('\n')) {
    const name = raw.replace(/^[-*\d.\s]+/, '').trim();
    if (!name || name === '实体清单' || name.length > 20) continue;
    out[name] = ['相关'];
  }
  return out;
}

/** stage3：按出现顺序串成 BEFORE 链。离线模式下只能这么做。 */
function linkEvents(prompt) {
  const idx = prompt.indexOf('## 事件清单');
  const count = idx < 0 ? 0 : prompt.slice(idx).split('\n').filter((l) => /^\s*\d+[.、]/.test(l)).length;
  const out = [];
  for (let i = 1; i < count; i++) out.push({ src: i, relation: 'BEFORE', dst: i + 1 });
  return out.slice(0, 20);
}

/**
 * 测试用 mock：按顺序吐出预设回复，并记录收到的请求。
 * 用法：const p = mock({ replies: ['[...]'], dim: 8 })
 */
function mock(opts = {}) {
  const replies = opts.replies ? [...opts.replies] : [];
  const calls = [];
  const dim = opts.dim || 8;
  let embedCallCount = 0;

  return {
    name: 'mock',
    dim,
    calls,
    get embedCallCount() { return embedCallCount; },

    async chat(messages, o) {
      calls.push({ kind: 'chat', messages, opts: o || {} });
      if (replies.length === 0) throw new Error('[provider] mock: 预设回复已用尽');
      return replies.shift();
    },

    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      calls.push({ kind: 'embed', texts: list });
      embedCallCount++;
      // 确定性伪随机：同一文本永远得到同一向量，测试可复现
      return list.map((t) => hashEmbed(String(t), dim));
    }
  };
}

/** 离线归纳：把事件清单前几行拼成一句，仅用于验证管线。 */
function summarizeByRules(prompt) {
  const lines = prompt.split('\n').filter((l) => /^\s*\d+[.、]/.test(l)).slice(0, 3)
    .map((l) => l.replace(/^\s*\d+[.、]\s*/, "").trim());
  return '（离线归纳）' + lines.join('；');
}

module.exports = { openai, offline, mock, postJSON };