# 2026-10-18 维护审查与本地证据

## 基线与范围

触发时重新获取私有仓库 `ccawmiku/workers-chat`：默认分支 `main`，采用基线 `a3a602c1f7251b890204ebcc36839d486b354702`。当时无未合并 PR，近期已包含摘要、插件、主题和独立设置页。维护分支为 `codex/maintenance-2026-10-18`，不沿用旧实现分支或旧 UI；交付前再次 fetch 核实默认分支仍为同一 SHA，未合并 PR 仍为空。读取当前 AGENTS、SPEC、ACCEPTANCE、PROGRESS、CLOUD_HANDOFF 与插件上下文资料。

已阅读 Cloudflare 官方 skills 的 Workers、cf CLI、Durable Objects、Workflows 及相关运行时/测试指引；官方 skills main 参考提交 `86505e44f87d801aa1864a3c4109e9a8ae5c409f`。D1 依据 [返回元数据](https://developers.cloudflare.com/d1/worker-api/return-object/)、[索引](https://developers.cloudflare.com/d1/best-practices/use-indexes/) 和 [免费套餐限制](https://developers.cloudflare.com/d1/platform/limits/)。继续使用现有 cf 配置、SQLite DO 与免费能力。

用户在收尾时告知 Durable Objects 今日操作额度已耗尽；这是用户提供的线上状态，本任务没有调用生产接口核验或消耗其剩余额度。后续验证均使用本地 workerd/Miniflare、构造数据、mock 上游与浏览器，不部署、不迁移生产 D1、不发真实模型请求。

## 实际修改

- `Store.get` 在同一 SQL 快照读取当前文档头与不可变分块；由调用者提供的旧头仍只读取指定 revision，保留独立草稿、分组覆盖和缺块错误。减少通用文档读的往返，避免头/分块之间更新造成不必要的不一致。标题排队复用同次请求已读的聊天快照，实际执行仍重新读取并检查标题版本。
- `0006.sql` 新增标题历史复合索引、jobs 完整外键索引、文档 kind/chatId 表达式索引。原有“仅活动任务”索引不足以支持完整历史外键检查，删除不关联任何任务的文档也会扫描历史 jobs/title_jobs。保留全部历史、任务唯一约束和数据格式。
- 模型刷新及批量配置用 Map 查找已存配置，替代逐项 find；一万模型的倒序刷新验证开关、预算、参数和密钥均保留。统一原始模型 ID 上限为已有刷新接口的 1000 字符，修复刷新成功但选择、保存或备份恢复拒绝 501–1000 字符 ID 的矛盾。
- 主生成复用设备/插件已有的有界 completion 解码器，移除重复 SSE 实现；保留心跳、停止、部分输出保存、思考、分段用量、继续回答和“一次模型请求”语义。主流式输出新增已有共享解码器的正文加思考 8 MiB UTF-8 上限，超限保存已收部分并报错，避免无限增长。静默心跳仅复用一个待决 reader.read，不累积读操作。
- 前端摘要卡共用当前路线的一次前缀指纹计算和按消息分组的结果；手动补齐共用一次摘要索引，替代每条回答重复遍历祖先。删除未使用的整树深度计算及确认无用的导入/参数，不删除旧配置迁移和历史兼容逻辑。
- 主生成与标题 WebSocket 完成通知强制取得新聊天快照，避免复用较早的运行中 GET。原代码在 Chromium/WebKit 均复现只读到旧快照；修复后完成通知触发第二次聊天快照，并继续复用同一待决导航请求。保持后台隐藏不轮询、生成中 WebSocket 推送、断线不重复模型请求。
- 更新设备模式浏览器夹具，使其正确处理现有“后置摘要/追问仍运行”确认弹窗，而非删除产品保护。修正交接文档中把旧分支当作永久基线的指引。

## 量化证据（仅本地）

Miniflare D1：500 个聊天、2000 个已完成主任务、2000 个标题任务、2000 个摘要任务文档；同一数据库先测旧索引，再应用 0006，比较 `meta.rows_read`，并检查 EXPLAIN QUERY PLAN。

| 操作 | 旧索引读取行 | 新索引读取行 |
| --- | ---: | ---: |
| 某聊天最新标题任务 | 2004 | 1 |
| 某聊天摘要任务查询 | 2003 | 8 |
| 删除不关联子任务的摘要任务文档（含外键检查） | 8001 | 1 |

这不是线上账单估算。新索引会增加存储与写入维护成本，首次创建也会扫描现有数据；没有宣称总写入成本降低。生产收益取决于实际历史规模和访问分布。

- 通用当前文档读取：2 次 SQL → 1 次；普通聊天读取（含独立草稿）：3 → 2 次。已有 `readChat` 的头/活动任务原子查询路径继续固定 revision，不能将其误计为同步减少一条 SQL。
- 模型刷新匹配：最多一万项重复线性搜索（最坏约一亿次比较）→ 建表加逐项 Map 查询；API 回归实际构造一万模型，无真实 `/models` 请求。
- 1000 节点路线：批量指纹一次只读 1000 个 parentId；单条和批量指纹一致，编辑源版本会正确失效当前与后续摘要。未宣称对所有消息渲染/全树克隆实现线性复杂度。
- 浏览器生成中连续 30 秒无 HTTP 轮询；故意挂起旧聊天 GET 后发完成推送，最终共 2 个聊天 GET 和 1 个去重的导航 GET，正确移除停止按钮并显示最终正文。

## 验证

已通过 `npm run typecheck`、`npm run check:svelte`（0 errors / 0 warnings）、`npm test`（8 文件、101 项通过，121.24 秒）、`npx tsc --noEmit --noUnusedLocals --noUnusedParameters`、`npm run build`、`npm run deploy:dry`（明确在 dry-run 退出，没有上传部署）。`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 npm run test:browser`：41 项全部通过（Chromium 24 + WebKit 17，5.5 分钟），包含桌面与手机尺寸；环境缺少系统依赖安装权限，使用已准备的 WebKit 库并跳过宿主依赖预检查，真实启动 WebKit 测试，并非跳过浏览器用例。没有实体 iPhone 验证。

最终源码及构建产物共 206 个文件，与本地 6 个真实私密值做精确匹配扫描，0 命中；未输出这些值。`git diff --check` 通过。构建仍有前端主块超过 500 kB 的提示（607.62 kB，gzip 188.22 kB）；分支图已独立懒加载，本轮没有仅为消除提示而改动加载架构。

测试覆盖 multipart/旧 revision/独立草稿、缺块错误、D1 查询计划与行计数、长 SSE UTF-8 上限、静默心跳取消、真实本地 Worker 的流式/非流式/停止/后台保存/标题/备份/插件与摘要，以及桌面和手机 Chromium/WebKit。

## 尚存限制与后续建议

- 线上 DO 每日超额不会因为未部署的 PR 自动解除。本地测试可继续，真实免费配额、长时间生产生命周期和实际账单需要额度恢复后由维护者另行核验；没有自动重放未知结果的模型请求。
- 完整聊天仍以版本化快照保存，超长聊天、多分支和大批量恢复仍有 CPU/内存及 D1 写放大；彻底解决需要持久模型改动，超出本轮局部维护范围。没有改逐 token 写库、后台生命周期、并行规则或数据保留策略来换取表面额度收益。
- DO 保持现有约 2 秒增量检查点和 1 天清理 alarm。没有线上计费明细，无法把用户的“每日操作超额”精确归因到某个 DO 方法；不通过盲目降低检查点频率牺牲故障时保存能力。建议额度恢复后按 DO 请求、SQLite rows_read/rows_written、Workflows 重试分开看指标，再做单独优化。
- 用户提出的 TypeSafe Jev 已确认是 [typed decision model](https://docs.typesafe.ai/introduction)，使用独立 `/v1/systemone` 和 state/questions 协议，并非聊天 completions 的直接替代。[Cloudflare Jev 目录](https://developers.cloudflare.com/ai/models/typesafe/jev/) 列出按输入付费价格，尚无证据可将它视为本项目免费的模型能力。若以后接入，应作为显式可选的候选评分等功能，独立凭证/成本说明并防止 SDK 自动重试；本次没有安装 SDK、增加自动调用或调用真实 Jev。
- 已检查当前桌面/手机截图和 ChatGPT 官方界面指引，最新版本已有独立设置、可调侧栏、Markdown memo 与懒加载分支图。本轮保留现有 UI 和 React/Svelte 技术栈；按用户最后的“收尾”要求，不为用完时间引入换栈或未验证的新功能。有实质 UI 更新时应另开 PR，本轮没有混入 UI 重设计。
