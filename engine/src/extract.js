'use strict';
/**
 * 抽取管线：把「一段对话」变成「一堆可入库的结构化事实」。
 *
 * 四阶段：
 *   ① 事实抽取   fact_extraction      对话 → 事件（Event / Importance / Entities）
 *   ② 概念归纳   conceptualization    实体 → 概念标签（防概念池膨胀）
 *   ③ stage1     stage1_relations     实体 ↔ 实体 的语义关系（默认关）
 *   ④ stage3     stage3_relations     事件 ↔ 事件 的时序/因果（默认关）
 *
 * 设计要点：
 *   - LLM 输出永远不可信。这里对每个阶段都做「宽松解析」：
 *     先从回复里抠出第一段 JSON，容忍 ```json 围栏、前后废话、尾随逗号。
 *     解析失败重试一次（把报错回喂给模型让它改），仍失败就降级返回空数组
 *     而不是抛异常 —— 记忆抽取失败不该让整轮对话崩掉。
 *   - 事件文本做归一化去重，避免同一件事被反复入库。
 */

const { TEMPLATES, fill } = require('./prompts');

/** 从可能带围栏/废话的文本里抠出第一段合法 JSON。 */
function looseParse(text) {
  if (text == null) return null;
  let s = String(text).trim();

  // 去掉 ```json ... ``` 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();

  // 直接试
  const attempts = [s];
  // 抠第一个 [...] 或 {...}
  const arr = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arr >= 0 && arrEnd > arr) attempts.push(s.slice(arr, arrEnd + 1));
  const obj = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (obj >= 0 && objEnd > obj) attempts.push(s.slice(obj, objEnd + 1));

  for (const a of attempts) {
    try { return JSON.parse(a); } catch (_) { /* 继续试下一种 */ }
    // 尾随逗号是 LLM 最常见的语法错误，单独修一次
    try {
      return JSON.parse(a.replace(/,\s*([}\]])/g, '$1'));
    } catch (_) { /* 交给下一个候选 */ }
  }
  return null;
}

/** 事件文本归一化：去空白、统一标点，用于去重判断。 */
function normalizeEventText(s) {
  return String(s || '')
    .replace(/[\s\u200b-\u200f\u2028-\u202f\u3000\ufeff]+/g, '')
    .replace(/[，。！？；：、"'']/g, '')
    .toLowerCase();
}

/** 裁剪到合理范围，防止 LLM 吐出 999 或 -1 这种越界值。 */
function clamp01(x, fallback) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function asStringArray(v, limit = 20) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = String(x == null ? '' : x).trim();
    if (s && s.length <= 40 && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** 带一次「把错误回喂」重试的调用。 */
async function chatJson(provider, prompt, opts = {}) {
  const messages = [{ role: 'user', content: prompt }];
  const first = await provider.chat(messages, opts);
  let parsed = looseParse(first);
  if (parsed !== null) return { parsed, raw: first, retried: false };

  if (opts.retryOnParseError === false) return { parsed: null, raw: first, retried: false };

  const repair = [
    ...messages,
    { role: 'assistant', content: first },
    {
      role: 'user',
      content: '你上面的回复不是合法 JSON。请只输出合法 JSON，不要任何解释、不要代码围栏。'
    }
  ];
  try {
    const second = await provider.chat(repair, opts);
    parsed = looseParse(second);
    return { parsed, raw: second, retried: true };
  } catch (_) {
    return { parsed: null, raw: first, retried: true };
  }
}

/**
 * ① 事实抽取。
 * @returns {Promise<{events: Array, usage: object, raw: string, builtPrompt: string}>}
 */
async function extractFacts(provider, ctx) {
  const personaSection = buildPersonaSection(ctx);
  const conversation = formatConversation(ctx.items, ctx.personaName, ctx.genderTerm);
  const builtPrompt = fill(TEMPLATES.factExtractionTemplate, {
    persona_name: ctx.personaName || '助手',
    gender_term: ctx.genderTerm || '你',
    persona_section: personaSection,
    conversation_text: conversation,
    target: ctx.targetEvents || Math.max(1, Math.min(5, ctx.items.length))
  });

  const { parsed, raw } = await chatJson(provider, builtPrompt, { timeoutMs: ctx.timeoutMs });
  const list = Array.isArray(parsed) ? parsed : [];
  const events = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.Event ?? item.event ?? '').trim();
    if (!text || text.length > 500) continue;
    const key = normalizeEventText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    events.push({
      text,
      importance: clamp01(item.Importance ?? item.importance, ctx.importanceDefaults?.event ?? 0.5),
      entities: asStringArray(item.Entities ?? item.entities)
    });
  }
  return { events, raw, builtPrompt, retried: false };
}

/**
 * ② 概念归纳。给每个实体贴 1~N 个概念标签，优先复用已有概念池。
 * @returns {Promise<Map<string,string[]>>} 实体名 -> 概念数组
 */
async function conceptualize(provider, ctx, entityNames, existingConcepts) {
  const out = new Map();
  if (!entityNames.length) return out;
  if (ctx.enableDynamicConcept === false) return out;

  const limit = ctx.existingConceptsLimit ?? 50;
  const pool = (existingConcepts || []).slice(0, limit);
  const builtPrompt = fill(TEMPLATES.conceptualizationTemplate, {
    persona_name: ctx.personaName || '助手',
    max_new_concepts: ctx.maxNewConcepts ?? 5,
    existing_concepts: pool.length ? pool.map((c) => `- ${c}`).join('\n') : '（暂无，可自由创建）',
    entities: entityNames.map((e) => `- ${e}`).join('\n')
  });

  const { parsed } = await chatJson(provider, builtPrompt, { timeoutMs: ctx.timeoutMs });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  const maxN = ctx.maxNewConcepts ?? 5;
  for (const [name, concepts] of Object.entries(parsed)) {
    const key = String(name).trim();
    // 实体名本身不能当概念标签（提示词里的硬规则，代码里再守一道）
    const list = asStringArray(concepts, maxN).filter((c) => c !== key && c.length >= 2);
    if (key && list.length) out.set(key, list);
  }
  return out;
}

/**
 * ③ stage1：实体之间的语义关系。relation 强制 SCREAMING_SNAKE_CASE。
 * @returns {Promise<Array<{src:string,relation:string,dst:string}>>}
 */
async function extractEntityRelations(provider, ctx, entityNames, conversationText) {
  if (ctx.enableStage1 !== true) return [];
  if (entityNames.length < 2) return [];

  const builtPrompt = fill(TEMPLATES.stage1RelationTemplate, {
    persona_name: ctx.personaName || '助手',
    max_relations: ctx.maxRelationsPerBatch ?? 20,
    entities: entityNames.map((e) => `- ${e}`).join('\n'),
    conversation_text: conversationText
  });

  const { parsed } = await chatJson(provider, builtPrompt, { timeoutMs: ctx.timeoutMs });
  if (!Array.isArray(parsed)) return [];

  const allow = new Set(entityNames);
  const out = [];
  for (const t of parsed) {
    if (!t || typeof t !== 'object') continue;
    const src = String(t.src ?? '').trim();
    const dst = String(t.dst ?? '').trim();
    const relation = String(t.relation ?? '').trim().toUpperCase();
    if (!allow.has(src) || !allow.has(dst) || src === dst) continue;
    // 强制格式，杜绝 LLM 写中文/空格/小写
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(relation)) continue;
    if (out.some((r) => r.src === src && r.dst === dst)) continue;
    out.push({ src, relation, dst });
    if (out.length >= (ctx.maxRelationsPerBatch ?? 20)) break;
  }
  return out;
}

