'use strict';
/**
 * 向量工具。
 *
 * 设计取舍：全部用 Float32Array，不引入任何依赖。
 * 检索走暴力扫描而不是 ANN 索引 —— 个人记忆库量级（万条以内）下，
 * 1024 维 × 10000 条 ≈ 1000 万次乘加，JS 里约 10~30ms，完全够用，
 * 而且省掉了索引构建/失效的一堆麻烦。
 */

/** 把任意数组/类型化数组转成归一化 Float32Array。 */
function normalize(vec, dim) {
  const out = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  if (dim && out.length !== dim) {
    throw new Error(`向量维度不符：期望 ${dim}，实际 ${out.length}`);
  }
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return out;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * 余弦相似度。
 * 因为双方都归一化过，余弦退化成点积 —— 省掉两次开方。
 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * 离线兜底向量：字符 n-gram 哈希（hashing trick）。
 *
 * 用途是「没有 embedding 服务时系统仍然能跑」，质量只到词面相似——
 * 「游乐园」能匹配「去游乐园玩」，但匹配不了「过山车」。
 * 要真语义请接 OpenAI 兼容的 embedding 端点（见 providers/openai.js）。
 */
function hashEmbed(text, dim = 512) {
  const out = new Float32Array(dim);
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return out;
  const grams = [];
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= s.length; i++) grams.push(s.slice(i, i + n));
  }
  for (let i = 0; i < s.length; i++) grams.push(s[i]);
  // 中文句子短，纯 n-gram 会太稀疏，额外加整串特征
  grams.push(s);
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % dim;
    // 符号哈希：让不同 n-gram 的贡献能相互抵消，减少碰撞带来的系统性偏差
    out[idx] += ((h >>> 31) & 1) ? 1 : -1;
  }
  return normalize(out);
}

module.exports = { normalize, cosine, hashEmbed };