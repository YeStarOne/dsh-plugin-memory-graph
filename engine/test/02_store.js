'use strict';
/** 存储层测试：增删改查、持久化、压实、损坏容忍。 */

const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');

function mkNode(id, content, extra = {}) {
  return {
    id, nodeType: 'event', content, importance: 0.5,
    createdAt: Date.now(), updatedAt: Date.now(), ...extra
  };
}

describe('存储层', () => {
  it('写入后能读回', () => {
    const dir = tmpDir('store-basic');
    const s = Store.open(dir);
    s.putNode(mkNode('n1', '第一条记忆'));
    assert.equal(s.nodeCount(), 1);
    assert.equal(s.getNode('n1').content, '第一条记忆');
  });

  it('重复 id 会抛错', () => {
    const s = Store.open(tmpDir('store-dup'));
    s.putNode(mkNode('n1', 'a'));
    assert.throws(() => s.putNode(mkNode('n1', 'b')), '应拒绝重复 id');
  });

  it('重开目录后数据仍在（持久化）', () => {
    const dir = tmpDir('store-persist');
    const s1 = Store.open(dir);
    s1.putNode(mkNode('n1', '活下来'));
    s1.putEdge({ id: 'e1', sourceId: 'n1', targetId: 'n1', relation: 'self', weight: 1, createdAt: Date.now() });

    const s2 = Store.open(dir);
    assert.equal(s2.nodeCount(), 1, '节点应持久化');
    assert.equal(s2.getNode('n1').content, '活下来');
    assert.equal(s2.edgeCount(), 1, '边应持久化');
    assert.equal(s2.edgesOf('n1').length, 1, '邻接索引应重建');
  });

  it('updateNode 覆盖旧值且重开后生效', () => {
    const dir = tmpDir('store-update');
    const s1 = Store.open(dir);
    s1.putNode(mkNode('n1', 'x', { importance: 0.3 }));
    s1.updateNode('n1', { importance: 0.9 });

    const s2 = Store.open(dir);
    assert.near(s2.getNode('n1').importance, 0.9, 1e-9, '应按后写覆盖');
  });

  it('删除是写墓碑，重开后不会复活', () => {
    const dir = tmpDir('store-delete');
    const s1 = Store.open(dir);
    s1.putNode(mkNode('n1', '临时'));
    assert.ok(s1.deleteNode('n1'));
    assert.equal(s1.nodeCount(), 0);

    const s2 = Store.open(dir);
    assert.equal(s2.nodeCount(), 0, '删除应持久化');
  });

  it('边删除后邻接索引同步更新', () => {
    const s = Store.open(tmpDir('store-edge-del'));
    s.putNode(mkNode('a', 'A'));
    s.putNode(mkNode('b', 'B'));
    s.putEdge({ id: 'e1', sourceId: 'a', targetId: 'b', relation: 'rel', weight: 1, createdAt: Date.now() });
    assert.equal(s.edgesOf('a').length, 1);
    s.deleteEdge('e1');
    assert.equal(s.edgesOf('a').length, 0, 'a 侧应清掉');
    assert.equal(s.edgesOf('b').length, 0, 'b 侧应清掉');
  });

  it('findEdge 能命中已存在的关系（建边去重用）', () => {
    const s = Store.open(tmpDir('store-find'));
    s.putNode(mkNode('a', 'A'));
    s.putNode(mkNode('b', 'B'));
    s.putEdge({ id: 'e1', sourceId: 'a', targetId: 'b', relation: 'likes', weight: 1, createdAt: Date.now() });
    assert.ok(s.findEdge('a', 'b', 'likes'), '应找到');
    assert.equal(s.findEdge('a', 'b', 'hates'), null, '不同关系不应误命中');
  });

  it('compact 清掉墓碑并保持数据不变', () => {
    const dir = tmpDir('store-compact');
    const s = Store.open(dir);
    for (let i = 0; i < 10; i++) s.putNode(mkNode(`n${i}`, `记忆${i}`));
    for (let i = 0; i < 5; i++) s.deleteNode(`n${i}`);
    const before = s.nodeCount();
    const dropped = s.compact();
    assert.equal(dropped.nodes, 5, '应清掉 5 个墓碑');
    assert.equal(s.nodeCount(), before, '存活节点数不变');

    // 压实后重开仍一致
    const s2 = Store.open(dir);
    assert.equal(s2.nodeCount(), before);
    assert.equal(s2.deleteRatio(), 0, '压实后不应再有墓碑');
  });

  it('最后一行截断（写入中途崩溃）能被容忍', () => {
    const dir = tmpDir('store-truncated');
    const s = Store.open(dir);
    s.putNode(mkNode('n1', '完整'));
    fs.appendFileSync(path.join(dir, 'nodes.jsonl'), '{"id":"n2","nodeType":"ev', 'utf8');

    const s2 = Store.open(dir);
    assert.equal(s2.nodeCount(), 1, '应加载完整的那些，忽略残行');
  });

  it('中间行损坏会明确报错，而不是静默丢数据', () => {
    const dir = tmpDir('store-corrupt');
    const s = Store.open(dir);
    s.putNode(mkNode('n1', '一'));
    s.putNode(mkNode('n2', '二'));
    const file = path.join(dir, 'nodes.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[0] = '{坏行}';
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    assert.throws(() => Store.open(dir), '中间行损坏应抛错');
  });

  it('删除节点会级联删掉它的边（不留悬空边）', () => {
    const s = Store.open(tmpDir('store-cascade'));
    s.putNode(mkNode('a', 'A'));
    s.putNode(mkNode('b', 'B'));
    s.putNode(mkNode('c', 'C'));
    s.putEdge({ id: 'e1', sourceId: 'a', targetId: 'b', relation: 'r', weight: 1, createdAt: Date.now() });
    s.putEdge({ id: 'e2', sourceId: 'b', targetId: 'c', relation: 'r', weight: 1, createdAt: Date.now() });

    s.deleteNode('b');
    assert.equal(s.edgeCount(), 0, '两条边都挂在 b 上，应一并删除');
    assert.equal(s.edgesOf('a').length, 0);
    assert.equal(s.edgesOf('c').length, 0);
  });

  it('重开后不会出现指向已删节点的悬空边', () => {
    const dir = tmpDir('store-orphan');
    const s = Store.open(dir);
    s.putNode(mkNode('a', 'A'));
    s.putNode(mkNode('b', 'B'));
    s.putEdge({ id: 'e1', sourceId: 'a', targetId: 'b', relation: 'r', weight: 1, createdAt: Date.now() });
    s.deleteNode('b');

    const s2 = Store.open(dir);
    assert.equal(s2.nodeCount(), 1);
    assert.equal(s2.edgeCount(), 0, '重开也不该有悬空边');
  });

  it('历史遗留的悬空边在加载时被清理', () => {
    const dir = tmpDir('store-orphan-legacy');
    const s = Store.open(dir);
    s.putNode(mkNode('a', 'A'));
    // 手工写一条指向不存在节点的边，模拟旧版本留下的脏数据
    fs.appendFileSync(path.join(dir, 'edges.jsonl'),
      JSON.stringify({ id: 'ghost', sourceId: 'a', targetId: '不存在', relation: 'r', weight: 1, createdAt: Date.now() }) + '\n',
      'utf8');

    const s2 = Store.open(dir);
    assert.equal(s2.edgeCount(), 0, '悬空边应被摘掉');
    assert.equal(s2.edgesOf('a').length, 0);
    assert.equal(s2.getNode('ghost'), null);
  });

  it('countByType 与 sizeBytes 可用', () => {
    const s = Store.open(tmpDir('store-stats'));
    s.putNode(mkNode('e1', '事件', { nodeType: 'event' }));
    s.putNode(mkNode('x1', '实体', { nodeType: 'entity' }));
    s.putNode(mkNode('c1', '概念', { nodeType: 'concept' }));
    const c = s.countByType();
    assert.equal(c.event, 1);
    assert.equal(c.entity, 1);
    assert.equal(c.concept, 1);
    assert.ok(s.sizeBytes() > 0, '占用应大于 0');
  });

  it('reset 清空一切', () => {
    const s = Store.open(tmpDir('store-reset'));
    s.putNode(mkNode('n1', 'x'));
    s.reset();
    assert.equal(s.nodeCount(), 0);
    assert.equal(Store.open(s.dir).nodeCount(), 0, '重开也不应有数据');
  });
});