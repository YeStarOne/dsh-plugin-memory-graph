'use strict';
/** 向量层测试：归一化、余弦、哈希兜底。 */

const { normalize, cosine, hashEmbed } = require('../src/vector');

describe('向量层', () => {
  it('normalize 产出单位向量', () => {
    const v = normalize([3, 4]);
    assert.near(v[0], 0.6, 1e-6);
    assert.near(v[1], 0.8, 1e-6);
    assert.near(Math.hypot(v[0], v[1]), 1, 1e-6);
  });

  it('normalize 保留 Float32Array 类型', () => {
    const v = normalize(Float32Array.from([1, 0, 0]));
    assert.ok(v instanceof Float32Array, '应仍是 Float32Array');
  });

  it('normalize 对维度不符会抛错', () => {
    assert.throws(() => normalize([1, 2, 3], 4));
  });

  it('normalize 处理零向量不产生 NaN', () => {
    const v = normalize([0, 0, 0]);
    assert.ok(Number.isFinite(v[0]), '零向量不该产生 NaN');
  });

  it('相同方向余弦为 1，垂直为 0，相反为 -1', () => {
    const a = normalize([1, 1, 0]);
    assert.near(cosine(a, normalize([2, 2, 0])), 1, 1e-6, '同向');
    assert.near(cosine(a, normalize([1, -1, 0])), 0, 1e-6, '垂直');
    assert.near(cosine(a, normalize([-1, -1, 0])), -1, 1e-6, '反向');
  });

  it('hashEmbed 输出定长且已归一化', () => {
    const v = hashEmbed('用户 周末 去 游乐园', 256);
    assert.equal(v.length, 256, '维度');
    let n = 0; for (const x of v) n += x * x;
    assert.near(Math.sqrt(n), 1, 1e-5, '模长');
  });

  it('hashEmbed 对相同文本稳定', () => {
    const a = hashEmbed('今天天气不错', 128);
    const b = hashEmbed('今天天气不错', 128);
    assert.near(cosine(a, b), 1, 1e-6);
  });

  it('hashEmbed 对相近文本给出较高相似度，对无关文本较低', () => {
    const base = hashEmbed('周末去游乐园玩', 512);
    const near1 = hashEmbed('周末我们去游乐园玩吧', 512);
    const far = hashEmbed('量子力学中的泰勒展开与微扰理论', 512);
    const sNear = cosine(base, near1);
    const sFar = cosine(base, far);
    assert.ok(sNear > sFar, `相近文本应更相似：near=${sNear.toFixed(3)} far=${sFar.toFixed(3)}`);
    assert.ok(sNear > 0.3, `相近文本相似度应明显：${sNear.toFixed(3)}`);
  });

  it('hashEmbed 对空输入不崩溃', () => {
    const v = hashEmbed('', 64);
    assert.equal(v.length, 64);
    assert.ok(v.every((x) => x === 0), '空输入应为零向量');
  });
});