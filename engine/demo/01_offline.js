'use strict';
/**
 * 离线 demo —— 不联网、不需要 API Key，直接 `node demo/01_offline.js` 就能跑。
 *
 * 用的是 providers.offline()：向量走字符 n-gram，抽取走内置规则。
 * 它跑出来的记忆质量一般（规则抽取比不上真模型），但足以验证
 * 存储 / 建图 / 检索 / 重排 / 衰减 这整条链路是通的。
 *
 * 想看真实效果请用 02_openai_compatible.js。
 */

const path = require('path');
const fs = require('fs');
const { MemoryEngine, providers } = require('../src');

const DIR = path.join(__dirname, '.demo-store', 'offline');
fs.rmSync(DIR, { recursive: true, force: true }); // demo 每次从干净状态开始

const CONVERSATION = [
  { userMessage: '我周末想去游乐园玩', aiResponse: '好啊，那我们提前一天看看天气怎么样' },
  { userMessage: '我最喜欢草莓蛋糕了', aiResponse: '记住了，下次路过蛋糕店给你带一个' },
  { userMessage: '我们约定下周三去看电影', aiResponse: '好的，我记下了，到时候提醒你' },
  { userMessage: '今天天气不错', aiResponse: '嗯嗯' },
  { userMessage: '对了，我叫小河', aiResponse: '小河，我记住了' }
];

const line = (s) => console.log(s);
const rule = () => line('─'.repeat(64));

(async () => {
  line('【1】建库');
  rule();
  const engine = await MemoryEngine.open({
    dir: DIR,
    provider: providers.offline({ dim: 512 }),
    persona: { personaName: '小忆', genderTerm: '用户', personaDescription: '远房表妹' },
    batchSize: 99 // demo 里手动 flush，不让它自动触发
  });
  line(`数据目录：${DIR}`);
  line(`Provider：${engine.provider.name}`);
  line('');

  line('【2】把对话喂进去');
  rule();
  for (const turn of CONVERSATION) engine.enqueue(turn);
  const stats = await engine.flush();
  line(`抽取结果：事件 ${stats.events} · 实体 ${stats.entities} · 概念 ${stats.concepts} · 向量 ${stats.embedded}`);
  if (stats.notes.length) for (const n of stats.notes) line(`  注：${n}`);
  line('');

  line('【3】知识图谱长什么样');
  rule();
  const s = engine.stats();
  line(`节点 ${s.totalNodes}（事件 ${s.event} / 实体 ${s.entity} / 概念 ${s.concept}）· 边 ${s.totalEdges}`);
  line('');
  for (const n of engine.listNodes({}).nodes) {
    const mark = n.importance >= 0.7 ? '★' : ' ';
    line(`${mark} [${n.nodeType.padEnd(7)}] ${n.content}`);
  }
  line('');
  line('选一个实体看它的边：');
  const entities = engine.listNodes({ nodeType: 'entity' }).nodes;
  if (entities.length) {
    const pick = entities[0];
    line(`  「${pick.content}」的关联：`);
    for (const e of engine.edgesOf(pick.id)) {
      line(`    --[${e.relation}]--> ${e.targetLabel}`);
    }
  }
  line('');

  line('【4】检索：假装用户又提起某件事');
  rule();
  for (const q of ['游乐园', '草莓蛋糕', '下周看电影', '量子力学']) {
    const r = await engine.recall(q);
    line(`问「${q}」`);
    if (!r.promptText) {
      line('  → 没有相关记忆，不注入任何内容');
    } else {
      line(`  → 召回 ${r.items.length} 条（候选 ${r.stats.expanded}，通过门限 ${r.stats.passed}）`);
      for (const it of r.items) {
        line(`     · ${it.node.content}  [相似 ${it.similarity.toFixed(3)} | 重要 ${it.importance.toFixed(2)} | 综合 ${it.score.toFixed(3)}]`);
      }
      line('  → 实际拼进提示词的内容：');
      for (const l of r.promptText.trim().split('\n')) line(`     ${l}`);
    }
    line('');
  }

  line('【5】手标记一条「不许忘」');
  rule();
  const events = engine.listNodes({ nodeType: 'event' }).nodes;
  if (events.length) {
    const target = events[0];
    engine.markCustom(target.id);
    line(`已标记：${target.content}`);
    line('效果：重要度拉满 + 检索加分 0.3 + 永不衰减');
  }
  line('');

  line('【6】模拟时间流逝（把库里所有记忆改成 200 天前），看谁活下来');
  rule();
  const DAY = 86400000;
  for (const n of engine.store.allNodes()) {
    engine.store.updateNode(n.id, {
      createdAt: Date.now() - 200 * DAY,
      lastDecayAt: Date.now() - 200 * DAY
    });
  }
  const before = engine.stats().totalNodes;
  const m = engine.maintain();
  const after = engine.stats().totalNodes;
  line(`维护前 ${before} 个节点 → 维护后 ${after} 个`);
  line(`  衰减调整：${m.decay.touched} 个`);
  line(`  遗忘删除：${m.decay.removed} 个（久未提起，重要度掉到门限以下）`);
  line(`  概念裁剪：${m.prune.removed.length} 个`);
  line(`  文件压实：${m.compacted ? '已压实' : '没必要'}`);
  line('');
  const survivors = engine.listNodes({}).nodes;
  line('活下来的：');
  for (const n of survivors) {
    line(`  ${n.custom ? '★（手标记，永不衰减）' : ' '} [${n.nodeType}] ${n.content}`);
  }
  line('（其余都被忘掉了 —— 这就是想要的效果）');
  line('');

  line('【7】重开验证持久化');
  rule();
  await engine.close();
  const engine2 = await MemoryEngine.open({
    dir: DIR, provider: providers.offline({ dim: 512 }), persona: { personaName: '小忆', genderTerm: '用户' }
  });
  const s2 = engine2.stats();
  line(`重开后：${s2.totalNodes} 节点 / ${s2.totalEdges} 边 / 磁盘 ${s2.dbSizeBytes} 字节`);
  const still = await engine2.recall('游乐园');
  line(`仍然记得游乐园吗：${still.items.length ? '记得 → ' + still.items[0].node.content : '不记得了'}`);
  line('');
  line('磁盘上的文件：');
  for (const f of fs.readdirSync(DIR)) {
    line(`  ${f}  ${fs.statSync(path.join(DIR, f)).size} 字节`);
  }
  await engine2.close();

  line('');
  line('完成。想换真模型，改 provider 即可，业务代码一行不用动：');
  line('  providers.openai({ baseUrl: "http://127.0.0.1:11434/v1", chatModel: "qwen2.5", embedModel: "bge-m3", dim: 1024 })');
})().catch((e) => {
  console.error('demo 失败：', e);
  process.exit(1);
});