# Changelog

## 1.1.0 (2026-11-03)

- 新增记忆图谱可视化：`viewer/index.html` 单文件零依赖面板（三类节点 / 力导向 /
  时间筛选 / 搜索 / 节点详情 / 缩放拖拽），双击即用
- 新增导出器 `engine/tools/export_graph.js`：单库或 `--all` 合并多 chat 库 →
  `graph-data.js` / `graph-data.json`，数据契约公开，任何语言都能喂
- `npm run graph` 快捷脚本

## 1.0.0 (2026-11-03)

首个公开版本。

- 零依赖记忆引擎：四阶段抽取（事实/概念/实体关系/事件关系）、向量+图混合检索、
  30 天半衰期衰减、事件去重合并、JSONL 追加存储（墓碑+压实）
- dsh-onebot-qq 集成安装器：锚点补丁（0.9.x 验证）、幂等、备份、卸载
- 桥接层：回合前召回注入、session 事件层完整回复捕获（生成处、message.id 去重、
  completed 才入库）、虚构场景回合隔离、停机冲刷
- 工具：check_embedding.js（维度/中文塌缩/区分度自检）、离线 provider、HTTP 侧车
- 124 项零依赖测试
