'use strict';
/**
 * 端到端测试：走完整条 ingest → 建图 → 检索 的链路。
 * 用 mock provider 脚本化控制 LLM 的每一句回复，断言库里最终长什么样。
 */

const { MemoryEngine, providers } = require('../src');
const { Store } = require('../src/store');

const FACTS = JSON.stringify([
  { Event: '用户答应 小忆 周末一起去游乐园，约定提前一天确认天气', Importance: 0.82, Entities: ['小忆', '用户', '游乐园'] },
  { Event: '用户在桌游板块抱怨关卡太难，小忆 建议换装备再试', Importance: 0.5, Entities: ['用户', '小忆', '装备'] }
]);
const CONCEPTS = JSON.stringify({ 游乐园: ['娱乐场所'], 装备: ['游戏道具'], 小忆: ['家人'], 用户: ['家人'] });
const STAGE1 = JSON.stringify([{ src: '用户', relation: 'PROMISED_TO_GO_WITH', dst: '小忆' }]);
const STAGE3 = JSON.stringify([{ src: 1, relation: 'BEFORE', dst: 2 }]);

function makeProvider(replies, dim = 256) {
  return providers.mock({ replies, dim });
}

async function openEngine(name, replies, extra = {}) {
  const provider = makeProvider(replies, extra.dim || 256);
  const engine = await MemoryEngine.open({
    dir: tmpDir(name),
    provider,
    persona: { personaName: '小忆', genderTerm: '用户', personaDescription: '远房表妹', personaPersonality: '活泼' },
    batchSize: 1,
    ...extra
  });
  return { engine, provider };
}

const ONE_TURN = [{ userMessage: '用户，周末带我去游乐园好不好？', aiResponse: '好啊，那我们提前一天看天气预报。' }];

