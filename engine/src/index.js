'use strict';
/**
 * memory-graph —— 零依赖的长期记忆引擎（对话 → 知识图谱 → 向量召回）。
 *
 * 纯 Node 实现，没有任何原生依赖：对话被 LLM 压缩成带实体和重要度的
 * 「事件」，事件之间按时序/因果建边，实体按语义归入概念；检索时
 * 向量召回 + 子图扩展 + 加权重排，再模拟遗忘曲线做衰减。
 *
 * 最小用法：
 *
 *   const { MemoryEngine, providers } = require('./src');
 *
 *   const engine = await MemoryEngine.open({
 *     dir: './mem/slot1',
 *     provider: providers.openai({
 *       baseUrl: 'http://127.0.0.1:11434/v1',   // 或任何 OpenAI 兼容端点
 *       chatModel: 'qwen2.5:7b',
 *       embedModel: 'bge-m3',
 *       dim: 1024
 *     }),
 *     persona: { personaName: '小忆', genderTerm: '用户' }
 *   });
 *
 *   // 每轮对话结束
 *   engine.enqueue({ userMessage, aiResponse });
 *
 *   // 生成回复前
 *   const { promptText } = await engine.recall(userInput);
 *   // promptText 形如：
 *   //   [以下为系统信息，非用户发言：可能相关的记忆，自行判断是否需要提及]
 *   //   - 用户答应 小忆 周末一起去游乐园，约定提前一天确认天气（刚刚）
 */

const { MemoryEngine, createMemory, providers, newId } = require('./engine');
const { Store } = require('./store');
const { TEMPLATES, fill } = require('./prompts');
const { retrieve, DEFAULTS: RETRIEVAL_DEFAULTS } = require('./retrieve');
const { decay, prune, maintain, DEFAULTS: DECAY_DEFAULTS } = require('./decay');
const extract = require('./extract');
const vector = require('./vector');

module.exports = {
  MemoryEngine,
  createMemory,
  providers,
  newId,
  Store,
  TEMPLATES,
  fill,
  retrieve,
  decay,
  prune,
  maintain,
  extract,
  vector,
  RETRIEVAL_DEFAULTS,
  DECAY_DEFAULTS
};