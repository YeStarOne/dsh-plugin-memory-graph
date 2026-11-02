#!/usr/bin/env bash
# memory-graph 数据备份示例：数据目录 → 独立 git 仓库（可推私有远端）。
#
# 为什么可以直接进 git：存储是 JSONL 追加日志，每天的变化就是几行追加，
# 仓库体积增长极慢，历史一目了然。建议推到一个【私有】远端——记忆内容
# 属于个人数据。
#
# cron 示例（每天 05:10）：
#   10 5 * * * $HOME/.dsh/memory-graph-backup.sh >> $HOME/.dsh/memory-graph-backup.log 2>&1

set -euo pipefail

DATA="$HOME/.dsh/memory-graph-data"          # 数据目录（与 dataDir 配置一致）
REPO="$HOME/.dsh/memory-graph-backup"        # 备份 git 工作区
REMOTE="${MEMORY_GRAPH_BACKUP_REMOTE:-}"     # 可选：git 远端地址

[ -d "$DATA" ] || { echo "no data dir: $DATA"; exit 0; }
mkdir -p "$REPO"
cd "$REPO"
[ -d .git ] || git init -q

mkdir -p memory
rsync -a --delete "$DATA"/ memory/           # 或 cp -r

git add -A
if ! git diff --cached --quiet; then
  git -c user.name=memory-graph -c user.email=memory-graph@local \
    commit -qm "memory backup $(date +%F_%T)"
  [ -n "$REMOTE" ] && git push -q "$REMOTE" HEAD
  echo "backup committed: $(git log -1 --format=%h)"
else
  echo "no changes"
fi