describe('端到端 · 基础入库', () => {
  it('一轮对话产出事件/实体/概念三类节点', async () => {
    const { engine } = await openEngine('e2e-basic', [FACTS, CONCEPTS]);
    const stats = await engine.ingest(ONE_TURN);

    assert.equal(stats.events, 2, '应有 2 个事件');
    assert.equal(stats.entities, 4, '小忆/用户/游乐园/装备');
    assert.equal(stats.concepts, 3, '娱乐场所/游戏道具/家人');
    assert.ok(stats.embedded >= 9, `应有至少 9 个向量，实际 ${stats.embedded}`);

    const s = engine.stats();
    assert.equal(s.event, 2);
    assert.equal(s.entity, 4);
    assert.equal(s.concept, 3);
  });

  it('实体通过 participates_in 连到事件', async () => {
    const { engine } = await openEngine('e2e-edges', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);

    const xiaoyi = engine.listNodes({ nodeType: 'entity', search: '小忆' }).nodes[0];
    const edges = engine.edgesOf(xiaoyi.id);
    const toEvents = edges.filter((e) => e.relation === 'participates_in');
    assert.equal(toEvents.length, 2, '小忆 参加了两个事件');
    assert.ok(toEvents.every((e) => e.targetLabel.length > 0), '边应带上文本标签');
  });

  it('概念通过 conceptualized_as 连到实体', async () => {
    const { engine } = await openEngine('e2e-concept-edge', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);

    const park = engine.listNodes({ nodeType: 'entity', search: '游乐园' }).nodes[0];
    const edges = engine.edgesOf(park.id);
    const c = edges.find((e) => e.relation === 'conceptualized_as');
    assert.ok(c, '应有概念边');
    assert.equal(c.targetLabel, '娱乐场所');
  });

  it('舞台开关默认关闭时，stage1/stage3 不产生边', async () => {
    const { engine, provider } = await openEngine('e2e-stages-off', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    assert.equal(provider.calls.filter((c) => c.kind === 'chat').length, 2, '只应调用 2 次 LLM');

    const rels = new Set(engine.store.allEdges().map((e) => e.relation));
    assert.ok(!rels.has('promised_to_go_with'), 'stage1 默认关，不该有实体语义关系');
    assert.ok(!rels.has('before'), 'stage3 默认关，不该有事件时序关系');
  });

  it('开启 stage1/stage3 后多出对应边，且多打两次 LLM', async () => {
    const { engine, provider } = await openEngine('e2e-stages-on', [FACTS, CONCEPTS, STAGE1, STAGE3], {
      extraction: { enableStage1: true, enableStage3: true }
    });
    await engine.ingest(ONE_TURN);
    assert.equal(provider.calls.filter((c) => c.kind === 'chat').length, 4, '四阶段各一次');

    const rels = new Set(engine.store.allEdges().map((e) => e.relation));
    assert.ok(rels.has('PROMISED_TO_GO_WITH'), 'stage1: 关系名保持原样大写');
    assert.ok(rels.has('before'), 'stage3: 关系名小写化');
    // 10 条结构边 + stage1 的 1 条 + stage3 的 1 条 = 12
    assert.equal(engine.stats().totalEdges, 12, '全开后应 12 条边');
  });
});

describe('端到端 · 检索与注入', () => {
  it('相关提问能召回刚存的事件', async () => {
    const { engine } = await openEngine('e2e-recall', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);

    const r = await engine.recall('用户答应 小忆 周末一起去游乐园，约定提前一天确认天气');
    assert.ok(r.items.length >= 1, '应召回至少一条');
    assert.includes(r.promptText, '游乐园');
    assert.includes(r.promptText, '以下为系统信息');
  });

  it('完全无关的提问召回为空且 promptText 为空串', async () => {
    const { engine } = await openEngine('e2e-irrelevant', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const r = await engine.recall('量子力学中的泰勒展开公式推导');
    assert.equal(r.promptText, '', '不该注入无关记忆');
  });

  it('召回后刷新 lastUsedAt', async () => {
    const { engine } = await openEngine('e2e-touch', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const before = engine.listNodes({ nodeType: 'event' }).nodes[0];
    await new Promise((r) => setTimeout(r, 5));
    await engine.recall('用户答应 小忆 周末一起去游乐园，约定提前一天确认天气');
    const after = engine.store.getNode(before.id);
    assert.ok(after.lastUsedAt >= before.createdAt, '应被刷新');
  });

  it('search 返回结构化结果', async () => {
    const { engine } = await openEngine('e2e-search', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const hits = await engine.search('小忆 建议换装备', { minSimilarity: -1 });
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].id && hits[0].content && Number.isFinite(hits[0].score), '应带 id/content/score');
  });

  it('queryVector 可跳过向量服务', async () => {
    const { engine, provider } = await openEngine('e2e-qvec', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const embedCallsBefore = provider.calls.filter((c) => c.kind === 'embed').length;

    const { hashEmbed } = require('../src/vector');
    const r = await engine.recall('随便', { queryVector: hashEmbed('用户答应 小忆 周末一起去游乐园，约定提前一天确认天气', 256) });
    const embedCallsAfter = provider.calls.filter((c) => c.kind === 'embed').length;

    assert.equal(embedCallsAfter, embedCallsBefore, '传了 queryVector 就不该再请求向量');
    assert.ok(r.items.length >= 1, '仍应召回');
  });

  it('空查询直接返回空，不报错', async () => {
    const { engine } = await openEngine('e2e-emptyq', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const r = await engine.recall('   ');
    assert.equal(r.promptText, '');
    assert.equal(r.stats.reason, 'empty_query');
  });
});

describe('端到端 · 批次与去重', () => {
  it('未达批次阈值不会触发 LLM', async () => {
    const { engine, provider } = await openEngine('e2e-batch-idle', [FACTS, CONCEPTS], { batchSize: 3 });
    engine.enqueue({ userMessage: '第一句', aiResponse: '第一句回复' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(provider.calls.length, 0, '不该有调用');
    assert.equal(engine.stats().pending, 1, '应攒着');
  });

  it('达到批次阈值自动触发抽取', async () => {
    const { engine, provider } = await openEngine('e2e-batch-fire', [FACTS, CONCEPTS], { batchSize: 2 });
    engine.enqueue({ userMessage: '第一句', aiResponse: '第一句回复' });
    engine.enqueue({ userMessage: '第二句', aiResponse: '第二句回复' });
    await engine.flush();
    assert.ok(provider.calls.length > 0, '应已触发');
    assert.equal(engine.stats().event, 2);
  });

  it('过短的对话被丢弃', async () => {
    const { engine, provider } = await openEngine('e2e-trivial', [FACTS]);
    engine.enqueue({ userMessage: '嗯', aiResponse: '哦' });
    await engine.flush();
    assert.equal(provider.calls.length, 0, '不该为「嗯哦」付出一次 LLM 调用');
    assert.equal(engine.stats().pending, 0);
  });

  it('重复事件被合并并累加 instanceCount、提升重要度', async () => {
    const { engine } = await openEngine('e2e-dedup', [FACTS, CONCEPTS, FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const before = engine.stats().event;
    await engine.ingest(ONE_TURN);
    assert.equal(engine.stats().event, before, '事件总数不该增长');

    const ev = engine.listNodes({ nodeType: 'event', search: '游乐园' }).nodes[0];
    assert.ok(engine.store.getNode(ev.id).instanceCount >= 2, '应记下重复次数');
  });

  it('close() 会把缓冲刷完', async () => {
    const { engine } = await openEngine('e2e-close', [FACTS, CONCEPTS], { batchSize: 99 });
    engine.enqueue({ userMessage: '最后一句要紧的话', aiResponse: '好的我记住了' });
    await engine.close();
    assert.equal(engine.stats().pending, 0, '不该有残留');
    assert.equal(engine.stats().event, 2);
  });
});

describe('端到端 · 容错', () => {
  it('LLM 全挂时降级返回，不抛异常且不写脏数据', async () => {
    const p = providers.mock({ replies: ['不是JSON', '还不是JSON'] });
    const engine = await MemoryEngine.open({
      dir: tmpDir('e2e-llm-down'),
      provider: p,
      persona: { personaName: '小忆', genderTerm: '用户' }
    });
    const stats = await engine.ingest(ONE_TURN);
    assert.equal(stats.events, 0);
    assert.ok(stats.degraded, '应标记为降级');
    assert.equal(engine.stats().totalNodes, 0, '不该写进任何节点');
  });

  it('抽到事件但概念归纳失败时，事件仍然入库', async () => {
    const p = providers.mock({ replies: [FACTS, '坏掉的回复', '还是坏的'] });
    const engine = await MemoryEngine.open({
      dir: tmpDir('e2e-concept-down'),
      provider: p,
      persona: { personaName: '小忆', genderTerm: '用户' }
    });
    const stats = await engine.ingest(ONE_TURN);
    assert.equal(stats.events, 2, '事件应保住');
    assert.equal(stats.concepts, 0, '概念没有');
    assert.ok(stats.notes.some((n) => n.includes('概念')), '应有说明');
  });

  it('provider 抛异常时不会被吞掉成静默失败', async () => {
    const p = { name: 'boom', dim: 8, async embed() { return []; }, async chat() { throw new Error('网络炸了'); } };
    const engine = await MemoryEngine.open({ dir: tmpDir('e2e-throw'), provider: p, persona: {} });
    const stats = await engine.ingest(ONE_TURN);
    assert.equal(stats.events, 0);
    assert.ok(stats.degraded);
  });
});

describe('端到端 · 持久化与管理', () => {
  it('关掉重开后记忆还在', async () => {
    const dir = tmpDir('e2e-reopen');
    const provider = makeProvider([FACTS, CONCEPTS]);
    const e1 = await MemoryEngine.open({ dir, provider, persona: { personaName: '小忆', genderTerm: '用户' } });
    await e1.ingest(ONE_TURN);
    const n1 = e1.stats().totalNodes;
    assert.ok(n1 > 0);

    const provider2 = makeProvider([], 256);
    const e2 = await MemoryEngine.open({ dir, provider: provider2, persona: { personaName: '小忆', genderTerm: '用户' } });
    assert.equal(e2.stats().totalNodes, n1, '节点数应一致');
    const r = await e2.recall('用户答应 小忆 周末一起去游乐园，约定提前一天确认天气');
    assert.ok(r.items.length >= 1, '重开后仍能召回');
  });

  it('markCustom 后检索加分且不被衰减', async () => {
    const { engine } = await openEngine('e2e-custom', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const ev = engine.listNodes({ nodeType: 'event' }).nodes[0];
    assert.ok(engine.markCustom(ev.id));
    const n = engine.store.getNode(ev.id);
    assert.ok(n.custom, '应标记成功');
    assert.near(n.importance, 1, 1e-9, '应置为满重要度');

    // 造一个极老的日期，验证不会被衰减
    engine.store.updateNode(ev.id, { createdAt: Date.now() - 400 * 86400000, lastDecayAt: Date.now() - 400 * 86400000 });
    engine.maintain({ minImportance: 0.9 });
    assert.ok(engine.store.getNode(ev.id), '手标记不该被删');
  });

  it('unmarkCustom 恢复可衰减', async () => {
    const { engine } = await openEngine('e2e-unmark', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const ev = engine.listNodes({ nodeType: 'event' }).nodes[0];
    engine.markCustom(ev.id);
    assert.ok(engine.unmarkCustom(ev.id));
    assert.ok(!engine.store.getNode(ev.id).custom);
  });

  it('deleteNode 生效', async () => {
    const { engine } = await openEngine('e2e-del', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const ev = engine.listNodes({ nodeType: 'event' }).nodes[0];
    assert.ok(engine.deleteNode(ev.id));
    assert.equal(engine.store.getNode(ev.id), null);
  });

  it('listNodes 支持按类型和关键词过滤 + 分页', async () => {
    const { engine } = await openEngine('e2e-list', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const all = engine.listNodes({});
    assert.equal(all.total, 9);
    const entities = engine.listNodes({ nodeType: 'entity' });
    assert.equal(entities.total, 4);
    const one = engine.listNodes({}, ).nodes.slice(0, 2);
    const paged = engine.listNodes({ limit: 2 });
    assert.equal(paged.nodes.length, 2);
    assert.equal(paged.total, 9, 'total 应是过滤后的总数而非本页数');
  });

  it('rebuildVectors 重算全部向量', async () => {
    const { engine } = await openEngine('e2e-rebuild', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const n = await engine.rebuildVectors();
    assert.equal(n, 9, '应重算 9 个');
    const all = engine.store.allNodes();
    assert.ok(all.every((x) => x.vector && x.vector.length === 256), '维度应正确');
  });

  it('stats 反映真实状态', async () => {
    const { engine } = await openEngine('e2e-stats', [FACTS, CONCEPTS]);
    await engine.ingest(ONE_TURN);
    const s = engine.stats();
    assert.equal(s.totalNodes, 9);
    // 默认（stage1/stage3 关闭）只有结构边：
    //   participates_in 2 事件 × 各自 3 实体 = 6
    //   conceptualized_as 4 实体 → 各 1 概念 = 4
    assert.equal(s.totalEdges, 10, '默认应只有 10 条结构边');
    assert.ok(s.dbSizeBytes > 0);
    assert.equal(s.pending, 0);
    assert.includes(s.provider, 'mock');
  });
});

describe('端到端 · 多存档槽隔离', () => {
  it('两个目录互不干扰', async () => {
    const base = tmpDir('e2e-slots');
    const p1 = makeProvider([FACTS, CONCEPTS]);
    const p2 = makeProvider([FACTS, CONCEPTS]);
    const e1 = await MemoryEngine.open({ dir: require('path').join(base, 'slot1'), provider: p1, persona: { personaName: 'A', genderTerm: '你' } });
    const e2 = await MemoryEngine.open({ dir: require('path').join(base, 'slot2'), provider: p2, persona: { personaName: 'B', genderTerm: '你' } });

    await e1.ingest(ONE_TURN);
    assert.equal(e2.stats().totalNodes, 0, 'slot2 不该看到 slot1 的数据');
    await e2.ingest(ONE_TURN);
    assert.equal(e1.stats().totalNodes, 9);
    assert.equal(e2.stats().totalNodes, 9);
  });
});