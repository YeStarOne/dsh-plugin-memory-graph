#!/usr/bin/env node
'use strict';
/**
 * embedding 模型自检工具 —— 上线前必须跑一次。
 *
 * 为什么需要它：向量模型有两个失败模式，从接口连通性上完全看不出来。
 *   1) 维度不符（比如局部模型返回 512 而你配了 1024）→ 检索静默返回空
 *   2) 中文塌缩（所有文本余弦都 0.9+，无关内容也穿过 0.25 门限）→ 检索等于没做
 * 本机实测过的反面案例：nomic-embed-text-v1.5，无关词对「游乐园 vs 草莓蛋糕」余弦 0.9935。
 *
 * 用法：
 *   node tools/check_embedding.js --base-url https://api.siliconflow.cn/v1 \
 *     --model BAAI/bge-m3 --api-key sk-xxx [--dim 1024] [--chat-model Qwen/Qwen2.5-7B-Instruct]
 *
 * 判据：
 *   - 无关词对余弦 < 0.85（nomic 式塌缩会到 0.99+）
 *   - 词级区分度 = min(相关词对) - max(无关词对) ≥ 0.05（≥0.15 为优秀）
 *   - 句级区分度同理（用更接近真实记忆的句子）
 *   - 维度与 --dim 一致
 * 全部通过退出码 0，否则 1。
 */

const { providers, vector } = require('../src');

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
const baseUrl = String(args['base-url'] || process.env.MEM_BASE_URL || '');
const apiKey = String(args['api-key'] || process.env.MEM_API_KEY || '');
const model = String(args['model'] || args['embed-model'] || process.env.MEM_EMBED_MODEL || '');
const expectDim = Number(args.dim || process.env.MEM_DIM || 1024);
const chatModel = String(args['chat-model'] || process.env.MEM_CHAT_MODEL || '');

if (!baseUrl || !model) {
  console.error('用法: node tools/check_embedding.js --base-url <url> --model <模型名> [--api-key <key>] [--dim 1024] [--chat-model <模型名>]');
  process.exit(2);
}

// ---- 测试语料 ----
const WORDS = ['游乐园', '过山车', '草莓蛋糕', '甜品店', '量子力学', '考拉'];
const S1 = '小忆答应用户周末一起去游乐园，约定提前一天确认天气';
const S2 = '我明天要去游乐园玩，记得看天气';
const S3 = '最近在学 Python 编程，准备考试';
const S4 = '用户说他最喜欢吃草莓蛋糕';
const S5 = '今天下雨了，出门记得带伞';
const SENTS = [S1, S2, S3, S4, S5];

const WORDS_RELATED = [['游乐园', '过山车'], ['草莓蛋糕', '甜品店']];
const WORDS_UNRELATED = [['游乐园', '草莓蛋糕'], ['游乐园', '量子力学'], ['游乐园', '考拉'],
                         ['草莓蛋糕', '量子力学'], ['草莓蛋糕', '考拉']];

function fmt(x) { return Number(x).toFixed(4); }

(async () => {
  const provider = providers.openai({ baseUrl, apiKey, embedModel: model, dim: expectDim });
  console.log(`baseUrl  ${baseUrl}`);
  console.log(`model    ${model}`);
  console.log(`apiKey   ${apiKey ? apiKey.slice(0, 6) + '…' + apiKey.slice(-4) : '（未提供）'}`);
  console.log('');

  const all = [...WORDS, ...SENTS];
  const t0 = Date.now();
  const vecs = await provider.embed(all);
  const ms = Date.now() - t0;
  const dim = vecs[0].length;
  const byText = new Map(all.map((t, i) => [t, vecs[i]]));
  const sim = (a, b) => vector.cosine(byText.get(a), byText.get(b));

  let fail = 0;

  // 1) 维度
  const dimOk = dim === expectDim;
  console.log(`【1】维度  ${dim}（期望 ${expectDim}）  ${dimOk ? '✅' : '❌ 维度不符，检索会静默失效'}`);
  if (!dimOk) fail++;

  // 2) 塌缩检查
  const collapse = sim('游乐园', '草莓蛋糕');
  const collapseOk = collapse < 0.85;
  console.log(`【2】中文塌缩检查  无关词对「游乐园 vs 草莓蛋糕」= ${fmt(collapse)}  ${collapseOk ? '✅' : '❌'}`);
  console.log(`      参考：nomic-embed-text-v1.5 本机实测 = 0.9935（塌缩失败）；越小越好`);
  if (!collapseOk) fail++;

  // 3) 词级区分度
  console.log('【3】词级余弦：');
  for (const [a, b] of WORDS_RELATED) console.log(`      相关  ${a} vs ${b} = ${fmt(sim(a, b))}`);
  for (const [a, b] of WORDS_UNRELATED) console.log(`      无关  ${a} vs ${b} = ${fmt(sim(a, b))}`);
  const minRelW = Math.min(...WORDS_RELATED.map(([a, b]) => sim(a, b)));
  const maxUnrelW = Math.max(...WORDS_UNRELATED.map(([a, b]) => sim(a, b)));
  const marginW = minRelW - maxUnrelW;
  const wOk = marginW >= 0.05;
  console.log(`      词级区分度 = ${fmt(marginW)}  ${wOk ? (marginW >= 0.15 ? '✅ 优秀' : '✅') : '❌ 区分度不足'}`);
  if (!wOk) fail++;

  // 4) 句级区分度
  console.log('【4】句级余弦（更接近真实记忆）：');
  console.log(`      同话题  S1 vs S2 = ${fmt(sim(S1, S2))}`);
  console.log(`      异话题  S1 vs S3 = ${fmt(sim(S1, S3))}`);
  console.log(`      异话题  S1 vs S4 = ${fmt(sim(S1, S4))}`);
  console.log(`      异话题  S1 vs S5 = ${fmt(sim(S1, S5))}`);
  const marginS = sim(S1, S2) - Math.max(sim(S1, S3), sim(S1, S4), sim(S1, S5));
  const sOk = marginS >= 0.05;
  console.log(`      句级区分度 = ${fmt(marginS)}  ${sOk ? (marginS >= 0.15 ? '✅ 优秀' : '✅') : '❌ 区分度不足'}`);
  if (!sOk) fail++;

  // 5) 与检索门限的关系
  console.log(`【5】门限适配（minSimilarity=0.25）：同话题句子相似度 ${fmt(sim(S1, S2))} ${sim(S1, S2) > 0.25 ? '✅ 高于门限，能召回' : '⚠️ 低于门限，可能召不回'}`);

  // 6) 可选：chat 模型连通性
  if (chatModel) {
    console.log(`【6】chat 模型连通性（${chatModel}）：`);
    try {
      const reply = await provider.chat([{ role: 'user', content: '只回复两个字：收到' }],
        { model: chatModel, maxTokens: 16 });
      console.log(`      ✅ 返回：${String(reply).trim().slice(0, 40)}`);
    } catch (e) {
      console.log(`      ❌ ${e.message}`);
      fail++;
    }
  }

  console.log(`\n耗时 ${ms}ms ／ 共 ${all.length} 条文本`);
  console.log(fail === 0 ? '结论：全部通过，可以把 dim=' + dim + ' 配进引擎配置。' : `结论：${fail} 项未通过，先解决再上线。`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('调用失败：', e.message);
  process.exit(2);
});