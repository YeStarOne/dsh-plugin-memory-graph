'use strict';
/** 抽取管线测试：宽松解析、四阶段、各种脏输入的容错。 */

const {
  looseParse, extractFacts, conceptualize, extractEntityRelations, extractEventRelations,
  normalizeEventText, formatConversation, buildPersonaSection
} = require('../src/extract');
const { providers } = require('../src');

describe('抽取 · 宽松 JSON 解析', () => {
  it('解析裸 JSON 数组', () => {
    const r = looseParse('[{"Event":"a"}]');
    assert.equal(r.length, 1);
    assert.equal(r[0].Event, 'a');
  });

  it('剥掉 ```json 围栏', () => {
    const r = looseParse('```json\n[{"Event":"a"}]\n```');
    assert.equal(r[0].Event, 'a');
  });

  it('剥掉无语言标记的围栏', () => {
    const r = looseParse('```\n[{"Event":"a"}]\n```');
    assert.equal(r[0].Event, 'a');
  });

  it('容忍前后废话', () => {
    const r = looseParse('好的，以下是提取结果：\n[{"Event":"a"}]\n希望有帮助！');
    assert.equal(r[0].Event, 'a');
  });

  it('容忍尾随逗号', () => {
    const r = looseParse('[{"Event":"a"},]');
    assert.equal(r.length, 1);
  });

  it('解析 JSON 对象（概念归纳用）', () => {
    const r = looseParse('{"妈妈":["家人"]}');
    assert.deepEqual ? null : null;
    assert.equal(r['妈妈'][0], '家人');
  });

  it('完全不是 JSON 时返回 null 而不是抛错', () => {
    assert.equal(looseParse('我无法完成这个任务'), null);
    assert.equal(looseParse(''), null);
    assert.equal(looseParse(null), null);
  });
});

describe('抽取 · 事实抽取', () => {
  const ctx = (over = {}) => ({
    personaName: '小忆', genderTerm: '用户',
    items: [{ userMessage: '周末去游乐园吧', aiResponse: '好啊' }],
    importanceDefaults: { event: 0.5 }, timeoutMs: 1000, ...over
  });

  it('正常抽取并夹取 importance', async () => {
    const p = providers.mock({
      replies: [JSON.stringify([
        { Event: '用户答应 小忆 周末去游乐园', Importance: 1.8, Entities: ['小忆', '用户', '游乐园'] },
        { Event: '小忆 很开心', Importance: 0.6, Entities: [] }
      ])]
    });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events.length, 2);
    assert.near(r.events[0].importance, 1, 1e-9, '1.8 应被夹到 1');
    assert.equal(r.events[0].entities.length, 3);
  });

  it('importance 非法时回落到默认值', async () => {
    const p = providers.mock({ replies: [JSON.stringify([{ Event: 'A', Importance: '很高', Entities: [] }])] });
    const r = await extractFacts(p, ctx());
    assert.near(r.events[0].importance, 0.5, 1e-9);
  });

  it('丢弃空事件与超长事件', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { Event: '', Importance: 0.5 },
      { Event: 'x'.repeat(600), Importance: 0.5 },
      { Event: '正常事件', Importance: 0.5 }
    ])] });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events.length, 1, '只应留下正常事件');
    assert.equal(r.events[0].text, '正常事件');
  });

  it('同批内重复事件被去重（忽略标点空白差异）', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { Event: '用户去了游乐园。', Importance: 0.5 },
      { Event: '用户去了游乐园', Importance: 0.5 },
      { Event: '用户 去了 游乐园', Importance: 0.5 }
    ])] });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events.length, 1, '三条变体应合并为一条');
  });

  it('首答不是 JSON 时会自动重试一次', async () => {
    const p = providers.mock({ replies: [
      '我不太确定该怎么提取',
      JSON.stringify([{ Event: '重试后成功', Importance: 0.5, Entities: [] }])
    ] });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].text, '重试后成功');
    assert.equal(p.calls.filter((c) => c.kind === 'chat').length, 2, '应调用两次');
  });

  it('重试仍失败则降级为空数组，不抛异常', async () => {
    const p = providers.mock({ replies: ['还是不行', '依然不行'] });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events.length, 0);
  });

  it('实体做了长度与去重清洗', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { Event: '某事件', Importance: 0.5, Entities: ['A', 'A', '', 'x'.repeat(50), 'B'] }
    ])] });
    const r = await extractFacts(p, ctx());
    assert.equal(r.events[0].entities.length, 2, '应只剩 A 和 B');
  });

  it('提示词里填入了角色名与对话内容', async () => {
    const p = providers.mock({ replies: ['[]'] });
    await extractFacts(p, ctx());
    const sent = p.calls[0].messages[0].content;
    assert.includes(sent, '小忆', '应含角色名');
    assert.includes(sent, '用户:周末去游乐园吧', '应含格式化对话');
    assert.notIncludes(sent, '{persona_name}', '不应残留未填占位符');
  });
});

