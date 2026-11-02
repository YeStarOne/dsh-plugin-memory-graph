'use strict';
/** 检索测试：召回、门限、图扩展、重排、提示词形状。 */

const { Store } = require('../src/store');
const { retrieve, humanizeAge, recencyScore, recall, expand } = require('../src/retrieve');
const { normalize, hashEmbed, cosine } = require('../src/vector');

/** 造一个可控的小库：3 个事件 + 实体 + 边。 */
function fixture() {
  const s = Store.open(tmpDir('retrieve'));
  const now = Date.now();
  const v = (t) => Array.from(hashEmbed(t, 512));

  s.putNode({ id: 'ev1', nodeType: 'event', content: '用户答应 小忆 周末一起去游乐园', importance: 0.82, createdAt: now, vector: v('用户答应 小忆 周末一起去游乐园') });
  s.putNode({ id: 'ev2', nodeType: 'event', content: '用户在桌游板块抱怨关卡太难', importance: 0.5, createdAt: now - 3 * 86400000, vector: v('用户在桌游板块抱怨关卡太难') });
  s.putNode({ id: 'ev3', nodeType: 'event', content: '小忆 今天学会了做草莓蛋糕', importance: 0.9, createdAt: now - 40 * 86400000, vector: v('小忆 今天学会了做草莓蛋糕') });
  s.putNode({ id: 'en1', nodeType: 'entity', content: '游乐园', importance: 0.82, createdAt: now, vector: v('游乐园') });
  s.putNode({ id: 'cn1', nodeType: 'concept', content: '娱乐场所', importance: 0.82, createdAt: now, vector: v('娱乐场所') });

  s.putEdge({ id: 'e1', sourceId: 'en1', targetId: 'ev1', relation: 'participates_in', weight: 1, createdAt: now });
  s.putEdge({ id: 'e2', sourceId: 'en1', targetId: 'cn1', relation: 'conceptualized_as', weight: 1, createdAt: now });
  s.putEdge({ id: 'e3', sourceId: 'ev1', targetId: 'ev2', relation: 'before', weight: 1, createdAt: now });
  return s;
}

describe('检索 · 召回', () => {
  it('只扫 event 节点，不直接返回实体/概念', () => {
    const s = fixture();
    const hits = recall(s, hashEmbed('游乐园', 512), 10);
    assert.equal(hits.length, 3, '库里 3 个 event 应全在候选里');
    assert.ok(hits.every((h) => h.node.nodeType === 'event'), '不应含非 event');
  });

  it('维度不符的节点被跳过而不是崩溃', () => {
    const s = Store.open(tmpDir('retrieve-dim'));
    const now = Date.now();
    s.putNode({ id: 'a', nodeType: 'event', content: 'x', importance: 0.5, createdAt: now, vector: [1, 0, 0] });
    s.putNode({ id: 'b', nodeType: 'event', content: 'y', importance: 0.5, createdAt: now, vector: [1, 0] });
    const hits = recall(s, normalize([1, 0, 0]), 10);
    assert.equal(hits.length, 1, '维度不符的应被跳过');
  });

  it('无向量的节点不出现在候选里', () => {
    const s = Store.open(tmpDir('retrieve-novec'));
    s.putNode({ id: 'a', nodeType: 'event', content: 'x', importance: 0.5, createdAt: Date.now() });
    const hits = recall(s, normalize([1, 0, 0]), 10);
    assert.equal(hits.length, 0);
  });

  it('按相似度降序返回', () => {
    const s = fixture();
    const q = hashEmbed('用户答应 小忆 周末一起去游乐园', 512);
    const hits = recall(s, q, 10);
    assert.equal(hits[0].node.id, 'ev1', '最像的应排第一');
  });
});

describe('检索 · 相似度门限', () => {
  it('门限过高时什么都不返回', () => {
    const s = fixture();
    const q = hashEmbed('游乐园', 512);
    const r = retrieve(s, q, { minSimilarity: 0.99, rerankTopN: 5 });
    assert.equal(r.items.length, 0);
  });

  it('门限设成 0 以下时全部返回', () => {
    const s = fixture();
    const q = hashEmbed('游乐园', 512);
    const r = retrieve(s, q, { minSimilarity: -1, rerankTopN: 10 });
    assert.equal(r.items.length, 3);
  });

  it('门限作用在候选事件自身的相似度上', () => {
    const s = fixture();
    // 查询与 ev1 完全一致，ev2/ev3 明显不像
    const q = hashEmbed('用户答应 小忆 周末一起去游乐园', 512);
    const loose = retrieve(s, q, { minSimilarity: -1, rerankTopN: 10 });
    const strict = retrieve(s, q, { minSimilarity: 0.5, rerankTopN: 10 });
    assert.ok(loose.items.length > strict.items.length, '严门限应筛掉更多');
    assert.equal(strict.items[0].node.id, 'ev1');
  });
});

