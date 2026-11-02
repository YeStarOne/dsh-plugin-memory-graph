# memory-graph-engine

零依赖的长期记忆引擎：**对话 → 知识图谱 → 向量召回**。纯 Node 实现（≥18），没有任何原生模块或第三方包。

它是 [dsh-plugin-memory-graph](https://github.com/YeStarOne/dsh-plugin-memory-graph) 的核心引擎，也可以独立抄进任何 Node / Electron 项目。

```bash
node test/run.js                  # 124 项测试（零依赖、不联网）
node demo/01_offline.js           # 离线 demo（不用 API Key）
node demo/02_openai_compatible.js # 真实 HTTP 的 OpenAI 兼容 demo
```

## 它解决什么问题

普通聊天机器人每次对话都从零开始。这套引擎给角色配了一本**会自动整理、自动复习、也会自动遗忘的日记本**：

- 聊过的内容被 LLM 压缩成「事件」，标注重要度与参与实体
- 实体之间建语义关系，实体归入概念类目，事件之间建时序/因果边
- 检索不是纯向量：**向量召回 topK → 沿关系边做子图扩展 → 加权重排（相似度 0.5 / 重要度 0.3 / 新近度 0.2，手标记 +0.3）→ 取前 5**
- 长期不用的记忆按 30 天半衰期衰减，低于阈值自动淘汰（模拟遗忘）；被召回的记忆刷新时间戳，越常用越不容易被裁掉

## 最小用法

```js
const { MemoryEngine, providers } = require('memory-graph-engine');

const engine = await MemoryEngine.open({
  dir: './mem/slot1',                      // 每个用户/会话一个独立目录
  provider: providers.openai({
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: process.env.MY_KEY,
    chatModel: 'deepseek-ai/DeepSeek-V3',  // 抽取用
    embedModel: 'BAAI/bge-m3',             // 向量用（务必先跑 tools/check_embedding.js）
    dim: 1024,
  }),
  persona: { personaName: '小忆', genderTerm: '用户' },
  batchSize: 2,
});

// 每轮对话结束后（缓冲，攒够 batchSize 自动后台抽取，不阻塞对话）
engine.enqueue({ userMessage: '周末去爬山吧', aiResponse: '好呀，记得带防晒' });

// 生成回复前
const { promptText } = await engine.recall('周末去哪玩');
// promptText 形如：
//   [以下为系统信息，非用户发言：可能相关的记忆，自行判断是否需要提及]
//   - 用户约小忆周末去爬山，提到记得带防晒（3天前）

// 退出前
await engine.close();   // 把缓冲刷完
```

## 设计取舍

| 决定 | 理由 |
| --- | --- |
| JSONL 追加式存储（+墓碑+压实） | 零依赖、人类可读、崩溃安全（追加写不需要读锁），拷目录即完整备份，git 友好 |
| 暴力向量扫描，不做 ANN 索引 | 个人记忆库万条以内，1024 维 × 1 万条 ≈ 10~30ms，省掉索引构建/失效的全部麻烦 |
| LLM 输出「宽松解析 + 一次回喂重试」 | 抽取失败降级为「本批不入库」，绝不让记忆管线弄崩对话 |
| 每阶段失败都只记日志不抛异常 | 记忆是锦上添花，任何一步坏掉都退化为「没有记忆」而不是报错 |
| 事件去重按归一化文本匹配，重复事件提升重要度 | 「同一件事又发生了」应该被记住得更牢，而不是存两份 |

## 存储

```
<dir>/nodes.jsonl   节点追加日志（事件/实体/概念，更新=追加新版本行，删除=墓碑行）
<dir>/edges.jsonl   边追加日志
<dir>/meta.json     版本、计数器
```

`deleteRatio` 超过 0.3 时 `maintain()` 自动压实（重写文件丢掉墓碑，写临时文件再 rename，中途断电不损坏）。

## Provider 三种

- `providers.openai(...)`：任何 OpenAI 兼容端点（OpenAI / DeepSeek / SiliconFlow / Ollama / LM Studio / vLLM / 中转），支持额外自定义 HTTP 头
- `providers.offline()`：LLM 走内置规则、向量走字符 n-gram 哈希。没有 API Key 也能跑通全流程（质量有限，仅用于验证与测试）
- `providers.mock(...)`：脚本化返回，测试用

## 上线前必做

```bash
node tools/export_graph.js <数据目录> [输出目录]   # 导出图谱数据给 viewer/index.html 可视化
node tools/check_embedding.js --base-url <向量端点> --model <向量模型> --dim <维度>
```

向量模型有两个从连通性上完全看不出来的失败模式：**维度不符**（检索静默返回空）与**中文塌缩**（无关文本余弦也 0.9+，检索等于没做）。实测反面教材：nomic-embed-text-v1.5 无关词对「游乐园 vs 草莓蛋糕」余弦 0.9935；正面参考：BAAI/bge-m3 同一对 0.4977。该工具会检查维度、塌缩、词级/句级区分度，全过才建议上线。

## License

MIT