describe('抽取 · 概念归纳', () => {
  const ctx = {
    personaName: '小忆', maxNewConcepts: 5, existingConceptsLimit: 50,
    timeoutMs: 1000, enableDynamicConcept: true
  };

  it('正常映射实体到概念', async () => {
    const p = providers.mock({ replies: [JSON.stringify({ 游乐园: ['娱乐场所'], 小忆: ['家人'] })] });
    const m = await conceptualize(p, ctx, ['游乐园', '小忆'], []);
    assert.equal(m.get('游乐园')[0], '娱乐场所');
    assert.equal(m.size, 2);
  });

  it('实体名本身不能当概念标签', async () => {
    const p = providers.mock({ replies: [JSON.stringify({ 游乐园: ['游乐园', '娱乐场所'] })] });
    const m = await conceptualize(p, ctx, ['游乐园'], []);
    assert.equal(m.get('游乐园').length, 1, '自身应被剔除');
    assert.equal(m.get('游乐园')[0], '娱乐场所');
  });

  it('概念数量超上限时截断', async () => {
    const p = providers.mock({ replies: [JSON.stringify({ A: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] })] });
    const m = await conceptualize(p, { ...ctx, maxNewConcepts: 3 }, ['A'], []);
    assert.equal(m.get('A').length, 3);
  });

  it('开关关闭时直接返回空，不调 LLM', async () => {
    const p = providers.mock({ replies: ['不应被调用'] });
    const m = await conceptualize(p, { ...ctx, enableDynamicConcept: false }, ['A'], []);
    assert.equal(m.size, 0);
    assert.equal(p.calls.length, 0, '不应发起调用');
  });

  it('已有概念池注入提示词且受 limit 限制', async () => {
    const pool = Array.from({ length: 60 }, (_, i) => `概念${i}`);
    const p = providers.mock({ replies: ['{}'] });
    await conceptualize(p, { ...ctx, existingConceptsLimit: 3 }, ['A'], pool);
    const sent = p.calls[0].messages[0].content;
    assert.includes(sent, '概念0');
    assert.notIncludes(sent, '概念9', 'limit=3 时不该出现第 10 个');
  });
});

describe('抽取 · stage1 实体关系', () => {
  const ctx = { personaName: '小忆', enableStage1: true, maxRelationsPerBatch: 20, timeoutMs: 1000 };

  it('默认关闭时不调用 LLM', async () => {
    const p = providers.mock({ replies: ['[]'] });
    const r = await extractEntityRelations(p, { ...ctx, enableStage1: false }, ['A', 'B'], '对话');
    assert.equal(r.length, 0);
    assert.equal(p.calls.length, 0);
  });

  it('实体少于 2 个时不调用 LLM', async () => {
    const p = providers.mock({ replies: ['[]'] });
    const r = await extractEntityRelations(p, ctx, ['A'], '对话');
    assert.equal(r.length, 0);
    assert.equal(p.calls.length, 0);
  });

  it('关系名统一归一到 SCREAMING_SNAKE_CASE，非法形态被剔除', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 'A', relation: 'likes', dst: 'B' },
      { src: 'A', relation: '喜欢', dst: 'C' },
      { src: 'A', relation: 'HAS SPACE', dst: 'D' },
      { src: 'A', relation: 'has-hyphen', dst: 'E' },
      { src: 'B', relation: 'GAVE', dst: 'C' }
    ])] });
    const r = await extractEntityRelations(p, ctx, ['A', 'B', 'C', 'D', 'E'], '对话');
    // 小写是「模型好心但没照格式来」，归一化而不是丢弃；
    // 中文/空格/连字符则是模型没理解任务，直接拒。
    assert.equal(r.length, 2, `应保留 LIKES 与 GAVE，实际 ${JSON.stringify(r)}`);
    assert.equal(r[0].relation, 'LIKES', '小写应被归一到大写');
    assert.equal(r[1].relation, 'GAVE');
  });

  it('同一对实体只保留一条关系（提示词的硬规则）', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 'A', relation: 'LIKES', dst: 'B' },
      { src: 'A', relation: 'HATES', dst: 'B' }
    ])] });
    const r = await extractEntityRelations(p, ctx, ['A', 'B'], '对话');
    assert.equal(r.length, 1, 'A→B 只该留一条');
    assert.equal(r[0].relation, 'LIKES', '保留先出现的');
  });

  it('反向关系视为不同（A→B 与 B→A 可共存）', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 'A', relation: 'LIKES', dst: 'B' },
      { src: 'B', relation: 'LIKES', dst: 'A' }
    ])] });
    const r = await extractEntityRelations(p, ctx, ['A', 'B'], '对话');
    assert.equal(r.length, 2);
  });

  it('不在实体清单里的端点被拒绝（防编造）', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 'A', relation: 'LIKES', dst: '幽灵实体' },
      { src: 'A', relation: 'LIKES', dst: 'B' }
    ])] });
    const r = await extractEntityRelations(p, ctx, ['A', 'B'], '对话');
    assert.equal(r.length, 1);
    assert.equal(r[0].dst, 'B');
  });

  it('自环与重复关系被剔除', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 'A', relation: 'SELF', dst: 'A' },
      { src: 'A', relation: 'LIKES', dst: 'B' },
      { src: 'A', relation: 'LIKES', dst: 'B' }
    ])] });
    const r = await extractEntityRelations(p, ctx, ['A', 'B'], '对话');
    assert.equal(r.length, 1);
  });

  it('数量超上限时截断', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `E${i}`);
    const rels = [];
    for (let i = 0; i < 10; i++) rels.push({ src: 'E0', relation: `REL_${i}`, dst: `E${i + 1}` });
    const p = providers.mock({ replies: [JSON.stringify(rels)] });
    const r = await extractEntityRelations(p, { ...ctx, maxRelationsPerBatch: 3 }, names, '对话');
    assert.equal(r.length, 3);
  });
});