describe('检索 · 图扩展', () => {
  it('hopDepth=0 时不扩展', () => {
    const s = fixture();
    const seeds = [{ node: s.getNode('ev1'), similarity: 1 }];
    const out = expand(s, seeds, 0, 30);
    assert.equal(out.length, 1);
  });

  it('hopDepth>0 时沿边走到相邻事件', () => {
    const s = fixture();
    const seeds = [{ node: s.getNode('ev1'), similarity: 1 }];
    const out = expand(s, seeds, 1, 30);
    const ids = out.map((o) => o.node.id);
    assert.ok(ids.includes('ev2'), 'ev1 通过 before 边连到 ev2，应被扩进来');
  });

  it('maxSubgraphNodes 能限制扩展规模', () => {
    const s = fixture();
    const seeds = [{ node: s.getNode('ev1'), similarity: 1 }];
    const out = expand(s, seeds, 4, 2);
    assert.ok(out.length <= 2, `应受上限约束，实际 ${out.length}`);
  });

  it('扩展不会重复访问同一节点', () => {
    const s = fixture();
    const seeds = [{ node: s.getNode('ev1'), similarity: 1 }];
    const out = expand(s, seeds, 4, 30);
    const ids = out.map((o) => o.node.id);
    assert.equal(new Set(ids).size, ids.length, '不应有重复');
  });

  it('沿子图扩展能把关联事件带回（门限放宽时可见）', () => {
    const s = fixture();
    const q = hashEmbed('用户答应 小忆 周末一起去游乐园', 512);
    // topK=1 时只有 ev1 是种子，ev2 必须靠图扩展捞回来；ev3 与谁都不相连，不该出现。
    // 门限设为 -1 是为了让扩进来的低相似度事件不被筛掉 —— 默认 0.25 下看不出扩展效果。
    const r = retrieve(s, q, { minSimilarity: -1, hopDepth: 4, rerankTopN: 10, topK: 1 });
    assert.equal(r.stats.seeds, 1, '只应有 1 个种子');
    const ids = r.items.map((i) => i.node.id);
    assert.ok(ids.includes('ev1'), 'ev1 是种子，必在');
    assert.ok(ids.includes('ev2'), 'ev2 通过 before 边扩展进来');
    assert.ok(!ids.includes('ev3'), 'ev3 孤立，不该凭空出现');
    assert.ok(r.items.find((i) => i.node.id === 'ev2').viaGraph, 'ev2 应标记为来自图扩展');
  });

  it('默认门限下，扩进来的低相似度事件会被筛掉', () => {
    const s = fixture();
    const q = hashEmbed('用户答应 小忆 周末一起去游乐园', 512);
    const r = retrieve(s, q, { topK: 1, hopDepth: 4, rerankTopN: 10 });
    const ids = r.items.map((i) => i.node.id);
    assert.ok(ids.includes('ev1'), '种子相似度足够，留下');
    assert.ok(!ids.includes('ev2'), 'ev2 本身不像，被 0.25 门限挡掉');
  });
});

