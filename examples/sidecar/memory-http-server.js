'use strict';
/**
 * memory-graph HTTP 侧车 —— 给 QQ 机器人用的长期记忆服务。
 *
 * 用途：机器人用任何语言写都行，只要发 HTTP 就能用上 memory-graph 的记忆能力。
 * 每个 userId（QQ 号 / 群号）映射到一个独立的数据目录，互不干扰。
 *
 * 启动：
 *   node sidecar/qqbot_memory_server.js --port 8899 --data G:/qqbot/memory
 *
 * 模型配置（三选一，按优先级）：
 *   1) 命令行：--base-url http://127.0.0.1:11434/v1 --chat-model qwen2.5:7b --embed-model bge-m3 --dim 1024
 *   2) 环境变量：MEM_BASE_URL / MEM_CHAT_MODEL / MEM_EMBED_MODEL / MEM_DIM / MEM_API_KEY
 *   3) 不加任何参数 —— 走 offline provider（纯规则抽取 + n-gram 向量），能验证管线但不能当生产用
 *
 * 端点：
 *   POST /recall    {userId, query, [topN]}                 -> {promptText, items, stats}
 *   POST /enqueue   {userId, userMessage, aiResponse, [metadata]}  -> {queued:true}
 *   POST /flush     {userId}                                -> {flushed:stats}   攒批立刻跑
 *   POST /search    {userId, query, [topN]}                 -> {items:[...]}     结构化结果
 *   POST /maintain  {userId?}                               -> 全部或指定用户跑衰减
 *   POST /close     {userId?}                               -> 刷盘并释放
 *   GET  /stats     [?userId=]                              -> 单用户或全量统计
 *   GET  /health                                            -> {ok:true}
 *
 * 安全：默认只监听 127.0.0.1。若机器人跑在另一台机器，加 --host 0.0.0.0 并自备防火墙/令牌。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { MemoryEngine, providers } = require('../src');

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const PORT = Number(args.port || process.env.MEM_PORT || 8899);
const HOST = String(args.host || process.env.MEM_HOST || '127.0.0.1');
const DATA_ROOT = path.resolve(String(args.data || process.env.MEM_DATA || path.join(process.cwd(), 'memory_data')));

const baseUrl = String(args['base-url'] || process.env.MEM_BASE_URL || '');
const apiKey = String(args['api-key'] || process.env.MEM_API_KEY || '');
const chatModel = String(args['chat-model'] || process.env.MEM_CHAT_MODEL || 'qwen2.5:7b');
const embedModel = String(args['embed-model'] || process.env.MEM_EMBED_MODEL || 'bge-m3');
const DIM = Number(args.dim || process.env.MEM_DIM || 1024);
const PERSONA_NAME = String(args['persona-name'] || process.env.MEM_PERSONA_NAME || '助手');
const GENDER_TERM = String(args['gender-term'] || process.env.MEM_GENDER_TERM || '你');
const BATCH_SIZE = Number(args['batch-size'] || process.env.MEM_BATCH_SIZE || 2);

/** userId 会变成目录名，必须挡住路径穿越。 */
function safeUserId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9_.@\-]+$/.test(s)) return null;
  if (s === '.' || s === '..') return null;
  return s;
}

const provider = baseUrl
  ? providers.openai({ baseUrl, apiKey, chatModel, embedModel, dim: DIM })
  : providers.offline({ dim: DIM === 1024 ? 512 : DIM });

// ---------------- 引擎池 ----------------

const engines = new Map(); // userId -> Promise<MemoryEngine>

function getEngine(userId) {
  if (!engines.has(userId)) {
    const p = (async () => {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      const dir = path.join(DATA_ROOT, userId);
      fs.mkdirSync(dir, { recursive: true });
      return MemoryEngine.open({
        dir,
        provider,
        persona: { personaName: PERSONA_NAME, genderTerm: GENDER_TERM },
        batchSize: BATCH_SIZE,
        // 抽取是后台异步跑的，默认 logger 是空函数 —— 出错会静默消失。
        // 侧车必须把失败暴露出来，否则只能看到「记忆一直是空的」。
        logger: (event, info) => console.error(`[memory:${userId}] ${event}`, JSON.stringify(info))
      });
    })();
    engines.set(userId, p);
  }
  return engines.get(userId);
}

