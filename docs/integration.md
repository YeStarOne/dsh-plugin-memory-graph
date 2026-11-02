# 集成原理（安装器做了什么）

## 自动安装

```
node installer/install.mjs
```

安装器对每个找到的 dsh-onebot-qq 实例（profiles/*/node_modules、~/dsh-plugins、npm -g，去重硬链接）做两件事：

### 1. 部署文件

```
dsh-onebot-qq/
  lib/memory-hub.js            ← 桥接层（本仓 lib/）
  lib/memory-graph-engine/     ← 零依赖引擎（本仓 engine/）
```

引擎也可以放别处（`memory.kitDir` 指过去），部署副本只是默认值。

### 2. 锚点补丁（带备份，失败即中止且不落盘）

**bridge.js（7 处）：**

| # | 位置 | 作用 |
| --- | --- | --- |
| 1 | import 区 | `import { createMemoryHub } from './memory-hub.js'` |
| 2 | 构造函数 | 读 `deps.config.memory`，enabled 时构造 hub |
| 3 | `dispatchFollowup` | `const final` → `let final`（召回块需要前插） |
| 4 | `dispatchFollowup` | 回合派发前：`noteTurn`(用户消息) + `recall`(记忆块前插)；第 5 参带 `adoptedLifeTurn`（虚构场景回合）时整体跳过 |
| 5 | `onSessionEvent` `turn/start` | `beginTurn`（清本轮累加器） |
| 6 | `onSessionEvent` `assistant/message` | `noteAssistant`（完整回复捕获，必须在 deferred 静音 early-return **之前**） |
| 7 | `onSessionEvent` `turn/end` | `finishTurn(chatId, reason.kind === 'completed')`（配对入库）；以及 `stop()` 开头 `await memory.close()` |

**index.js（2 处）：**

| # | 位置 | 作用 |
| --- | --- | --- |
| 8 | Config schema | 加 `memory:` 配置段（设置页自动出现对应表单） |
| 9 | 传给 ChatBridge 的 deps | `memory: config.memory`（⚠️ 没有这一行，schema 里配了也传不进去——这是集成最容易漏的一步） |

备份写成 `lib/bridge.js.bak-memgraph` / `lib/index.js.bak-memgraph`，只在首次安装时生成（重复安装不会覆盖原始备份）。`--uninstall` 用备份还原并删除部署文件。

## 兼容性

- 锚点在 dsh-onebot-qq **0.9.x**（0.9.6 与 0.9.10 实测存在）上验证。其他版本 `--check` 会列出锚点命中数，锚点对不上时安装器直接中止、原文件零改动。
- 已装过的实例再跑安装器 = 幂等：只刷新部署文件（升级引擎用），不重复打补丁。
- 同机 `~/dsh-plugins` 与 profile `node_modules` 若是硬链接双视图，按 inode 去重只补一次。

## 手动集成到其他宿主

不依赖 dsh-onebot-qq 也可以接（任何能拿到「用户消息」和「完整回复」的宿主都行）：

```js
import { createMemoryHub } from 'dsh-plugin-memory-graph';
const hub = createMemoryHub({ log: console.log, config: { enabled: true, /* ...端点配置 */ } });

// 回合开始：hub.beginTurn(chatId)
// 用户消息进来：hub.noteTurn(chatId, userMessage)
//              const memoryText = await hub.recall(chatId, userMessage)  // 前插进提示词
// 模型产出完整回复：hub.noteAssistant(chatId, message)   // message = { id, content:[{type:'text',text}] }
// 回合结束：hub.finishTurn(chatId, ok)                   // ok=true 才入库
// 停机前：await hub.close()
```

语义要点（对应 docs/pitfalls.md 的 3、4、5、6 条）：回复在「生成处」捕获而不是「投递处」；场景/虚构回合跳过；同目录并发 open 要去重；退出前 close。

## HTTP 侧车（任何语言接入）

```
node examples/sidecar/memory-http-server.js --port 8899 --data ./memory
POST /recall  {userId, query} -> {promptText, ...}
POST /enqueue {userId, userMessage, aiResponse}
GET  /stats?userId=...
```

Python / Go / Java 写的机器人发 HTTP 就能用上同一套记忆。
