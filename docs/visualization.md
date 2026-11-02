# 记忆图谱可视化

把引擎库渲染成可交互的知识图谱：三类节点（实体/事件/概念）、关系边、时间筛选、搜索与节点详情。单文件实现，零依赖，**双击就能看**。

## 用法

```bash
# 1. 导出（单库 / 合并全部 chat 子库）
node engine/tools/export_graph.js ~/.dsh/memory-graph-data/private_12345 ./viewer
node engine/tools/export_graph.js --all ~/.dsh/memory-graph-data ./viewer

# 2. 查看：双击 viewer/index.html
```

导出器会在输出目录写两个文件：

- `graph-data.js` —— `window.MEMORY_GRAPH_DATA = {...}`，`file://` 双击直接可用（优先）
- `graph-data.json` —— 同内容 JSON，供 http 服务或拖拽导入

`viewer/index.html` 的加载顺序：同目录 `graph-data.js` → 同目录 `graph-data.json` → 拖拽/选择文件。数据放哪个目录都行，拖进来即可。

## 数据契约

```js
window.MEMORY_GRAPH_DATA = {
  meta:  { source, slot, exportedAt, nodeCount, edgeCount },
  nodes: [{ id, nodeType: 'entity'|'event'|'concept', content,
            importance, createdAt(ms), eventTime, custom }],
  edges: [{ id, sourceId, targetId, relation, weight, createdAt }]
}
```

按这个契约生成 JSON 的任何程序（Python / Go / 其他宿主）都能喂这个页面。`--all` 合并多库时节点按 id 去重、悬空边剔除。

## 功能

- 三类节点异形渲染：实体=圆、事件=圆角矩形、概念=菱形；大小随连接度增长
- 时间范围：近 1 月 / 近 3 月 / 全部 / 按月下拉
- 类型勾选、`importance ≥ 0.7` 筛选、只看钉住的记忆（金色环）
- 搜索：高亮全部命中并跳转第一个
- NODE DETAIL：类型/重要度/时间/度数 + CONNECTIONS 列表（可点击跳转）
- 力导向布局（可拖节点、可重排）、滚轮缩放、平移、适应视图
- 边悬停高亮；hover 显示关系名

## 作为宿主提供可视化

桥接层运行在 dsh 进程内、无 HTTP 端口，因此可视化走"离线导出"而不是在线服务：想刷新就重跑一次导出（cron 每天一次即可）。需要在线面板的话，用 HTTP 侧车（`examples/sidecar/`）加这个页面同款契约自己包一层即可。
