'use strict';
/** 衰减与裁剪测试。 */

const { Store } = require('../src/store');
const { decay, prune, maintain } = require('../src/decay');

const DAY = 86400000;

function node(id, importance, ageDays, extra = {}) {
  const t = Date.now() - ageDays * DAY;
  return {
    id, nodeType: 'event', content: `记忆${id}`, importance,
    createdAt: t, updatedAt: t, ...extra
  };
}

describe('衰减', () => {
  it('宽限期内的新记忆不受影响', () => {
    const s = Store.open(tmpDir('decay-grace'));
    s.putNode(node('n1', 0.5, 1));
    const r = decay(s, { graceDays: 7 });
    assert.equal(r.touched, 0, '不该被动过');
    assert.near(s.getNode('n1').importance, 0.5, 1e-9);
  });

  it('过了一个半衰期，importance 减半', () => {
    const s = Store.open(tmpDir('decay-half'));
    s.putNode(node('n1', 0.8, 30));
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0 });
    assert.near(s.getNode('n1').importance, 0.4, 0.01, '30 天应减半');
  });

  it('过了两个半衰期，剩四分之一', () => {
    const s = Store.open(tmpDir('decay-two'));
    s.putNode(node('n1', 0.8, 60));
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0 });
    assert.near(s.getNode('n1').importance, 0.2, 0.01, '60 天应剩 1/4');
  });

  it('衰减到门限以下会被删除', () => {
    const s = Store.open(tmpDir('decay-drop'));
    s.putNode(node('n1', 0.25, 120));
    const r = decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0.2 });
    assert.ok(r.removed >= 1, '应被删掉');
    assert.equal(s.getNode('n1'), null);
  });

  it('手标记的记忆永不衰减', () => {
    const s = Store.open(tmpDir('decay-custom'));
    s.putNode(node('n1', 0.3, 365, { custom: true }));
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0.2 });
    assert.ok(s.getNode('n1'), '不该被删');
    assert.near(s.getNode('n1').importance, 0.3, 1e-9, '重要度不该变');
  });

  it('同一天内反复调用不会反复衰减', () => {
    const s = Store.open(tmpDir('decay-idem'));
    s.putNode(node('n1', 0.8, 30));
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0 });
    const first = s.getNode('n1').importance;
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0 });
    assert.near(s.getNode('n1').importance, first, 1e-9, '第二次不该再动');
  });

  it('记录 lastDecayAt 以便下次计算间隔', () => {
    const s = Store.open(tmpDir('decay-stamp'));
    s.putNode(node('n1', 0.8, 30));
    decay(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0 });
    assert.ok(s.getNode('n1').lastDecayAt > 0, '应打上时间戳');
  });
});

describe('裁剪', () => {
  it('超期未用的概念会被清掉', () => {
    const s = Store.open(tmpDir('prune-stale'));
    const old = new Date(Date.now() - 100 * DAY).getTime();
    s.putNode({ id: 'c1', nodeType: 'concept', content: '过气概念', importance: 0.5, createdAt: old, lastUsedAt: old });
    const r = prune(s, { conceptMaxAgeDays: 60 });
    assert.equal(r.removed.length, 1);
    assert.equal(s.getNode('c1'), null);
  });

  it('概念池超上限时淘汰最冷的', () => {
    const s = Store.open(tmpDir('prune-overflow'));
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      s.putNode({
        id: `c${i}`, nodeType: 'concept', content: `概念${i}`, importance: 0.5,
        createdAt: now - (10 - i) * DAY, lastUsedAt: now - (10 - i) * DAY
      });
    }
    const r = prune(s, { maxConcepts: 3, conceptMaxAgeDays: 9999 });
    assert.equal(r.kept, 3, '只留 3 个');
    assert.equal(r.removed.length, 7);
    assert.ok(!s.getNode('c0'), '最冷的 c0 应被淘汰');
    assert.ok(s.getNode('c9'), '最新用过的 c9 应保留');
  });

  it('事件与实体不受概念池上限影响', () => {
    const s = Store.open(tmpDir('prune-scope'));
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      s.putNode({ id: `e${i}`, nodeType: 'event', content: `事件${i}`, importance: 0.5, createdAt: now });
      s.putNode({ id: `x${i}`, nodeType: 'entity', content: `实体${i}`, importance: 0.5, createdAt: now });
    }
    prune(s, { maxConcepts: 1 });
    assert.equal(s.nodeCount(), 100, '事件与实体不该被动');
  });
});

describe('维护总入口', () => {
  it('返回衰减、裁剪与压实三部分结果', () => {
    const s = Store.open(tmpDir('maintain'));
    s.putNode(node('n1', 0.8, 40));
    const r = maintain(s, { halfLifeDays: 30, graceDays: 0, minImportance: 0, compactThreshold: 2 });
    assert.ok(r.decay, '应有 decay 段');
    assert.ok(r.prune, '应有 prune 段');
  });

  it('墓碑占比超阈值时自动压实', () => {
    const s = Store.open(tmpDir('maintain-compact'));
    for (let i = 0; i < 10; i++) s.putNode(node(`n${i}`, 0.8, 1));
    for (let i = 0; i < 8; i++) s.deleteNode(`n${i}`);
    assert.ok(s.deleteRatio() > 0.3, '先造出高墓碑占比');
    const r = maintain(s, { compactThreshold: 0.3 });
    assert.ok(r.compacted, '应触发压实');
    assert.equal(s.deleteRatio(), 0, '压实后归零');
  });

  it('墓碑很少时不压实', () => {
    const s = Store.open(tmpDir('maintain-nocompact'));
    s.putNode(node('n1', 0.8, 1));
    const r = maintain(s, { compactThreshold: 0.9 });
    assert.equal(r.compacted, null);
  });
});