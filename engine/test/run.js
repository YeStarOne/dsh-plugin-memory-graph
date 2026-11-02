'use strict';
/**
 * 零依赖测试运行器。
 * 用法：node test/run.js  （或 npm test）
 */

const path = require('path');
const fs = require('fs');

const suites = [];
let current = null;

function describe(name, fn) {
  current = { name, cases: [] };
  suites.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  if (!current) throw new Error('it() 必须写在 describe() 里');
  current.cases.push({ name, fn });
}

const assert = {
  ok(v, msg) { if (!v) throw new Error(msg || `期望真值，实际 ${JSON.stringify(v)}`); },
  equal(a, b, msg) {
    if (a !== b) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  },
  notEqual(a, b, msg) {
    if (a === b) throw new Error(`${msg || '值不应相等'}：两者都是 ${JSON.stringify(a)}`);
  },
  near(a, b, tol = 1e-6, msg) {
    if (Math.abs(a - b) > tol) throw new Error(`${msg || '数值不接近'}：${a} vs ${b}（容差 ${tol}）`);
  },
  includes(hay, needle, msg) {
    if (!String(hay).includes(needle)) {
      throw new Error(`${msg || '未包含'}：期望包含 ${JSON.stringify(String(needle).slice(0, 80))}`);
    }
  },
  notIncludes(hay, needle, msg) {
    if (String(hay).includes(needle)) {
      throw new Error(`${msg || '不应包含'}：不应出现 ${JSON.stringify(String(needle).slice(0, 80))}`);
    }
  },
  throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    if (!threw) throw new Error(msg || '期望抛异常，但没有');
  },
  async rejects(promise, msg) {
    try { await promise; } catch (_) { return; }
    throw new Error(msg || '期望 reject，但成功了');
  }
};

// 把断言挂到全局，方便各测试文件直接用
global.describe = describe;
global.it = it;
global.assert = assert;

function tmpDir(name) {
  const dir = path.join(__dirname, '..', '.tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
global.tmpDir = tmpDir;

// 载入所有测试文件
const files = fs.readdirSync(__dirname)
  .filter((f) => /^\d+_.*\.js$/.test(f))
  .sort();
for (const f of files) require(path.join(__dirname, f));

// 执行
(async () => {
  let pass = 0, fail = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(`\n=== ${suite.name} ===`);
    for (const c of suite.cases) {
      try {
        await c.fn();
        console.log(`  ✅ ${c.name}`);
        pass++;
      } catch (e) {
        console.log(`  ❌ ${c.name}`);
        console.log(`     ${e.message.split('\n').join('\n     ')}`);
        fail++;
        failures.push({ suite: suite.name, name: c.name, error: e });
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('\n失败详情：');
    for (const f of failures) {
      console.log(`\n[${f.suite}] ${f.name}`);
      console.log(f.error.stack);
    }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试运行器崩溃：', e);
  process.exit(2);
});