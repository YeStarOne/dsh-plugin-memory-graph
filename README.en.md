# dsh-plugin-memory-graph

Long-term **graph memory with forgetting** for DSH (DeepSeek Harness) QQ bots: conversations are distilled into events and relations by LLM extraction; relevant memories are injected into the prompt before each reply; stale memories decay out on a forgetting curve. 中文文档见 [README.md](README.md)。

```text
User: how about hiking this weekend?
(system quietly injects: - User planned a Sunday hike and mentioned sunscreen (3 days ago)
                         - User gets sunburned easily, always wears sunscreen (32 days ago))
Bot: Sure! Don't forget the sunscreen you mentioned last time.
```

## Why not another "rolling summary" memory

| | Rolling summary | memory-graph |
| --- | --- | --- |
| Storage | One ever-growing summary blob | Structured graph: events/entities/concepts + semantic/temporal/causal edges |
| Retrieval | Dump everything into context (grows linearly) | Vector recall + subgraph expansion + weighted rerank, **always only the top 5 relevant items** |
| Sense of time | Old facts get overwritten by new summaries | Importance + recency weighting; recall refreshes last-used time |
| Forgetting | None (or indiscriminate) | 30-day half-life decay; cold memories pruned; pinned memories never decay |
| Context cost | Tens of thousands of chars over time | Constant: ≤5 items per turn |
| Ops | Black box | Plain-text JSONL, human-readable, copy-dir backup, git-friendly |

Highlights:

- **4-stage LLM extraction**: facts (events + entities + importance) → concept labeling → entity relations → event temporal/causal relations (last two optional)
- **Hybrid vector + graph retrieval**: topK recall → 4-hop graph expansion → similarity gate → weighted rerank (0.5 similarity / 0.3 importance / 0.2 recency, pinned +0.3) → top 5
- **Zero dependencies**: pure Node ≥18; any OpenAI-compatible endpoint (SiliconFlow free-tier bge-m3, local Ollama, etc.)
- **Per-chat stores**: private/group chats never share memory; fictional scene turns (roleplay/story) are skipped entirely to avoid pollution
- **Capture at generation point**: full reply from session events (pre-bubble-split), deduped by message id, paired only on completed turns
- **Built-in doctor**: embedding sanity check for Chinese collapse / dim mismatch (`check_embedding.js`)
- **Production-proven**: running 24/7 on a real QQ bot

## Quick start

Prerequisite: [dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot) 0.9.x installed and working.

```bash
git clone https://github.com/YeStarOne/dsh-plugin-memory-graph.git
cd dsh-plugin-memory-graph
node installer/install.mjs        # locates dsh-onebot-qq, patches with backups (--check / --uninstall available)
```

Add a `memory:` block to the dsh-onebot-qq config (see [examples/cordis-memory.yml](examples/cordis-memory.yml)), set the two API-key env vars, restart dsh. Pre-flight check:

```bash
node <dsh-onebot-qq>/lib/memory-graph-engine/tools/check_embedding.js \
  --base-url https://api.siliconflow.cn/v1 --model BAAI/bge-m3 --dim 1024 --api-key xxx
```

## How it works

```
WRITE (background)                        READ (per message; local part <100ms)
turn → ①fact extraction → events          msg → embed → vector top10
     → ②concept labeling                        → 4-hop graph expansion
     → ③④relations → graph edges               → gate 0.25 → weighted rerank
     → JSONL graph store                        → top5 block prepended to prompt
daily maintain(): decay / prune / compact
```

See [docs/architecture.md](docs/architecture.md), [docs/pitfalls.md](docs/pitfalls.md) (hard-won lessons: Chinese embedding collapse, silent dim mismatch, capture-point choice), [docs/integration.md](docs/integration.md) (installer internals + manual integration + HTTP sidecar for Python/Go/Java bots).

## Status

- [x] 4-stage extraction / hybrid retrieval / decay / per-chat isolation / scene isolation
- [x] Installer (idempotent, backup, uninstall) + HTTP sidecar
- [ ] In-chat management commands ("remember this" / "forget that")
- [x] Memory graph visualization panel (`viewer/index.html` works by double-click + `npm run graph` export, see [docs/visualization.md](docs/visualization.md))
- [ ] Long-term theme summarization layer

Issues and PRs welcome. MIT — see [LICENSE](LICENSE).
