'use strict';
/**
 * MemoryEngine —— 对外唯一入口。
 *
 * 对外只有四个动作：
 *   ingest(items)         对话入库（异步跑完四阶段抽取）
 *   recall(query)         取回记忆文本 + 结构化结果
 *   maintain()            跑一次衰减/裁剪
 *   （可选）rebuildVectors() 换 embedding 模型后重算全部向量
 *
 * 典型接法（以聊天应用为例）：
 *   const engine = await MemoryEngine.open({ dir, provider, persona:{...} });
 *   // 每轮对话结束
 *   engine.enqueue({ userMessage, aiResponse });   // 缓冲，不阻塞对话
 *   // 生成回复前
 *   const { promptText } = await engine.recall(userInput);
 *   // 把 promptText 拼进 system prompt 即可
 */

const path = require('path');
const crypto = require('crypto');

const { Store } = require('./store');
const { normalize, cosine } = require('./vector');
const {
  extractFacts, conceptualize, extractEntityRelations, extractEventRelations,
  normalizeEventText, formatConversation, buildPersonaSection
} = require('./extract');
const { retrieve, DEFAULTS: RETRIEVAL_DEFAULTS } = require('./retrieve');
const { maintain, DEFAULTS: DECAY_DEFAULTS } = require('./decay');
const providers = require('./providers');
const { TEMPLATES, fill } = require('./prompts');

const newId = () => crypto.randomUUID();

/** 事件节点的时间戳编码：YYYY-MM-DD-HH-mm。 */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

