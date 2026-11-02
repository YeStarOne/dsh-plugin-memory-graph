# dsh-plugin-memory-graph

给 DSH（DeepSeek Harness）QQ 机器人加一套**会遗忘的长期记忆图谱**：对话被自动压缩成事件与关系，回复前把相关记忆注进上下文，长期不用的记忆按遗忘曲线淡出。

**English**: see [README.en.md](README.en.md)

```text
用户：周末去爬山怎么样？
（系统悄悄注入：- 用户上次约了周日去爬山，提到记得带防晒（3天前）
                - 用户怕晒，夏天出门必涂防晒霜（32天前））
角色：可以呀！防晒霜我还记得你说要带，这次别忘了涂——上次你可是被晒红了。
```

## 为什么不是又一个「总结式记忆」

| | 常见方案（滚动总结） | memory-graph |
| --- | --- | --- |
| 存储 | 一段越滚越长的摘要文本 | 结构化图谱：事件/实体/概念 + 语义/时序/因果边 |
| 检索 | 全文塞进上下文（体量随时间线性涨） | 向量召回 + 子图扩展 + 加权重排，**永远只取最相关的 5 条** |
| 时间感 | 早的事被新总结覆盖丢失 | 重要度 + 新近度加权排序，被召回就刷新时间戳 |
| 遗忘 | 没有（或不分轻重） | 30 天半衰期衰减，冷记忆自动淘汰；钉住的记忆永不衰减 |
| 上下文成本 | 随历史增长，几万字起步 | 恒定：每次 ≤5 条、几十~几百字 |
| 运维 | 黑盒 | JSONL 纯文本、`cat` 可读、拷目录即备份、git 友好 |

核心特征：

- **四阶段 LLM 抽取**：事实（事件+实体+重要度）→ 概念归纳（防概念池膨胀）→ 实体关系 → 事件时序/因果（后两步可开）
- **向量+图混合检索**：topK 召回 → 沿关系边走 4 跳 → 相似度门限 → 加权重排（0.5 相似 / 0.3 重要 / 0.2 新近，钉住 +0.3）→ top 5
- **零依赖**：纯 Node ≥18，无原生模块、无数据库；LLM/向量走任意 OpenAI 兼容端点（含 SiliconFlow 免费档 bge-m3、本地 Ollama）
- **每聊天独立记忆库**：私聊/群聊互不串；虚构场景回合（角色扮演/剧情）整体跳过，不污染记忆
- **生成处捕获**：在 session 事件层抓完整回复（气泡拆分之前），按 message.id 去重，只在回合正常完成后配对入库
- **内置自检工具**：向量模型中文塌缩/维度校验（`check_embedding.js`），上线前必跑
- **生产实证**：在 7×24 真实 QQ 机器人上长期运行（含群聊/私聊/双号互备场景）

## 快速开始

前置：DSH 已装好 [dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot)（0.9.x）并能正常收发消息。

```bash
git clone https://github.com/YeStarOne/dsh-plugin-memory-graph.git
cd dsh-plugin-memory-graph

node installer/install.mjs          # 自动找到 dsh-onebot-qq 并打补丁（带备份，可 --check 预览 / --uninstall 还原）
```

然后在 dsh-onebot-qq 配置里加 `memory:` 块（照抄 [examples/cordis-memory.yml](examples/cordis-memory.yml) 改两个端点），设置环境变量，重启 dsh：

```bash
export MEMORY_GRAPH_CHAT_API_KEY=xxx     # 抽取用对话模型
export MEMORY_GRAPH_EMBED_API_KEY=xxx    # 向量模型
```

上线前自检（30 秒，能省掉 90% 的「为什么召回是空的」）：

```bash
node <dsh-onebot-qq>/lib/memory-graph-engine/tools/check_embedding.js \
  --base-url https://api.siliconflow.cn/v1 --model BAAI/bge-m3 --dim 1024 --api-key xxx
```

重启后随便聊两句，日志出现 `memory-hub: turn buffered ...` 即在工作；攒满 batchSize（默认 2 轮）后自动抽取入库。

> 想先无网试跑：`chatBaseUrl` 和 `embedBaseUrl` 都填 `offline`，引擎走内置规则抽取 + n-gram 向量，全管线可验证（质量有限，仅验证用）。

## 工作原理

```
写入（后台）                     读取（每条消息一次，<100ms 本地部分）
对话轮次 → ①事实抽取 → 事件+实体  消息 → embed → 向量召回top10
         → ②概念归纳 → 概念标签              → 沿关系边扩展4跳
         → ③④关系抽取 → 图谱边               → 门限0.25 → 加权重排
         → JSONL 图谱落盘                    → top5 记忆块注进提示词
每天 maintain(): 衰减(30天半衰)/裁剪/压实
```

细节见 [docs/architecture.md](docs/architecture.md)；集成原理与手动接入其他宿主见 [docs/integration.md](docs/integration.md)。

## 配置速览

| 关键配置 | 说明 |
| --- | --- |
| `chatBaseUrl` / `chatModel` | 抽取用对话模型（OpenAI 兼容） |
| `embedBaseUrl` / `embedModel` / `dim` | 向量模型与维度（**dim 填错检索静默失效**） |
| `chatApiKeyEnv` / `embedApiKeyEnv` | key 走环境变量，不进配置文件 |
| `chatHeaders` | 网关要求自定义头时用 |
| `personaName` / `genderTerm` | 抽取提示词里的角色名与称呼 |
| `dataDir` | 数据目录（默认 `~/.dsh/memory-graph-data`，每 chatId 一个子库） |

全部字段与维护脚本（查/钉/删/重算向量）见 [docs/config.md](docs/config.md)。

## 坑位手册

这套系统踩过的坑全部写进了 [docs/pitfalls.md](docs/pitfalls.md)，最要紧的三条：

1. **向量模型中文塌缩**：某些模型无关文本余弦也 0.99+，检索等于没做——实测 nomic-embed-text-v1.5 就是（0.9935），bge-m3 是 0.4977
2. **维度不符**：不报错，召回永远为空
3. **捕获点要在回复生成处**：挂在投递层会把气泡拆分的碎片当成对话抽进图谱

## 备份

数据是纯文本 JSONL，直接进 git（建议私有仓）：[examples/backup-sync.sh](examples/backup-sync.sh) + cron 一行。

## 状态与路线

- [x] 四阶段抽取 / 混合检索 / 衰减 / 每聊天分库 / 场景隔离
- [x] 安装器（幂等/备份/卸载）+ HTTP 侧车
- [ ] QQ 内管理指令（"记住这条"/"忘掉这条"）
- [ ] 记忆图谱可视化面板
- [ ] 摘要层（跨事件的长期主题归纳）

欢迎 issue / PR。如果它帮你省了心，star 一下就是全部动力。

## License

[MIT](LICENSE)
