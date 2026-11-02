'use strict';
/**
 * 存储层：追加式 JSONL + 内存索引 + 定期压实。
 *
 * 为什么不用 SQLite / LanceDB：
 *   个人记忆库量级小，JSONL 已经足够快，而且有三个实际好处——
 *   零依赖（不用编译原生模块，任何 Node 项目直接能跑）、
 *   人类可读（出问题能直接看文件）、
 *   易备份（拷一个目录就是完整快照）。
 *
 * 文件布局（每个存档槽一个目录）：
 *   <dir>/nodes.jsonl   节点追加日志
 *   <dir>/edges.jsonl   边追加日志
 *   <dir>/meta.json     版本、配置覆盖、计数器
 *
 * 删除是「写墓碑」而不是原地删行 —— 追加写永远安全，
 * 不需要在读的时候加锁。deleteRatio 超过阈值时调用 compact() 压实。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：先写临时文件再 rename，避免断电/崩溃留下半个文件。 */
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.nodesFile = path.join(dir, 'nodes.jsonl');
    this.edgesFile = path.join(dir, 'edges.jsonl');
    this.metaFile = path.join(dir, 'meta.json');

    /** @type {Map<string, object>} id -> node */
    this.nodes = new Map();
    /** @type {Map<string, object>} id -> edge */
    this.edges = new Map();
    /** 邻接表，检索时做图扩展用。id -> Set<edgeId> */
    this.adjacency = new Map();
    this.meta = { schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), counters: {} };
    this._deleted = { nodes: 0, edges: 0 };
    this._locks = new Set();
  }

  /** 打开（或新建）一个存储目录。 */
  static open(dir) {
    ensureDir(dir);
    const store = new Store(dir);
    store._load();
    return store;
  }

  _load() {
    if (fs.existsSync(this.metaFile)) {
      try {
        this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      } catch (e) {
        throw new Error(`[store] meta.json 解析失败（文件可能损坏）：${e.message}`);
      }
    }
    this._loadJsonl(this.nodesFile, (row) => {
      if (row._deleted) { this.nodes.delete(row.id); this._deleted.nodes++; return; }
      this.nodes.set(row.id, row);
    });
    this._loadJsonl(this.edgesFile, (row) => {
      if (row._deleted) {
        this.edges.delete(row.id);
        this._deleted.edges++;
        return;
      }
      this.edges.set(row.id, row);
      this._indexEdge(row);
    });
    this._dropOrphanEdges();
  }

  /**
   * 丢掉端点不存在的边。
   * 正常情况下 deleteNode 会级联清理，这里是给「旧版本写坏的文件」兜底——
   * 与其让悬空边在检索时变成 null 解引用，不如加载时就摘掉。
   */
  _dropOrphanEdges() {
    const orphans = [];
    for (const e of this.edges.values()) {
      if (!this.nodes.has(e.sourceId) || !this.nodes.has(e.targetId)) orphans.push(e.id);
    }
    for (const id of orphans) {
      const e = this.edges.get(id);
      this.edges.delete(id);
      this._deleted.edges++;
      for (const end of [e.sourceId, e.targetId]) {
        const set = this.adjacency.get(end);
        if (set) set.delete(id);
      }
    }
    return orphans.length;
  }

  _loadJsonl(file, onRow) {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    let line = 0;
    for (const raw of text.split('\n')) {
      line++;
      const s = raw.trim();
      if (!s) continue;
      let row;
      try {
        row = JSON.parse(s);
      } catch (e) {
        // 截断的最后一行是可容忍的（写入中途崩溃），中间行损坏说明文件被改坏了
        if (line === text.split('\n').length) continue;
        throw new Error(`[store] ${path.basename(file)} 第 ${line} 行解析失败：${e.message}`);
      }
      onRow(row);
    }
  }

  _indexEdge(edge) {
    for (const end of [edge.sourceId, edge.targetId]) {
      let set = this.adjacency.get(end);
      if (!set) { set = new Set(); this.adjacency.set(end, set); }
      set.add(edge.id);
    }
  }

  _append(file, row) {
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  }

  // ---- 节点 ----

  putNode(node) {
    if (this.nodes.has(node.id)) throw new Error(`[store] 节点已存在：${node.id}`);
    this.nodes.set(node.id, node);
    this._append(this.nodesFile, node);
    return node;
  }

  updateNode(id, patch) {
    const cur = this.nodes.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.nodes.set(id, next);
    // 更新也是追加一行新版本 —— 读的时候后写覆盖先写
    this._append(this.nodesFile, next);
    return next;
  }

  /**
 * 删节点。**级联删掉它的所有关联边** —— 否则图里会留下指向不存在节点的悬空边，
 * 下次加载时邻接表还建得起来，检索却会读到 null 节点。
 */
