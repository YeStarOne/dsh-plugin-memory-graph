'use strict';
/**
 * 管理指令支撑与摘要层测试。
 * addCustomEvent / forgetByText / summarize / summary 节点参与检索。
 */

const { MemoryEngine, providers } = require('../src');
const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function freshDir(tag) {
  const dir = join(mkdtempSync(join(tmpdir(), 'mg-manage-')), tag);
  return dir;
}

const OFFLINE = () => providers.offline({ dim: 256 });
const PERSONA = { personaName: '小忆', genderTerm: '用户' };

describe('管理指令 · addCustomEvent', () => {
  it('钉住事件：custom=true、importance=1、有向量、能被召回', async () => {
    const dir = freshDir('pin1');
    const engine = await MemoryEngine.open({ dir, provider: OFFLINE(), persona: PERSONA });
    const r = await engine.addCustomEvent('用户的生日是5月20日，每年都要提前准备礼物');
    assert.ok(r && r.node, '应返回结果');
    assert.equal(r.node.custom, true, '应钉住');
    assert.equal(r.node.importance, 1, '重要度 1');
    assert.equal(r.nodeType || r.node.nodeType, 'event', '类型 event');
    assert.ok(Array.isArray(r.node.vector) && r.node.vector.length === 256, '应有向量');
    assert.equal(r.deduped, false, '首次不算重复');
    const rec = await engine.recall('生日礼物准备');
    assert.includes(rec.promptText, '生日', '应召回钉住事件');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('同一内容重复添加：改钉旧条目（deduped），不新建节点', async () => {
    const dir = freshDir('pin2');
    const engine = await MemoryEngine.open({ dir, provider: OFFLINE(), persona: PERSONA });
    const a = await engine.addCustomEvent('用户喜欢草莓蛋糕');
    const b = await engine.addCustomEvent('用户喜欢草莓蛋糕');
    assert.equal(b.deduped, true, '第二次应判重');
    assert.equal(a.node.id, b.node.id, '同一节点');
    assert.equal(b.node.instanceCount, 2, '次数+1');
    assert.equal(engine.store.nodeCount(), 1, '不新建');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('太短或太长的内容返回 null，不入库', async () => {
    const dir = freshDir('pin3');
    const engine = await MemoryEngine.open({ dir, provider: OFFLINE(), persona: PERSONA });
    assert.equal(await engine.addCustomEvent('好'), null, '太短');
    assert.equal(await engine.addCustomEvent(''), null, '为空');
    assert.equal(await engine.addCustomEvent('长'.repeat(501)), null, '太长');
    assert.equal(engine.store.nodeCount(), 0, '零入库');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('管理指令 · forgetByText', () => {
  it('子串匹配删除事件并级联删边；不动实体与概念', async () => {
    const dir = freshDir('fg1');
    const FACTS = JSON.stringify([
      { Event: '约了周末一起去爬山', Importance: 0.7, Entities: ['小忆', '爬山'] },
      { Event: '用户喜欢吃草莓蛋糕', Importance: 0.6, Entities: ['小忆', '草莓蛋糕'] }
    ]);
    const CONCEPTS = JSON.stringify({ 爬山: ['户外活动'], 草莓蛋糕: ['甜食'], 小忆: ['家人'] });
    const engine = await MemoryEngine.open({ dir, provider: providers.mock({ replies: [FACTS, CONCEPTS], dim: 64 }), persona: PERSONA, batchSize: 1 });
    engine.enqueue({ userMessage: '周末去爬山', aiResponse: '好呀' });
    await engine.flush();
    engine.enqueue({ userMessage: '我爱草莓蛋糕', aiResponse: '记住了' });
    await engine.flush();

    const removed = engine.forgetByText('爬山');
    assert.equal(removed.length, 1, '应删 1 条事件');
    assert.includes(removed[0].content, '爬山', '删的是爬山事件');
    assert.equal(engine.store.getNode(removed[0].id), null, '节点已删');
    // 级联：事件的边没了，实体还在
    assert.equal(engine.store.allNodes().some((n) => n.nodeType === 'entity' && n.content === '爬山'), true, '实体保留');
    assert.equal(engine.store.allEdges().some((e) => e.relation === 'participates_in' && !engine.store.getNode(e.targetId) && !engine.store.getNode(e.sourceId)), false, '无悬空边');

    // 精确匹配也能删
    const removed2 = engine.forgetByText('用户喜欢吃草莓蛋糕');
    assert.equal(removed2.length, 1, '精确匹配删除');
    // 没有匹配
    assert.equal(engine.forgetByText('不存在的记忆').length, 0, '无匹配返回空');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('摘要层 · summarize', () => {
  const FACTS = JSON.stringify([
    { Event: '约了周末一起去爬山', Importance: 0.7, Entities: ['小忆', '爬山'] },
    { Event: '上周去爬山看枫叶，累但开心', Importance: 0.5, Entities: ['小忆', '爬山'] }
  ]);
  const CONCEPTS = JSON.stringify({ 爬山: ['户外活动'], 小忆: ['家人'] });
  const SUMMARY_A1 = '小忆发现用户是个热爱爬山的人，两人约好周末再去一次，还约好拍山顶的照片。';
  const SUMMARY_B1 = '爬山是用户和小忆之间最常见的共同活动，从赏枫到再约新行程。';
  const SUMMARY_A2 = '用户持续保持着爬山的习惯，爬山已成为两人最重要的固定共同活动。';
  const SUMMARY_B2 = '爬山主题持续更新：两人保持了经常一起爬山并记录风景的习惯。';

  it('同实体事件归纳为 summary 节点：参与检索、幂等改写', async () => {
    const dir = freshDir('sum1');
    const provider = providers.mock({ replies: [FACTS, CONCEPTS, SUMMARY_A1, SUMMARY_B1, SUMMARY_A2, SUMMARY_B2], dim: 256 });
    const engine = await MemoryEngine.open({ dir, provider, persona: PERSONA, batchSize: 2 });
    engine.enqueue({ userMessage: '周末去爬山好不好', aiResponse: '好呀', timestamp: Date.now() - 90000000 });
    engine.enqueue({ userMessage: '上周爬山看枫叶真开心', aiResponse: '下次再去', timestamp: Date.now() - 80000000 });
    await engine.flush();

    const topics = await engine.summarize({ minEvents: 2 });
    assert.equal(topics.length, 2, '两个实体各出一个主题');
    assert.ok(topics.every((t) => t.updated === false), '首次都是新建');

    const summaries = engine.store.allNodes().filter((n) => n.nodeType === 'summary');
    assert.equal(summaries.length, 2, '两个 summary 节点');
    assert.ok(summaries.every((n) => Array.isArray(n.vector) && n.vector.length === 256), '摘要要有向量');
    assert.ok(summaries.some((n) => n.metadata && n.metadata.topic === '爬山'), 'metadata 记录主题');
    assert.equal(engine.store.allEdges().filter((e) => e.relation === 'summarized_by').length, 2, 'summarized_by 边');

    // 幂等改写：同一主题重跑不新增
    const again = await engine.summarize({ minEvents: 2 });
    assert.equal(again.length, 2, '重跑仍覆盖两个主题');
    assert.ok(again.every((t) => t.updated === true), '第二次为改写');
    assert.equal(engine.store.allNodes().filter((n) => n.nodeType === 'summary').length, 2, '数量不变');

    // 摘要参与检索
    const rec = await engine.recall('爬山', { minSimilarity: -1 });
    assert.ok(rec.items.some((i) => i.node.nodeType === 'summary'), '检索应命中 summary 节点');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('事件不足 minEvents 时不产生摘要', async () => {
    const dir = freshDir('sum2');
    const FACTS1 = JSON.stringify([{ Event: '用户今天去游泳了', Importance: 0.5, Entities: ['游泳'] }]);
    const CONCEPTS1 = JSON.stringify({ 游泳: ['运动'] });
    const engine = await MemoryEngine.open({ dir, provider: providers.mock({ replies: [FACTS1, CONCEPTS1], dim: 64 }), persona: PERSONA, batchSize: 1 });
    engine.enqueue({ userMessage: '我今天去游泳了', aiResponse: '运动达人' });
    await engine.flush();
    const topics = await engine.summarize({ minEvents: 2 });
    assert.equal(topics.length, 0, '单条事件不成主题');
    assert.equal(engine.store.allNodes().filter((n) => n.nodeType === 'summary').length, 0, '无 summary 节点');
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