class MemoryEngine {
  constructor(opts) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.persona = { personaName: '助手', genderTerm: '你', ...(opts.persona || {}) };
    this.retrieval = { ...RETRIEVAL_DEFAULTS, ...(opts.retrieval || {}) };
    this.decay = { ...DECAY_DEFAULTS, ...(opts.decay || {}) };
    this.extraction = {
      enableDynamicConcept: true,
      enableStage1: false,   // 出厂默认关闭
      enableStage3: false,
      maxNewConcepts: 5,
      existingConceptsLimit: 50,
      maxRelationsPerBatch: 20,
      timeoutMs: 60000,
      ...(opts.extraction || {})
    };
    this.importanceDefaults = { event: 0.5, entity: 0.5, concept: 0.5, ...(opts.importanceDefaults || {}) };
    /** 未达批次阈值时先攒着，避免每轮对话都打一次 LLM */
    this._pending = [];
    this.batchSize = opts.batchSize || 2;
    this._flushing = null;
    this.logger = opts.logger || (() => {});
  }

  /**
   * 打开一个引擎。
   * @param {object} opts
   *   dir      数据目录（每档一个）；也可直接传 store 实例
   *   provider providers.openai() / .offline() / .mock()
   *   persona  { personaName, genderTerm, personaDescription, personaPersonality }
   *   retrieval / decay / extraction  覆盖默认配置
   */
  static async open(opts = {}) {
    const store = opts.store || Store.open(opts.dir || path.join(process.cwd(), 'memory_store'));
    const provider = opts.provider || providers.offline();
    const engine = new MemoryEngine({ ...opts, store, provider });
    store.meta.engine = 'memory-graph';
    store.meta.lastOpenedAt = Date.now();
    return engine;
  }

  // ---------------- 写入 ----------------

  /**
   * 缓冲一轮对话。达到 batchSize 自动触发抽取。
   * 刻意不 await LLM —— 对话不该等记忆写完。
   */
  enqueue(item) {
    if (!item || (!item.userMessage && !item.aiResponse)) return;
    if (this._isTrivial(item)) return;
    this._pending.push({
      userMessage: String(item.userMessage || ''),
      aiResponse: String(item.aiResponse || ''),
      timestamp: item.timestamp || Date.now(),
      metadata: item.metadata || {}
    });
    this.logger('enqueue', { pending: this._pending.length });
    if (this._pending.length >= this.batchSize) {
      // 故意不 await：让调用方继续跑，抽取在后台完成
      this.flush().catch((e) => this.logger('flush_error', { error: e.message }));
    }
  }

  /** 太短 / 纯符号的对话不值得记。 */
  _isTrivial(item) {
    const clean = `${item.userMessage || ''}${item.aiResponse || ''}`
      .replace(/[\s\u200b-\u200f\u2028-\u202f\u3000\ufeff]/g, '');
    return clean.length < 5;
  }

  /**
   * 立即跑完缓冲区的抽取。返回统计。
   * 应用退出前应该 await 一次，否则最后几轮会丢。
   */
  async flush() {
    if (this._flushing) return this._flushing;
    const items = this._pending.splice(0, this._pending.length);
    if (!items.length) return { skipped: true, reason: 'empty' };
    this._flushing = this._ingest(items).finally(() => { this._flushing = null; });
    return this._flushing;
  }

  /** 立即入库，不等批次。 */
  async ingest(items) {
    const list = Array.isArray(items) ? items : [items];
    const queued = list.filter((it) => it && !this._isTrivial(it));
    if (!queued.length) return { skipped: true, reason: 'trivial' };
    return this._ingest(queued.map((it) => ({
      userMessage: String(it.userMessage || ''),
      aiResponse: String(it.aiResponse || ''),
      timestamp: it.timestamp || Date.now(),
      metadata: it.metadata || {}
    })));
  }

  async _ingest(items) {
    const now = Date.now();
    const ctx = {
      ...this.persona,
      items,
      nowTs: now,
      timeoutMs: this.extraction.timeoutMs,
      importanceDefaults: this.importanceDefaults,
      enableDynamicConcept: this.extraction.enableDynamicConcept,
      enableStage1: this.extraction.enableStage1,
      enableStage3: this.extraction.enableStage3,
      maxNewConcepts: this.extraction.maxNewConcepts,
      existingConceptsLimit: this.extraction.existingConceptsLimit,
      maxRelationsPerBatch: this.extraction.maxRelationsPerBatch
    };

    const stats = {
      items: items.length, events: 0, entities: 0, concepts: 0, edges: 0,
      embedded: 0, degraded: false, notes: []
    };

    // ① 事实抽取
    let facts;
    try {
      facts = await extractFacts(this.provider, ctx);
    } catch (e) {
      this.logger('extract_fail', { error: e.message });
      return { ...stats, degraded: true, notes: ['事实抽取失败，本批未入库'] };
    }
    if (!facts.events.length) {
      // 也记一笔日志：这是「记忆一直是空的」最常见的原因，
      // 运维侧看不到会以为整条管线都没跑。
      this.logger('extract_empty', { items: items.length, raw: String(facts.raw || '').slice(0, 200) });
      return { ...stats, degraded: true, notes: ['未抽到任何事件'] };
    }

    // 事件文本去重 + 与库内已有事件合并（同一件事再次发生 → 提升 importance、刷新时间）
    const fresh = [];
    for (const ev of facts.events) {
      const existing = this._findEventByText(ev.text);
      if (existing) {
        const bumped = Math.max(existing.importance, ev.importance);
        this.store.updateNode(existing.id, {
          importance: bumped,
          lastUsedAt: now,
          instanceCount: (existing.instanceCount || 1) + 1
        });
        stats.notes.push(`事件去重：${ev.text.slice(0, 20)}…`);
      } else {
        fresh.push(ev);
      }
    }
    if (!fresh.length) {
      return { ...stats, notes: [...stats.notes, '全部为重复事件'] };
    }

    // ② 概念归纳（只针对本批新实体）
    const entityNames = [];
    for (const ev of fresh) {
      for (const name of ev.entities) if (!entityNames.includes(name)) entityNames.push(name);
    }
    let conceptMap = new Map();
    let conceptFailed = false;
    try {
      conceptMap = await conceptualize(this.provider, ctx, entityNames, this._knownConcepts());
    } catch (e) {
      conceptFailed = true;
      this.logger('concept_fail', { error: e.message });
    }
    // 解析不出来时 conceptualize 会返回空 Map 而不是抛错。
    // 那种情况同样要记一笔，否则「一个概念都没有」会被误当成「这批没有实体」。
    if (!conceptFailed && this.extraction.enableDynamicConcept !== false
        && entityNames.length > 0 && conceptMap.size === 0) {
      conceptFailed = true;
      this.logger('concept_empty', { entities: entityNames.length });
    }
    if (conceptFailed) stats.notes.push('概念归纳未产出，已跳过（事件与实体照常入库）');

    const conversationText = formatConversation(items, this.persona.personaName, this.persona.genderTerm);

    // ③④ 关系抽取
    let entityRelations = [];
    let eventRelations = [];
    try {
      entityRelations = await extractEntityRelations(this.provider, ctx, entityNames, conversationText);
    } catch (e) {
      this.logger('stage1_fail', { error: e.message });
      stats.notes.push('stage1 关系抽取失败，跳过');
    }
    try {
      eventRelations = await extractEventRelations(this.provider, ctx, fresh);
    } catch (e) {
      this.logger('stage3_fail', { error: e.message });
      stats.notes.push('stage3 关系抽取失败，跳过');
    }

    // ---- 写节点 ----
    const eventNodes = [];
    for (const ev of fresh) {
      const node = {
        id: newId(),
        nodeType: 'event',
        content: ev.text,
        importance: ev.importance,
        eventTime: stamp(items[0].timestamp || now),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        instanceCount: 1,
        custom: false,
        sourceConversation: items.map((i) => i.userMessage).join(' | ').slice(0, 500),
        metadata: items[0].metadata || {}
      };
      this.store.putNode(node);
      eventNodes.push({ node, entities: ev.entities });
      stats.events++;
    }

    const entityNodes = new Map();
    for (const { node: evNode, entities } of eventNodes) {
      for (const name of entities) {
        let ent = entityNodes.get(name) || this._findNodeByName(name, 'entity');
        if (!ent) {
          ent = {
            id: newId(),
            nodeType: 'entity',
            content: name,
            importance: this._importanceFromEvents(fresh),
            createdAt: now, updatedAt: now, lastUsedAt: now,
            instanceCount: 1, custom: false
          };
          this.store.putNode(ent);
          entityNodes.set(name, ent);
          stats.entities++;
        } else {
          this.store.updateNode(ent.id, { lastUsedAt: now, instanceCount: (ent.instanceCount || 1) + 1 });
        }
        this._link(ent.id, evNode.id, 'participates_in');
      }
    }

    const conceptNodes = new Map();
    for (const [entName, concepts] of conceptMap) {
      const ent = entityNodes.get(entName) || this._findNodeByName(entName, 'entity');
      if (!ent) continue;
      for (const c of concepts) {
        let cn = conceptNodes.get(c) || this._findNodeByName(c, 'concept');
        if (!cn) {
          cn = {
            id: newId(),
            nodeType: 'concept',
            content: c,
            importance: ent.importance,
            createdAt: now, updatedAt: now, lastUsedAt: now,
            instanceCount: 1, custom: false
          };
          this.store.putNode(cn);
          conceptNodes.set(c, cn);
          stats.concepts++;
        } else {
          this.store.updateNode(cn.id, { lastUsedAt: now, instanceCount: (cn.instanceCount || 1) + 1 });
        }
        this._link(ent.id, cn.id, 'conceptualized_as');
      }
    }

    // stage1：实体 ↔ 实体
    for (const r of entityRelations) {
      const a = entityNodes.get(r.src) || this._findNodeByName(r.src, 'entity');
      const b = entityNodes.get(r.dst) || this._findNodeByName(r.dst, 'entity');
      if (a && b) this._link(a.id, b.id, r.relation);
    }

    // stage3：事件 ↔ 事件
    for (const r of eventRelations) {
      const a = eventNodes[r.src - 1]?.node;
      const b = eventNodes[r.dst - 1]?.node;
      if (a && b) this._link(a.id, b.id, r.relation.toLowerCase());
    }

    // ---- 补向量 ----
    stats.embedded = await this._embedMissing();
    stats.degraded = false;
    this.store.meta.counters.lastIngestAt = now;
    this.store.saveMeta();
    this.logger('ingest_done', stats);
    return stats;
  }

  /** 建边（去重），返回是否新建。 */
  _link(sourceId, targetId, relation) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    if (this.store.findEdge(sourceId, targetId, relation)) return false;
    this.store.putEdge({
      id: newId(),
      sourceId, targetId, relation,
      weight: 1,
      createdAt: Date.now()
    });
    return true;
  }

  _findEventByText(text) {
    const key = normalizeEventText(text);
    for (const n of this.store.nodes.values()) {
      if (n.nodeType === 'event' && normalizeEventText(n.content) === key) return n;
    }
    return null;
  }

  _findNodeByName(name, type) {
    for (const n of this.store.nodes.values()) {
      if (n.nodeType === type && n.content === name) return n;
    }
    return null;
  }

  /** 一条事件涉及多个实体时，取最高 importance 作为实体的初始重要度。 */
  _importanceFromEvents(events) {
    let max = this.importanceDefaults.entity;
    for (const e of events) if (e.importance > max) max = e.importance;
    return max;
  }

  _knownConcepts() {
    return this.store.allNodes().filter((n) => n.nodeType === 'concept').map((n) => n.content);
  }

  /** 给还没有向量的节点补打向量。分批调用，避免一次请求太大。 */
  async _embedMissing(limit = 200) {
    const pending = [];
    for (const n of this.store.nodes.values()) {
      if (!n.vector || n.vector.length === 0) pending.push(n);
      if (pending.length >= limit) break;
    }
    if (!pending.length) return 0;

    const BATCH = 32;
    let done = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const vecs = await this.provider.embed(slice.map((n) => n.content));
      slice.forEach((n, idx) => {
        this.store.updateNode(n.id, { vector: Array.from(normalize(vecs[idx])) });
        done++;
      });
    }
    return done;
  }

  // ---------------- 读取 ----------------

  /**
   * 召回。
   * @param {string} query 用户当前这句话
   * @param {object} opts  可覆盖 retrieval 配置；也可传 queryVector 跳过向量服务
   * @returns {{promptText:string, items:Array, stats:object}}
   */
  async recall(query, opts = {}) {
    const text = String(query || '').trim();
    if (!text) return { promptText: '', items: [], stats: { returned: 0, reason: 'empty_query' } };

    let queryVec = opts.queryVector ? normalize(opts.queryVector) : null;
    if (!queryVec) {
      const [v] = await this.provider.embed([text]);
      queryVec = v instanceof Float32Array ? v : normalize(v);
    }

    const result = retrieve(this.store, queryVec, { ...this.retrieval, ...opts });
    // 被召回的记忆算「用过」，刷新 lastUsedAt —— 热记忆因此更不容易被裁掉
    const now = Date.now();
    for (const it of result.items) this.store.updateNode(it.node.id, { lastUsedAt: now });
    return result;
  }

  /** 只看结构化结果，不要提示词。 */
  async search(query, opts = {}) {
    const r = await this.recall(query, opts);
    return r.items.map((it) => ({
      id: it.node.id,
      content: it.node.content,
      score: it.score,
      similarity: it.similarity,
      importance: it.node.importance,
      custom: !!it.node.custom,
      createdAt: it.node.createdAt
    }));
  }

  /** 某个节点的关联边（做记忆图谱 UI 用）。 */
  edgesOf(nodeId) {
    return this.store.edgesOf(nodeId).map((e) => ({
      ...e,
      sourceLabel: this.store.getNode(e.sourceId)?.content || '',
      targetLabel: this.store.getNode(e.targetId)?.content || ''
    }));
  }

  /** 列出节点，可按类型/关键词过滤（做管理界面用）。 */
  listNodes({ nodeType, search, offset = 0, limit = 50 } = {}) {
    let all = this.store.allNodes();
    if (nodeType) all = all.filter((n) => n.nodeType === nodeType);
    if (search) all = all.filter((n) => String(n.content).includes(search));
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return {
      total: all.length,
      offset,
      limit,
      nodes: all.slice(offset, offset + limit).map((n) => ({
        id: n.id, nodeType: n.nodeType, content: n.content,
        importance: n.importance, eventTime: n.eventTime,
        custom: !!n.custom, createdAt: n.createdAt
      }))
    };
  }

  // ---------------- 管理 ----------------

  /** 手标记：永不衰减，且检索时加分。 */
  markCustom(nodeId) {
    const n = this.store.updateNode(nodeId, { custom: true, importance: Math.max(n0(this.store, nodeId), 1) });
    return !!n;
  }

  unmarkCustom(nodeId) {
    return !!this.store.updateNode(nodeId, { custom: false });
  }

  deleteNode(nodeId) {
    return this.store.deleteNode(nodeId);
  }


  // ---------------- 管理指令支撑（QQ「记住/忘掉/整理记忆」） ----------------

  /**
   * 直接写入一条钉住事件（指令「记住：…」用）。不走 LLM 抽取，内容即事件文本；
   * custom=true：永不衰减 + 检索加分。同一内容已存在时改为钉住旧条目。
   * @returns {{node: object, deduped: boolean}|null} 失败返回 null
   */
  async addCustomEvent(content, opts = {}) {
    const text = String(content || '').trim();
    if (text.length < 2 || text.length > 500) return null;
    const now = Date.now();
    const dup = this._findEventByText(text);
    if (dup) {
      this.store.updateNode(dup.id, {
        custom: true,
        importance: Math.max(dup.importance, opts.importance ?? 1),
        lastUsedAt: now,
        instanceCount: (dup.instanceCount || 1) + 1
      });
      await this._embedNode(dup.id, dup.content);
      this.store.saveMeta();
      return { node: this.store.getNode(dup.id), deduped: true };
    }
    const node = {
      id: newId(), nodeType: 'event', content: text,
      importance: opts.importance ?? 1,
      eventTime: stamp(now),
      createdAt: now, updatedAt: now, lastUsedAt: now,
      instanceCount: 1, custom: true,
      sourceConversation: '', metadata: { pinned: true }
    };
    this.store.putNode(node);
    await this._embedNode(node.id, text);
    this.store.saveMeta();
    return { node: this.store.getNode(node.id), deduped: false };
  }

  /** 给单个节点补/刷向量（失败静默——节点仍在，只是暂不参与召回）。 */
  async _embedNode(nodeId, text) {
    try {
      const [v] = await this.provider.embed([text]);
      if (v && this.store.getNode(nodeId)) {
        this.store.updateNode(nodeId, { vector: Array.from(normalize(v)) });
      }
    } catch (_) { /* 离线/端点抖动都不致命 */ }
  }

  /**
   * 按内容删除记忆（指令「忘掉 …」用）。
   * 归一化精确匹配优先，其次子串匹配（仅 event/summary，不动实体与概念）。
   * @returns {Array<{id, content, nodeType}>} 实际删除的节点
   */
  forgetByText(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const key = normalizeEventText(q);
    if (!key) return [];
    const hits = [];
    for (const n of this.store.allNodes()) {
      if (n.nodeType !== 'event' && n.nodeType !== 'summary') continue;
      const nk = normalizeEventText(n.content);
      if (nk === key || (key.length >= 2 && nk.includes(key))) hits.push(n);
    }
    const removed = [];
    for (const n of hits.slice(0, opts.limit ?? 10)) {
      if (this.store.deleteNode(n.id)) removed.push({ id: n.id, content: n.content, nodeType: n.nodeType });
    }
    if (removed.length) this.store.saveMeta();
    return removed;
  }

  /**
   * 摘要层：把同一实体下的事件交给 LLM 归纳成「长期主题」摘要节点
   * （nodeType='summary'，参与检索）。幂等——同一主题只保留一份，重跑即改写。
   * @returns {Promise<Array<{topic, content, updated}>>}
   */
  async summarize(opts = {}) {
    const cfg = {
      maxTopics: 5, minEvents: 3, maxEventsPerTopic: 30,
      timeoutMs: this.extraction.timeoutMs,
      ...(opts || {})
    };
    // 统计每个实体挂着多少事件
    const count = new Map();
    for (const e of this.store.allEdges()) {
      if (e.relation !== 'participates_in') continue;
      const a = this.store.getNode(e.sourceId), b = this.store.getNode(e.targetId);
      if (a && b && a.nodeType === 'entity' && b.nodeType === 'event') count.set(a.id, (count.get(a.id) || 0) + 1);
      if (a && b && b.nodeType === 'entity' && a.nodeType === 'event') count.set(b.id, (count.get(b.id) || 0) + 1);
    }
    const ranked = [...count.entries()]
      .filter(([, c]) => c >= cfg.minEvents)
      .sort((a, b) => b[1] - a[1])
      .slice(0, cfg.maxTopics);

    const out = [];
    for (const [entId, c] of ranked) {
      const ent = this.store.getNode(entId);
      if (!ent) continue;
      const events = this.store.edgesOf(entId)
        .map((e) => this.store.getNode(e.sourceId === entId ? e.targetId : e.sourceId))
        .filter((n) => n && n.nodeType === 'event')
        .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))
        .slice(0, cfg.maxEventsPerTopic);
      if (events.length < cfg.minEvents) continue;

      const existing = this.store.allNodes().find(
        (n) => n.nodeType === 'summary' && n.metadata && n.metadata.topic === ent.content
      );
      const built = fill(TEMPLATES.summarizeTemplate, {
        persona_name: this.persona.personaName,
        gender_term: this.persona.genderTerm,
        topic: ent.content,
        count: events.length,
        previous: existing ? existing.content : '（暂无）',
        events: events.map((ev, i) => (i + 1) + '. ' + ev.content).join('\n')
      });
      let text = '';
      try {
        text = String(await this.provider.chat([{ role: 'user', content: built }], { timeoutMs: cfg.timeoutMs })).trim();
      } catch (e) {
        this.logger('summarize_fail', { topic: ent.content, error: e.message });
        continue;
      }
      text = text.replace(/^\s*#+.*$/gm, '').trim().slice(0, 800);
      if (text.length < 10) continue;

      const now = Date.now();
      if (existing) {
        this.store.updateNode(existing.id, {
          content: text, updatedAt: now, lastUsedAt: now,
          importance: Math.max(0.8, existing.importance || 0)
        });
        await this._embedNode(existing.id, text);
        out.push({ topic: ent.content, content: text, updated: true });
      } else {
        const node = {
          id: newId(), nodeType: 'summary', content: text,
          importance: 0.8,
          createdAt: now, updatedAt: now, lastUsedAt: now,
          instanceCount: 1, custom: false,
          metadata: { topic: ent.content }
        };
        this.store.putNode(node);
        this._link(entId, node.id, 'summarized_by');
        await this._embedNode(node.id, text);
        out.push({ topic: ent.content, content: text, updated: false });
      }
    }
    if (out.length) this.store.saveMeta();
    this.logger('summarize_done', { topics: out.length });
    return out;
  }

  /** 跑一次衰减 + 裁剪。建议每天启动时调一次。 */
  maintain(opts = {}) {
    const r = maintain(this.store, { ...this.decay, ...opts });
    this.store.saveMeta();
    return r;
  }

  /** 换 embedding 模型后，把全部向量清掉重算。 */
  async rebuildVectors() {
    for (const n of this.store.allNodes()) this.store.updateNode(n.id, { vector: [] });
    return this._embedMissing(100000);
  }

  stats() {
    const byType = this.store.countByType();
    return {
      totalNodes: this.store.nodeCount(),
      totalEdges: this.store.edgeCount(),
      ...byType,
      dbSizeBytes: this.store.sizeBytes(),
      deleteRatio: Number(this.store.deleteRatio().toFixed(3)),
      provider: this.provider.name,
      pending: this._pending.length
    };
  }

  /** 关掉前把缓冲刷完。 */
  async close() {
    await this.flush();
    this.store.saveMeta();
  }
}

function n0(store, id) {
  const n = store.getNode(id);
  return n && Number.isFinite(n.importance) ? n.importance : 0.5;
}

/** 便捷导出：一个函数开箱即用。 */
async function createMemory(opts) {
  return MemoryEngine.open(opts);
}

module.exports = { MemoryEngine, createMemory, providers, newId };