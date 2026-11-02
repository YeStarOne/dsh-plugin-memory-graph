'use strict';
/**
 * 检索侧：向量召回 → 图扩展 → 重排 → 取前 N → 拼提示词。
 *
 * 几个关键行为：
 *   - 默认只召回 event 节点。实体/概念虽然也存了向量，但不直接进提示词，
 *     它们的作用是建图（可视化）和做子图扩展。
 *   - 相似度门限作用在「候选事件自身与查询的相似度」上，不是重排后的综合分。
 *     所以哪怕查询命中了某个实体，只要它关联的事件本身不像，仍然会被挡掉。
 *   - 重排是加权和，权重可配。
 */

const { cosine } = require('./vector');
const { TEMPLATES } = require('./prompts');

const DEFAULTS = {
  topK: 10,
  hopDepth: 4,
  maxSubgraphNodes: 30,
  rerankTopN: 5,
  minSimilarity: 0.25,
  weights: {
    similarity: 0.5,
    importance: 0.3,
    recency: 0.2,
    customBonus: 0.3,
    decayRate: 0.01
  }
};

/**
 * 时间新近度：指数衰减，值域 (0,1]。
 * decayRate=0.01 的含义是「每天衰减 1%」，约 69 天后打对折。
 * 与维护期的 halfLifeDays 是两套东西：那个管的是「遗忘」，这个只管「排序偏好」。
 */
function recencyScore(timestampMs, nowMs, decayRate) {
  const days = Math.max(0, (nowMs - timestampMs) / 86400000);
  return Math.exp(-decayRate * days);
}

/**
 * 综合打分。
 * 手标记（custom）的记忆额外加分，用来实现「这条不许忘」。
 */
function scoreNode(node, similarity, nowMs, w) {
  const importance = Number.isFinite(node.importance) ? node.importance : 0.5;
  const recency = recencyScore(node.createdAt || nowMs, nowMs, w.decayRate);
  let score = w.similarity * similarity + w.importance * importance + w.recency * recency;
  if (node.custom) score += w.customBonus;
  return { score, similarity, importance, recency };
}

/**
 * 向量召回。
 * 扫 event 与 summary 节点 —— 实体/概念只用来建图和做子图扩展；
 * summary 是摘要层产出的长期主题，和事件一样直接进提示词。
 */
function recall(store, queryVec, topK) {
  const hits = [];
  for (const node of store.nodes.values()) {
    if (node.nodeType !== 'event' && node.nodeType !== 'summary') continue;
    if (!node.vector || node.vector.length !== queryVec.length) continue;
    hits.push({ node, similarity: cosine(queryVec, node.vector) });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, Math.max(1, topK));
}

/**
 * 子图扩展：从种子节点出发，向外走 hopDepth 跳，收集沿途的 event 节点。
 * 用途是「虽然这条记忆本身不像，但它和像的那条有关系，也该带上」。
 *
 * 默认门限下，扩展进来的低相似度事件多半会被门限挡掉；
 * 若把 minSimilarity 调到 <= 0，扩展的效果立刻可见。
 */
function expand(store, seeds, hopDepth, maxNodes) {
  const visited = new Set(seeds.map((s) => s.node.id));
  const found = new Map(seeds.map((s) => [s.node.id, s]));
  if (hopDepth <= 0) return Array.from(found.values());

  let frontier = seeds.map((s) => s.node.id);
  for (let hop = 0; hop < hopDepth && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const edge of store.edgesOf(id)) {
        const other = edge.sourceId === id ? edge.targetId : edge.sourceId;
        if (visited.has(other)) continue;
        visited.add(other);
        const node = store.getNode(other);
        if (!node) continue;
        if (node.nodeType === 'event' || node.nodeType === 'summary') {
          found.set(node.id, { node, similarity: 0, viaGraph: true });
          if (found.size >= maxNodes) return Array.from(found.values());
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return Array.from(found.values());
}

/** 人类可读的相对时间。 */
function humanizeAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}个月前`;
  return `${Math.floor(mo / 12)}年前`;
}

/**
 * 完整检索流程。
 * @returns {{promptText:string, items:Array, stats:object}}
 */
function retrieve(store, queryVec, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts, weights: { ...DEFAULTS.weights, ...(opts.weights || {}) } };
  const nowMs = opts.nowMs || Date.now();

  const seeds = recall(store, queryVec, cfg.topK);
  const expanded = expand(store, seeds, cfg.hopDepth, cfg.maxSubgraphNodes);

  // 扩进来的节点没有种子相似度，用它与查询的真实相似度补上更好
  const scored = [];
  for (const cand of expanded) {
    const sim = cand.viaGraph ? cosine(queryVec, cand.node.vector) : cand.similarity;
    if (sim < cfg.minSimilarity) continue;
    const { score, importance, recency } = scoreNode(cand.node, sim, nowMs, cfg.weights);
    scored.push({ node: cand.node, score, similarity: sim, importance, recency, viaGraph: !!cand.viaGraph });
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(0, cfg.rerankTopN));

  return {
    promptText: formatPrompt(picked, nowMs),
    items: picked,
    stats: {
      scanned: store.nodeCount(),
      seeds: seeds.length,
      expanded: expanded.length,
      passed: scored.length,
      returned: picked.length
    }
  };
}

/** 拼成给 LLM 看的提示词块。头部文案的作用是防止模型把记忆当成用户发言。 */
function formatPrompt(items, nowMs) {
  if (!items.length) return '';
  const header = TEMPLATES.retrievedMemoryHeader;
  const lines = items.map((it) => `- ${it.node.content}（${humanizeAge(nowMs - (it.node.createdAt || nowMs))}）`);
  return `${header}${lines.join('\n')}\n`;
}

module.exports = { retrieve, recall, expand, formatPrompt, humanizeAge, recencyScore, scoreNode, DEFAULTS };