deleteNode(id) {
    if (!this.nodes.has(id)) return false;
    this.nodes.delete(id);
    this._deleted.nodes++;
    this._append(this.nodesFile, { id, _deleted: true, deletedAt: Date.now() });

    for (const edge of this.edgesOf(id)) this.deleteEdge(edge.id);
    this.adjacency.delete(id);
    return true;
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  // ---- 边 ----

  putEdge(edge) {
    if (this.edges.has(edge.id)) return this.edges.get(edge.id);
    this.edges.set(edge.id, edge);
    this._indexEdge(edge);
    this._append(this.edgesFile, edge);
    return edge;
  }

  deleteEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this._deleted.edges++;
    for (const end of [edge.sourceId, edge.targetId]) {
      const set = this.adjacency.get(end);
      if (set) set.delete(id);
    }
    this._append(this.edgesFile, { id, _deleted: true, deletedAt: Date.now() });
    return true;
  }

  /** 取某个节点的全部关联边。 */
  edgesOf(id) {
    const ids = this.adjacency.get(id);
    if (!ids) return [];
    const out = [];
    for (const eid of ids) {
      const e = this.edges.get(eid);
      if (e) out.push(e);
    }
    return out;
  }

  /** 找一对节点之间是否已有某条关系（建边去重用）。 */
  findEdge(sourceId, targetId, relation) {
    for (const e of this.edgesOf(sourceId)) {
      if (e.sourceId === sourceId && e.targetId === targetId && e.relation === relation) return e;
    }
    return null;
  }

  // ---- 遍历与持久化 ----

  allNodes() { return Array.from(this.nodes.values()); }
  allEdges() { return Array.from(this.edges.values()); }

  nodeCount() { return this.nodes.size; }
  edgeCount() { return this.edges.size; }

  countByType() {
    const out = { event: 0, entity: 0, concept: 0, summary: 0 };
    for (const n of this.nodes.values()) {
      if (out[n.nodeType] !== undefined) out[n.nodeType]++;
    }
    return out;
  }

  saveMeta() {
    atomicWrite(this.metaFile, JSON.stringify(this.meta, null, 2));
  }

  /** 墓碑占比。超过阈值就该压实了。 */
  deleteRatio() {
    const total = this.nodes.size + this._deleted.nodes + this.edges.size + this._deleted.edges;
    if (total === 0) return 0;
    return (this._deleted.nodes + this._deleted.edges) / total;
  }

  /** 重写 JSONL，丢掉墓碑。写临时文件 + rename，中途崩溃不会损坏原文件。 */
  compact() {
    const nTmp = this.nodesFile + '.compact';
    const eTmp = this.edgesFile + '.compact';
    fs.writeFileSync(nTmp, this.allNodes().map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(eTmp, this.allEdges().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(nTmp, this.nodesFile);
    fs.renameSync(eTmp, this.edgesFile);
    const dropped = { ...this._deleted };
    this._deleted = { nodes: 0, edges: 0 };
    return dropped;
  }

  /** 磁盘占用（字节），只算数据文件。 */
  sizeBytes() {
    let total = 0;
    for (const f of [this.nodesFile, this.edgesFile, this.metaFile]) {
      try { total += fs.statSync(f).size; } catch (_) { /* 尚未创建 */ }
    }
    return total;
  }

  /** 清空这一槽并重开。 */
  reset() {
    for (const f of [this.nodesFile, this.edgesFile, this.metaFile]) {
      try { fs.unlinkSync(f); } catch (_) { /* 不存在就算了 */ }
    }
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this._deleted = { nodes: 0, edges: 0 };
    this.meta = { schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), counters: {} };
  }
}

module.exports = { Store, SCHEMA_VERSION, atomicWrite, ensureDir };