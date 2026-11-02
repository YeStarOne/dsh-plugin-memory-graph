# 配置参考

配置写在 dsh-onebot-qq 的配置块里（cordis.patch.yml 或 dsh 设置页）。完整示例见 [examples/cordis-memory.yml](../examples/cordis-memory.yml)。

## 字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。关闭时零行为差异（不打补丁的桥接函数甚至不会被构造） |
| `chatBaseUrl` | `''` | 抽取用对话模型端点（OpenAI 兼容 `/chat/completions`）。**两个端点都填 `offline`** = 无网规则模式，仅验证管线 |
| `chatModel` | `''` | 抽取用对话模型名。要求：指令跟随稳定、能输出 JSON |
| `chatApiKeyEnv` | `MEMORY_GRAPH_CHAT_API_KEY` | 存 API key 的环境变量名。key 不进配置文件 |
| `chatHeaders` | `{}` | 对话端点额外 HTTP 头。某些网关要求自定义会话/鉴权头（如 `x-session-id`）时使用 |
| `embedBaseUrl` | `''` | 向量端点（OpenAI 兼容 `/embeddings`） |
| `embedModel` | `BAAI/bge-m3` | 向量模型。换模型前必跑 `check_embedding.js` |
| `embedApiKeyEnv` | `MEMORY_GRAPH_EMBED_API_KEY` | 存向量 API key 的环境变量名 |
| `dim` | `1024` | 向量维度。**必须与向量模型真实维度一致**，填错检索静默失效 |
| `kitDir` | `''` | 引擎目录。留空 = 安装器部署的 `dsh-onebot-qq/lib/memory-graph-engine` |
| `dataDir` | `''` | 数据根目录（每 chatId 一个子库）。留空 = `~/.dsh/memory-graph-data` |
| `personaName` | `助手` | 抽取提示词里的角色名（影响事件的主语视角） |
| `genderTerm` | `你` | 角色对用户的称呼（影响对话记录的说话人标注） |
| `batchSize` | `2` | 攒几轮对话触发一次抽取。越大越省调用、越晚入库 |
| `flushIntervalMs` | `90000` | 缓冲轮次定时落库间隔（毫秒）。停机时会强制冲刷 |

## 环境变量

```
MEMORY_GRAPH_CHAT_API_KEY    # 对话端点 key
MEMORY_GRAPH_EMBED_API_KEY   # 向量端点 key
```

变量名可以用 `chatApiKeyEnv` / `embedApiKeyEnv` 改成你自己的。

## 推荐组合

| 场景 | chat | embed |
| --- | --- | --- |
| 白嫖起步 | SiliconFlow `Qwen/Qwen2.5-7B-Instruct` | SiliconFlow `BAAI/bge-m3`（免费档） |
| 本地全离线 | Ollama `qwen2.5:7b`（`http://127.0.0.1:11434/v1`） | Ollama `bge-m3` |
| 只想验证管线 | `offline` | `offline` |

## 验证清单（上线前）

```bash
# 1. 向量模型自检（维度/中文塌缩/区分度）——不通过就别上线
node <onebot>/lib/memory-graph-engine/tools/check_embedding.js \
  --base-url https://api.siliconflow.cn/v1 --model BAAI/bge-m3 --dim 1024 \
  --api-key <你的key>

# 2. 引擎自测
cd <onebot>/lib/memory-graph-engine && node test/run.js

# 3. 重启 dsh 后看日志：
#    memory-hub: constructed (enabled=true)
#    memory-hub: engine opened private:xxx -> ~/.dsh/memory-graph-data/...
#    memory-hub: turn buffered private:xxx (N chars)
```

## 常用维护

```js
// 一次性脚本（node --input-type=module 或写个 mjs）：
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MemoryEngine } = require('<onebot>/lib/memory-graph-engine/src/index.js');

const engine = await MemoryEngine.open({
  dir: '~/.dsh/memory-graph-data/private_12345',
  provider: /* 同上 */, persona: { personaName: '助手', genderTerm: '你' },
});
engine.stats();            // 节点/边/库大小
engine.listNodes({ search: '关键词' });   // 查记忆
engine.listNodes({ nodeType: 'event' });
engine.markCustom(id);     // 钉住：永不衰减 + 检索加分（"这条不许忘"）
engine.unmarkCustom(id);
engine.deleteNode(id);     // 删除错误记忆
engine.maintain();         // 手动跑一次衰减/裁剪/压实
await engine.rebuildVectors();  // 换向量模型后全量重算
await engine.close();
```