/**
 * ④ stage3：事件之间的时序/因果关系。
 * @returns {Promise<Array<{src:number,relation:string,dst:number}>>}
 */
async function extractEventRelations(provider, ctx, events) {
  if (ctx.enableStage3 !== true) return [];
  if (events.length < 2) return [];

  const builtPrompt = fill(TEMPLATES.stage3EventRelationTemplate, {
    persona_name: ctx.personaName || '助手',
    max_relations: ctx.maxRelationsPerBatch ?? 20,
    events: events.map((e, i) => `${i + 1}. ${e.text}`).join('\n')
  });

  const { parsed } = await chatJson(provider, builtPrompt, { timeoutMs: ctx.timeoutMs });
  if (!Array.isArray(parsed)) return [];

  const ALLOWED = new Set(['BEFORE', 'AFTER', 'AT_SAME_TIME', 'BECAUSE', 'AS_RESULT']);
  const out = [];
  for (const t of parsed) {
    if (!t || typeof t !== 'object') continue;
    const src = Number(t.src);
    const dst = Number(t.dst);
    const relation = String(t.relation ?? '').trim().toUpperCase();
    if (!Number.isInteger(src) || !Number.isInteger(dst)) continue;
    if (src < 1 || src > events.length || dst < 1 || dst > events.length) continue;
    if (src === dst || !ALLOWED.has(relation)) continue;
    // BEFORE 与 AFTER 互斥，保留先出现的
    const conflict = relation === 'BEFORE' ? 'AFTER' : relation === 'AFTER' ? 'BEFORE' : null;
    if (conflict && out.some((r) => r.src === src && r.dst === dst && r.relation === conflict)) continue;
    if (out.some((r) => r.src === src && r.dst === dst && r.relation === relation)) continue;
    out.push({ src, relation, dst });
    if (out.length >= (ctx.maxRelationsPerBatch ?? 20)) break;
  }
  return out;
}

/** 角色设定段落。留空则不产生这一段。 */
function buildPersonaSection(ctx) {
  const lines = [];
  if (ctx.personaDescription) lines.push(`你的角色设定：${ctx.personaDescription}`);
  if (ctx.personaPersonality) lines.push(`你的性格特征：${ctx.personaPersonality}`);
  return lines.join('\n');
}

/** 把对话轮次拼成「说话人:内容」的文本，供 LLM 阅读。 */
function formatConversation(items, personaName, genderTerm) {
  const who = personaName || '助手';
  const player = genderTerm || '你';
  const lines = [];
  for (const it of items || []) {
    if (it.userMessage) lines.push(`${player}:${it.userMessage}`);
    if (it.aiResponse) lines.push(`${who}:${it.aiResponse}`);
  }
  return lines.join('\n');
}

module.exports = {
  extractFacts,
  conceptualize,
  extractEntityRelations,
  extractEventRelations,
  looseParse,
  normalizeEventText,
  formatConversation,
  buildPersonaSection
};