// ---------------- HTTP ----------------

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('body 过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handle(method, pathname, body) {
  if (method === 'GET' && pathname === '/health') {
    return { code: 200, data: { ok: true, provider: provider.name, dataRoot: DATA_ROOT, users: engines.size } };
  }

  if (method === 'GET' && pathname === '/stats') {
    const uid = safeUserId(body.userId || '');
    if (uid) {
      const eng = await getEngine(uid);
      return { code: 200, data: eng.stats() };
    }
    const all = {};
    for (const [u, p] of engines) all[u] = (await p).stats();
    return { code: 200, data: all };
  }

  if (method !== 'POST') return { code: 405, data: { error: '只支持 POST（除 /health、/stats）' } };

  const userId = safeUserId(body.userId);
  if (!userId) return { code: 400, data: { error: 'userId 缺失或含非法字符（只允许字母数字 _ . @ -）' } };

  const engine = await getEngine(userId);

  switch (pathname) {
    case '/recall': {
      const q = String(body.query || '').trim();
      if (!q) return { code: 400, data: { error: 'query 为空' } };
      const opts = {};
      if (body.topN) opts.rerankTopN = Number(body.topN);
      const r = await engine.recall(q, opts);
      return { code: 200, data: { promptText: r.promptText, items: r.items.map((it) => ({
        id: it.node.id, content: it.node.content, score: it.score,
        similarity: it.similarity, importance: it.node.importance
      })), stats: r.stats } };
    }

    case '/enqueue': {
      if (!body.userMessage && !body.aiResponse) return { code: 400, data: { error: 'userMessage / aiResponse 至少给一个' } };
      engine.enqueue({
        userMessage: body.userMessage,
        aiResponse: body.aiResponse,
        timestamp: body.timestamp,
        metadata: body.metadata
      });
      return { code: 200, data: { queued: true, pending: engine.stats().pending } };
    }

    case '/flush': {
      const stats = await engine.flush();
      return { code: 200, data: { flushed: stats } };
    }

    // 同步入库：等抽取跑完再返回。诊断「记忆不产出」时用它替代 enqueue+flush，
    // 能把抽取统计（events/entities/concepts/degraded/notes）直接暴露出来。
    case '/ingest': {
      if (!body.userMessage && !body.aiResponse) return { code: 400, data: { error: 'userMessage / aiResponse 至少给一个' } };
      const stats = await engine.ingest({
        userMessage: body.userMessage,
        aiResponse: body.aiResponse,
        timestamp: body.timestamp,
        metadata: body.metadata
      });
      return { code: 200, data: { ingested: stats } };
    }

    case '/search': {
      const q = String(body.query || '').trim();
      if (!q) return { code: 400, data: { error: 'query 为空' } };
      const opts = {};
      if (body.topN) opts.rerankTopN = Number(body.topN);
      return { code: 200, data: { items: await engine.search(q, opts) } };
    }

    case '/maintain': {
      const r = engine.maintain();
      return { code: 200, data: { userId, ...r } };
    }

    case '/close': {
      await engine.close();
      engines.delete(userId);
      return { code: 200, data: { closed: userId } };
    }

    default:
      return { code: 404, data: { error: `未知端点 ${pathname}` } };
  }
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) {
        return send(res, 400, { error: e.message });
      }
    } else {
      for (const [k, v] of url.searchParams) body[k] = v;
    }
    try {
      const { code, data } = await handle(req.method, url.pathname, body);
      send(res, code, data);
    } catch (e) {
      console.error(`[${req.method} ${url.pathname}]`, e.message);
      send(res, 500, { error: e.message });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`memory-graph sidecar 已启动`);
  console.log(`  监听    http://${HOST}:${PORT}`);
  console.log(`  数据    ${DATA_ROOT}`);
  console.log(`  provider ${provider.name}${baseUrl ? '' : '  ← 未配 baseUrl，走离线规则模式，仅用于验证管线'}`);
  console.log(`  自检    curl http://${HOST}:${PORT}/health`);
});

// 退出前刷盘，否则最后几轮对话会丢
async function shutdown() {
  console.log('\n正在刷盘…');
  for (const p of engines.values()) {
    try { await (await p).close(); } catch (e) { console.error('close 失败:', e.message); }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);