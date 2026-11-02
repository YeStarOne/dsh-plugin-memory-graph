#!/usr/bin/env node
'use strict';
/**
 * export_graph.js —— 把引擎的数据目录导出成可视化图谱数据。
 *
 * 用法：
 *   node tools/export_graph.js <数据目录> [输出目录]        # 单个 chat 库
 *   node tools/export_graph.js --all <数据根目录> [输出目录]  # 合并根目录下所有 chat 子库
 *
 * 数据目录 = 含 nodes.jsonl / edges.jsonl / meta.json 的目录（每 chat 一个）。
 * 产物（写入输出目录，默认当前目录）：
 *   graph-data.js   —— window.MEMORY_GRAPH_DATA = {...}（file:// 双击可用）
 *   graph-data.json —— 同内容 JSON（http 服务 / 拖拽导入用）
 *
 * 数据契约（与 viewer/index.html 约定）：
 *   { meta:  { source, slot, exportedAt, nodeCount, edgeCount },
 *     nodes: [{ id, nodeType: 'entity'|'event'|'concept', content, importance,
 *               createdAt(ms), eventTime, custom }],
 *     edges: [{ id, sourceId, targetId, relation, weight, createdAt }] }
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ALL = args[0] === '--all';
const SRC = path.resolve(args[ALL ? 1 : 0] || '');
const OUTDIR = path.resolve(args[ALL ? 2 : 1] || process.cwd());

const { Store } = require('../src');

function storeDirs(root) {
  if (!ALL) return [root];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'nodes.jsonl')))
    .map((d) => path.join(root, d.name));
}

function openStore(dir) {
  if (!fs.existsSync(path.join(dir, 'nodes.jsonl'))) {
    throw new Error(`目录不含 nodes.jsonl：${dir}`);
  }
  return Store.open(dir);
}

function collect(store, slotLabel, buckets) {
  for (const n of store.allNodes()) {
    if (buckets.nodeById.has(n.id)) continue;
    buckets.nodeById.set(n.id, {
      id: n.id,
      nodeType: n.nodeType,
      content: n.content,
      importance: Number(n.importance) || 0,
      createdAt: n.createdAt || 0,
      eventTime: n.eventTime || '',
      custom: !!n.custom
    });
  }
  for (const e of store.edges.values()) {
    const key = e.id || `${e.sourceId}|${e.targetId}|${e.relation}`;
    if (buckets.edgeByKey.has(key)) continue;
    buckets.edgeByKey.set(key, {
      id: e.id || key,
      sourceId: e.sourceId,
      targetId: e.targetId,
      relation: e.relation,
      weight: e.weight || 1,
      createdAt: e.createdAt || 0
    });
  }
  buckets.slots.push(slotLabel);
}

function main() {
  if (!SRC || !fs.existsSync(SRC)) {
    console.error('用法: node tools/export_graph.js [--all] <数据目录|数据根目录> [输出目录]');
    process.exit(1);
  }
  const dirs = storeDirs(SRC);
  if (!dirs.length) {
    console.error(`没有找到含 nodes.jsonl 的子目录：${SRC}`);
    process.exit(1);
  }

  const buckets = { nodeById: new Map(), edgeByKey: new Map(), slots: [] };
  for (const dir of dirs) {
    const store = openStore(dir);
    collect(store, path.basename(dir), buckets);
  }

  // 悬空边兜底（Store 加载时已清一次，合并后仍查一遍）
  const edges = [...buckets.edgeByKey.values()]
    .filter((e) => buckets.nodeById.has(e.sourceId) && buckets.nodeById.has(e.targetId));
  const nodes = [...buckets.nodeById.values()];

  const payload = {
    meta: {
      source: 'memory-graph',
      slot: ALL ? `${path.basename(SRC)} (${dirs.length} chats)` : path.basename(SRC),
      exportedAt: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: edges.length
    },
    nodes,
    edges
  };

  fs.mkdirSync(OUTDIR, { recursive: true });
  const jsPath = path.join(OUTDIR, 'graph-data.js');
  const jsonPath = path.join(OUTDIR, 'graph-data.json');
  fs.writeFileSync(jsPath, 'window.MEMORY_GRAPH_DATA = ' + JSON.stringify(payload) + ';\n', 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');

  console.log(`完成：${nodes.length} 节点 / ${edges.length} 边（${buckets.slots.length} 个库：${buckets.slots.slice(0, 5).join(', ')}${buckets.slots.length > 5 ? ' …' : ''}）`);
  console.log(`→ ${jsPath}`);
  console.log('打开 viewer/index.html（或把它放到同目录）即可查看。');
}

try {
  main();
} catch (e) {
  console.error('导出失败：', e.message);
  process.exit(1);
}
