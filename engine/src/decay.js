'use strict';
/**
 * 维护：衰减与裁剪。模拟「人会忘事」。
 *
 * 两件事分开：
 *   1) decay()   —— 给长期没被用到的记忆降 importance。半衰期 30 天。
 *                   但刚记下的 7 天是宽限期，不动它（避免新记忆立刻被判死刑）。
 *   2) prune()   —— 低于 minImportance 的节点删除；概念池超上限时淘汰最冷的。
 *
 * importance 是「绝对重要度」，不随时间自动回升；而检索排序里的 recency
 * 是「相对新鲜度」，每次都实时算。两者互不干扰。
 */

const DEFAULTS = {
  halfLifeDays: 30,
  graceDays: 7,
  minImportance: 0.2,
  maxConcepts: 1000,
  conceptMaxAgeDays: 60
};

/**
 * 指数衰减。经过一个半衰期，importance 乘 0.5。
 * 只在「距上次衰减」满一天时才动手，否则频繁调用会把记忆磨没。
 */
function decay(store, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = cfg.nowMs || Date.now();
  const dayMs = 86400000;
  let touched = 0;
  let removed = 0;

  const toRemove = [];
  for (const node of store.nodes.values()) {
    if (node.custom) continue; // 手标记的记忆永不衰减

    const createdAt = node.createdAt || now;
    if (now - createdAt < cfg.graceDays * dayMs) continue;

    const last = node.lastDecayAt || createdAt;
    const elapsedDays = (now - last) / dayMs;
    if (elapsedDays < 1) continue;

    const factor = Math.pow(0.5, elapsedDays / cfg.halfLifeDays);
    const next = (Number.isFinite(node.importance) ? node.importance : 0.5) * factor;

    if (next < cfg.minImportance) {
      toRemove.push(node.id);
      continue;
    }
    store.updateNode(node.id, { importance: next, lastDecayAt: now });
    touched++;
  }

  for (const id of toRemove) {
    if (store.deleteNode(id)) removed++;
  }
  return { touched, removed, decayedAt: now };
}

/**
 * 概念池裁剪：按 lastUsedAt 从冷到热淘汰，只留 maxConcepts 个。
 * 不裁事件与实体 —— 那是记忆本体，不该因为数量就被砍。
 */
function prune(store, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = cfg.nowMs || Date.now();
  const concepts = store.allNodes().filter((n) => n.nodeType === 'concept');
  const removed = [];

  const staleMs = cfg.conceptMaxAgeDays * 86400000;
  const keep = [];
  for (const c of concepts) {
    const lastUsed = c.lastUsedAt || c.createdAt || now;
    if (now - lastUsed > staleMs) removed.push(c);
    else keep.push(c);
  }

  if (keep.length > cfg.maxConcepts) {
    keep.sort((a, b) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0));
    const overflow = keep.length - cfg.maxConcepts;
    removed.push(...keep.splice(0, overflow));
  }

  for (const c of removed) store.deleteNode(c.id);
  return { removed: removed.map((c) => ({ id: c.id, content: c.content })), kept: keep.length };
}

/** 维护总入口。顺带在墓碑太多时压实文件。 */
function maintain(store, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const d = decay(store, cfg);
  const p = prune(store, cfg);
  let compacted = null;
  if (store.deleteRatio() > (cfg.compactThreshold ?? 0.3)) compacted = store.compact();
  return { decay: d, prune: p, compacted };
}

module.exports = { decay, prune, maintain, DEFAULTS };