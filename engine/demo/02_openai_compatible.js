'use strict';
/**
 * OpenAI 兼容 demo —— 走真实 HTTP，验证 provider 层。
 *
 * 为了让它「开箱即跑」，脚本会自己起一个极简的 OpenAI 兼容服务端当靶子，
 * 跑完自动关掉。这个靶子同时也是**接口说明书**：
 * 你若要把记忆接进别的系统，照这两个端点实现就成。
 *
 *   POST {baseUrl}/chat/completions   -> { choices: [ { message: { content } } ] }
 *   POST {baseUrl}/embeddings         -> { data: [ { index, embedding } ] }
 *
 * 想接真模型，把 STUB = false，改下面 CONFIG 就行：
 *   Ollama    http://127.0.0.1:11434/v1       chatModel='qwen2.5:7b'   embedModel='bge-m3'      dim=1024
 *   LM Studio http://127.0.0.1:1234/v1        chatModel='本地模型名'    embedModel='…'
 *   DeepSeek  https://api.deepseek.com/v1     chatModel='deepseek-chat'（无 embedding，需另配）
 *   SiliconFlow https://api.siliconflow.cn/v1 chatModel='Qwen/Qwen2.5-7B-Instruct'
 *                                             embedModel='BAAI/bge-large-zh-v1.5'  dim=1024
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { MemoryEngine, providers } = require('../src');

const STUB = true; // ← 接真模型时改成 false

const CONFIG = {
  baseUrl: 'http://127.0.0.1:18120/v1',
  apiKey: 'demo-key',
  chatModel: 'demo-chat',
  embedModel: 'demo-embed',
  dim: 512
};

const line = (s) => console.log(s);
const rule = () => line('─'.repeat(64));

/** 极简 OpenAI 兼容服务端：确定性伪向量 + 脚本化的抽取结果。 */
function startStub() {
  const DIM = CONFIG.dim;
  const vec = (text) => {
    const out = new Float64Array(DIM);
    const s = String(text);
    // 字符 n-gram 哈希，够 demo 用；真模型请用真 embedding
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= s.length; i++) {
        let h = 2166136261;
        for (let k = i; k < i + n; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
        out[(h >>> 0) % DIM] += ((h >>> 31) & 1) ? 1 : -1;
      }
    }
    let norm = 0; for (const x of out) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Array.from(out, (x) => x / norm);
  };

  const FACTS = JSON.stringify([
    { Event: '用户答应 小忆 周末一起去游乐园，约定提前一天确认天气', Importance: 0.82, Entities: ['小忆', '用户', '游乐园'] },
    { Event: '用户在桌游板块抱怨关卡太难，小忆 建议换装备再试', Importance: 0.5, Entities: ['用户', '小忆', '装备'] }
  ]);
  const CONCEPTS = JSON.stringify({ 游乐园: ['娱乐场所'], 装备: ['游戏道具'], 小忆: ['家人'], 用户: ['家人'] });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body); } catch (_) { /* 空 body */ }
      const auth = req.headers.authorization || '(无)';
      line(`  [stub] ${req.method} ${req.url}  Authorization: ${auth}`);

      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url.endsWith('/embeddings')) {
        const inputs = Array.isArray(p.input) ? p.input : [p.input];
        return send({
          data: inputs.map((t, i) => ({ index: i, embedding: vec(t) })),
          usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 }
        });
      }

      if (req.url.endsWith('/chat/completions')) {
        const prompt = (p.messages || []).map((m) => m.content).join('\n');
        let content = '[]';
        if (prompt.includes('事件提取任务')) content = FACTS;
        else if (prompt.includes('概念归纳任务')) content = CONCEPTS;
        return send({
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
        });
      }

      res.writeHead(404).end('{}');
    });
  });
  return new Promise((resolve) => server.listen(18120, '127.0.0.1', () => resolve(server)));
}

(async () => {
  let server = null;
  if (STUB) {
    line('【0】启动一个 OpenAI 兼容的靶子服务端');
    rule();
    server = await startStub();
    line(`  监听 ${CONFIG.baseUrl}`);
    line('  它同时充当接口说明书：记忆系统只要求这两个端点');
    line('');
  }

  const engine = await MemoryEngine.open({
    dir: path.join(__dirname, '.demo-store', 'openai'),
    provider: providers.openai(CONFIG),
    persona: { personaName: '小忆', genderTerm: '用户', personaDescription: '远房表妹', personaPersonality: '活泼' },
    batchSize: 1
  });
  // demo 重跑时清干净，避免上一轮的重复事件干扰观察
  engine.store.reset();
  if (server) line('');

  line('【1】一轮对话入库（注意 stub 收到的 HTTP 请求）');
  rule();
  const stats = await engine.ingest([
    { userMessage: '用户，周末带我去游乐园好不好？', aiResponse: '好啊，那我们提前一天看天气预报。' }
  ]);
  line('');
  line(`结果：事件 ${stats.events} · 实体 ${stats.entities} · 概念 ${stats.concepts} · 向量 ${stats.embedded}`);
  line('');

  line('【2】知识图谱');
  rule();
  for (const n of engine.listNodes({}).nodes) line(`  [${n.nodeType.padEnd(7)}] ${n.content}`);
  line('');
  const xiaoyi = engine.listNodes({ nodeType: 'entity', search: '小忆' }).nodes[0];
  line(`「小忆」的边：`);
  for (const e of engine.edgesOf(xiaoyi.id)) line(`  --[${e.relation}]--> ${e.targetLabel}`);
  line('');

  line('【3】召回并注入');
  rule();
  // 靶子用的是字符 n-gram 假向量，只能做「词面相近」的匹配。
  // 真 embedding 模型（bge-m3 之类）才能做到「同义不同词」也召回。
  for (const q of ['周末去游乐园', '量子力学中的泰勒展开']) {
    const r = await engine.recall(q);
    line(`问：「${q}」`);
    if (!r.promptText) {
      line('  → 没有相关记忆，不注入任何内容（相似度没过 0.25 门限）');
    } else {
      line(`  → 召回 ${r.items.length} 条，拼进提示词的内容：`);
      for (const l of r.promptText.trim().split('\n')) line(`    ${l}`);
    }
  }
  line('');

  line('【4】换成真模型只需要改 CONFIG');
  rule();
  line('  STUB = false');
  line('  CONFIG = {');
  line('    baseUrl:    "http://127.0.0.1:11434/v1",   // Ollama');
  line('    chatModel:  "qwen2.5:7b",');
  line('    embedModel: "bge-m3",');
  line('    dim:        1024');
  line('  }');
  line('业务代码一行都不用动。');
  line('');

  if (server) {
    await engine.close();
    server.close();
    line('靶子已关闭。');
  }
})().catch((e) => {
  console.error('demo 失败：', e);
  process.exit(1);
});