describe('检索 · 重排', () => {
  it('重排数量受 rerankTopN 限制', () => {
    const s = fixture();
    const q = hashEmbed('游乐园', 512);
    const r = retrieve(s, q, { minSimilarity: -1, rerankTopN: 2 });
    assert.equal(r.items.length, 2);
  });

  it('同等相似度下，重要度高的排前面', () => {
    const s = Store.open(tmpDir('rerank-imp'));
    const now = Date.now();
    const vec = Array.from(normalize([1, 0, 0]));
    s.putNode({ id: 'low', nodeType: 'event', content: '低重要度', importance: 0.3, createdAt: now, vector: vec });
    s.putNode({ id: 'high', nodeType: 'event', content: '高重要度', importance: 0.95, createdAt: now, vector: vec });
    const r = retrieve(s, normalize([1, 0, 0]), { minSimilarity: -1, rerankTopN: 5 });
    assert.equal(r.items[0].node.id, 'high', '同相似度下应看重重要度');
  });

  it('同等相似度与重要度下，新的排前面', () => {
    const s = Store.open(tmpDir('rerank-rec'));
    const now = Date.now();
    const vec = Array.from(normalize([1, 0, 0]));
    s.putNode({ id: 'old', nodeType: 'event', content: '老记忆', importance: 0.6, createdAt: now - 100 * 86400000, vector: vec });
    s.putNode({ id: 'new', nodeType: 'event', content: '新记忆', importance: 0.6, createdAt: now, vector: vec });
    const r = retrieve(s, normalize([1, 0, 0]), { minSimilarity: -1, rerankTopN: 5, nowMs: now });
    assert.equal(r.items[0].node.id, 'new', '同条件下新的应靠前');
  });

  it('手标记的记忆有额外加分', () => {
    const s = Store.open(tmpDir('rerank-custom'));
    const now = Date.now();
    const vec = Array.from(normalize([1, 0, 0]));
    s.putNode({ id: 'plain', nodeType: 'event', content: '普通', importance: 0.7, createdAt: now, vector: vec });
    s.putNode({ id: 'custom', nodeType: 'event', content: '手标记', importance: 0.7, createdAt: now, vector: vec, custom: true });
    const r = retrieve(s, normalize([1, 0, 0]), { minSimilarity: -1, rerankTopN: 5, nowMs: now });
    assert.equal(r.items[0].node.id, 'custom', '手标记应加 0.3 分');
  });

  it('返回结果带完整的评分明细，便于调试', () => {
    const s = fixture();
    const r = retrieve(s, hashEmbed('游乐园', 512), { minSimilarity: -1, rerankTopN: 1 });
    const it = r.items[0];
    assert.ok(Number.isFinite(it.score), 'score');
    assert.ok(Number.isFinite(it.similarity), 'similarity');
    assert.ok(Number.isFinite(it.importance), 'importance');
    assert.ok(Number.isFinite(it.recency), 'recency');
  });
});

describe('检索 · 提示词拼装', () => {
  it('有结果时带防误读头部', () => {
    const s = fixture();
    const r = retrieve(s, hashEmbed('游乐园', 512), { minSimilarity: -1, rerankTopN: 1 });
    assert.includes(r.promptText, '以下为系统信息', '应有头部');
    assert.includes(r.promptText, '非用户发言', '应声明不是用户说的');
    assert.includes(r.promptText, '- ', '应为列表项');
  });

  it('无结果时返回空串而不是只有头部', () => {
    const s = fixture();
    const r = retrieve(s, hashEmbed('无关内容', 512), { minSimilarity: 0.9999 });
    assert.equal(r.promptText, '', '不该返回只有头部的残缺文本');
  });

  it('每条记忆附带相对时间', () => {
    const s = fixture();
    const r = retrieve(s, hashEmbed('游乐园', 512), { minSimilarity: -1, rerankTopN: 5 });
    assert.includes(r.promptText, '（', '应有时间括号');
    assert.includes(r.promptText, '刚刚', '刚建的记忆应是「刚刚」');
  });

  it('stats 反映各阶段数量，便于观测', () => {
    const s = fixture();
    const r = retrieve(s, hashEmbed('游乐园', 512), { minSimilarity: -1, rerankTopN: 2 });
    assert.equal(r.stats.seeds, 3, '种子数=事件总数');
    assert.ok(r.stats.expanded >= r.stats.seeds, '扩展数不小于种子数');
    assert.equal(r.stats.returned, 2, '返回数应等于 rerankTopN');
  });
});

describe('检索 · 时间工具', () => {
  it('humanizeAge 各档位', () => {
    assert.equal(humanizeAge(10 * 1000), '刚刚');
    assert.equal(humanizeAge(5 * 60 * 1000), '5分钟前');
    assert.equal(humanizeAge(3 * 3600 * 1000), '3小时前');
    assert.equal(humanizeAge(2 * 86400000), '2天前');
    assert.equal(humanizeAge(60 * 86400000), '2个月前');
    assert.equal(humanizeAge(400 * 86400000), '1年前');
  });

  it('recencyScore 单调递减且落在 (0,1]', () => {
    const now = Date.now();
    const a = recencyScore(now, now, 0.01);
    const b = recencyScore(now - 10 * 86400000, now, 0.01);
    assert.near(a, 1, 1e-9, '当天应为 1');
    assert.ok(b < a && b > 0, '越旧越低但不为负');
  });
});