describe('抽取 · stage3 事件关系', () => {
  const ctx = { personaName: '小忆', enableStage3: true, maxRelationsPerBatch: 20, timeoutMs: 1000 };
  const events = [{ text: '事件一' }, { text: '事件二' }, { text: '事件三' }];

  it('只接受五类常量关系', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 1, relation: 'BEFORE', dst: 2 },
      { src: 2, relation: 'UNKNOWN_REL', dst: 3 },
      { src: 1, relation: 'GAOFA', dst: 3 }
    ])] });
    const r = await extractEventRelations(p, ctx, events);
    assert.equal(r.length, 1);
    assert.equal(r[0].relation, 'BEFORE');
  });

  it('序号越界与非整数被剔除', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 1, relation: 'BEFORE', dst: 99 },
      { src: 0, relation: 'BEFORE', dst: 2 },
      { src: 'x', relation: 'BEFORE', dst: 2 },
      { src: 3, relation: 'BEFORE', dst: 1 }
    ])] });
    const r = await extractEventRelations(p, ctx, events);
    assert.equal(r.length, 1, '只留 3→1 那条');
    assert.equal(r[0].src, 3);
  });

  it('BEFORE 与 AFTER 互斥，保留先出现的', async () => {
    const p = providers.mock({ replies: [JSON.stringify([
      { src: 1, relation: 'BEFORE', dst: 2 },
      { src: 1, relation: 'AFTER', dst: 2 }
    ])] });
    const r = await extractEventRelations(p, ctx, events);
    assert.equal(r.length, 1);
    assert.equal(r[0].relation, 'BEFORE');
  });

  it('自环被剔除', async () => {
    const p = providers.mock({ replies: [JSON.stringify([{ src: 1, relation: 'BEFORE', dst: 1 }])] });
    const r = await extractEventRelations(p, ctx, events);
    assert.equal(r.length, 0);
  });

  it('事件少于 2 个时不调用', async () => {
    const p = providers.mock({ replies: ['[]'] });
    const r = await extractEventRelations(p, ctx, [events[0]]);
    assert.equal(r.length, 0);
    assert.equal(p.calls.length, 0);
  });
});

describe('抽取 · 辅助函数', () => {
  it('normalizeEventText 抹平标点与空白差异', () => {
    assert.equal(
      normalizeEventText('用户，去了 游乐园。'),
      normalizeEventText('用户去了游乐园')
    );
  });

  it('formatConversation 按说话人前缀拼接，空回复不产生空行', () => {
    const s = formatConversation([
      { userMessage: '你好', aiResponse: '你也好' },
      { userMessage: '再见', aiResponse: '' }
    ], '小忆', '用户');
    assert.includes(s, '用户:你好');
    assert.includes(s, '小忆:你也好');
    assert.includes(s, '用户:再见');
    const lines = s.split('\n');
    assert.equal(lines.length, 3, '空回复不该多出一行');
    assert.notEqual(lines[lines.length - 1], '小忆:', '不该以空回复行结尾');
  });

  it('buildPersonaSection 留空时不产生段落', () => {
    assert.equal(buildPersonaSection({}), '');
    const s = buildPersonaSection({ personaDescription: '远房表妹', personaPersonality: '活泼' });
    assert.includes(s, '远房表妹');
    assert.includes(s, '活泼');
  });
});