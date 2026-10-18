# 运行时选型和参考版本

## 本轮选型

- HTTP Worker 负责认证、配置、消息树操作和启动任务；D1 存储持久历史，草稿在独立表/版本分块中最后写入覆盖，不重写整棵消息树。聊天正文按 UTF-16 安全边界分成较小行，避开 D1 2 MB 单行限制；乐观版本写入使用 SQL 触发器和事务批处理防止过期覆盖。
- 每次生成对应独立的 SQLite Durable Object `Progress`。它发起且消费唯一一次上游请求，约每 2 秒将新增文字写到本对象 SQLite，而不是逐 token 写 D1。读进度和停止可以在等待上游时进入同一对象；不在外部 I/O 期间使用 `blockConcurrencyWhile`。
- `Generation` Workflow 的一个步骤持续等待 DO RPC，独立于浏览器连接。模型调用不具有幂等保证，因此该步骤配置自动重试为 0，且 D1 在 fetch 前持久化 `attempted`。断线后的刷新只读取任务；运行时失败后由用户新建重试版本。
- 最终历史和 job 状态在同一 D1 批处理中保存；任务临时配置随后清空。临时 DO 进度在一天后清理。已开始请求使用启动时选定模型/参数，切换聊天模型只影响下次请求。
- 上游请求 HTTPS、禁止携带 Key 跟随重定向。普通接口不返回密钥或密文；AES-GCM 的加密密钥通过部署 Secret 提供。密码与恢复码均仅保存带盐不可逆校验。

使用免费的 Workers、D1、SQLite Durable Objects 和 Workflows；没有 R2、付费 Queues、付费 CPU 配置或套餐升级。免费额度是有限的；本地测试不会模拟所有配额。

## 官方依据与实测边界

已读取 Cloudflare 官方 skills 提交 `be9f5e1e940fcf8567ff723cc03b8a8448c4082f`：

- [workers-best-practices](https://github.com/cloudflare/skills/blob/be9f5e1e940fcf8567ff723cc03b8a8448c4082f/skills/workers-best-practices/SKILL.md) 及 configuration、runtime-patterns、platform-apis 引用。
- [durable-objects](https://github.com/cloudflare/skills/blob/be9f5e1e940fcf8567ff723cc03b8a8448c4082f/skills/durable-objects/SKILL.md) 及规则、测试引用。
- [wrangler](https://github.com/cloudflare/skills/blob/be9f5e1e940fcf8567ff723cc03b8a8448c4082f/skills/wrangler/SKILL.md) 和 [cf-cli](https://github.com/cloudflare/skills/blob/be9f5e1e940fcf8567ff723cc03b8a8448c4082f/skills/cf-cli/SKILL.md)。按照其当前指引，新项目使用 `cf` 和 typed `cloudflare.config.ts`，没有新增 Wrangler 配置；具体 API 通过已安装类型与 CLI help 验证。

2026-10-16 05:00 接续时重新读取上述四份 SKILL.md，内容与此前参考版本一致，继续使用已读取的直接相关引用。新增 `TitleGeneration` 独立标题 Workflow 和 DO RPC；标题材料与最终落库不占用答案生成步骤的查询批次。

官方限制和生命周期文档：

- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)：免费步骤 CPU 10ms，等待网络不算 CPU；步骤墙钟时间与 CPU 区分。
- [Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)：副作用放在步骤内；考虑重放和幂等性。
- [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) 与 [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)：免费 SQLite 后端；每请求默认 CPU 30 秒。
- [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)：待处理 RPC/网络/定时器影响驱逐；不能把运行时升级、重启等异常当作永不中断。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)：免费每次 Worker 调用查询数有限，单行 2 MB。本实现将流式检查点留在 DO。

开发时部分官方站点 `.md` URL 返回 403；已通过官方 `cloudflare/cloudflare-docs` 仓库的 `production` 分支读取相应原文，而非略过规则。`npm test` 直接使用 Miniflare/workerd 来验证 SQLite DO 与 Workflow 组合，也不把 Node mock 当作 Worker 集成结果。

本轮 31.5 秒后台 mock 测试证明本地组合在原始 HTTP 请求结束后能完成；它不证明真实免费账户的所有 CPU、请求、时长、存储额度或所有重启场景。当前单个上游请求设置 30 分钟超时，超时保留部分回答并显示失败。大上下文及长时间连续输出仍需真实免费环境验证。

## OpenWebUI 基线

2026-10-15 UTC 查询官方 latest release 为 **v0.12.2**，发布于 2026-10-14 21:07:29 UTC；tag 对应提交 `6a18585ff4c2e5f6805f682222cfbc46dc669ef8`。

读取该版本 `src/lib/utils/index.ts` 的 `convertMessagesToHistory`、`sanitizeHistory`、路线相关结构及 `backend/open_webui/utils/chat_fork.py`。本项目独立实现消息树与交换逻辑，未迁入其 Python 后端。2026-10-16 后续按用户指令引入其 Overview Svelte Flow UI 组件，版本、适配和许可见 `src/vendor/open-webui/PROVENANCE.md`。当前测试依据这些结构自行构造 fixture；真实 OpenWebUI 导出/再导入验收仍待完成。

## 设备直连（2026-10-16）

设备模式不启动生成 Workflow；Worker 只建立任务和无密钥请求描述，浏览器通过同源POST专用接口复用已登录会话解锁Key（校验当前提供商地址、响应no-store；不再重复输密码，Key仅存页面内存），随后直接通过 HTTPS/CORS 调用上游。每约 2 秒更新 DO 检查点，最终正文与任务状态仍原子保存至 D1。生成 90 秒无心跳在状态读取时转为中断，不重放上游请求。关闭页面不保证继续生成，原服务端模式继续承担该能力。标题也使用原子 claim 和 attempted 防止刷新重复调用。模型列表和连通性测试在直连开关开启时同样由浏览器发出。CSP 允许 HTTPS 连接，fetch 仍拒绝 HTTP、URL 凭证、重定向，并不携带站点 Cookie。


## 2026-10-18 DO 驻留优化

重新使用官方 Workers、Durable Objects（含 rules/testing）与 cf-cli skills，核对 [DO 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)：未清理的计时器会阻止休眠，并可能让对象闲置驻留至 15 分钟。已完成任务不能仅丢弃 AbortSignal.timeout 的引用来假定超时已取消。

原主回复/插件/摘要使用 AbortSignal.any + 30 分钟 AbortSignal.timeout；改为共用 generationDeadline：显式计时器驱动原取消控制器，成功/失败/停止的 finally 均 clearTimeout、移除监听器并中止遗留上游 I/O。标题同样清理 120 秒超时。保留任务运行中的超时、2 秒流式检查点、独立 Workflow/DO 后台执行及 attempted 防重放；不增加轮询、自动重试或模型请求。单测检查三条退出路径、超时边界和已取消控制器不残留计时器，workerd 集成继续验证 >30 秒后台保存和停止。

历史分析：北京时间 10 月 17 日 08:00 至 18 日 08:00，DO 总时长约 14,620.54 GB·s，CPU 仅约 7.80 秒；112 个对象集中驻留 900–910 秒。超过 15 分钟的对象占约 89.8% 时长，优先排查计时器而非请求量或数据库写入。统计是问题窗口实测；未来节省量仍需用发布后的同负载时长验证，不能把历史占比直接当作已实现节省率。


生产修复验证（2026-10-18，CF a79998a6-8cc9-45d4-9f6a-0ee9b2a885fb）：真实服务端完整流程调用 Gemini 3.1 Flash Lite 8 次，包含两个历史补齐、澄清、分析、主回复、并行追问/摘要、手动重生成。模型结果与确认、网页 5 张卡片/圆形色块/色板通过 27 项断言；测试聊天及会话清理，整体设置与提供商未变。Analytics 在本批窗口记录 10 个相关对象（含两个后置调度器），合计约 3.7157 GB·s；按已记录 job 名匹配的 7 个模型任务合计 3.1886 GB·s，activeTime 分别约 1.97–4.73 秒。没有此前 900 秒驻留模式。不能用这组短任务推断长生成的持续成本或全天总降幅；历史请求仍受平台重启及免费额度限制。

同日补充 D1 写入优化：重复 seen、未变化且验证通过的聊天配置 PATCH、重复相同前置插件状态不创建新的 document_versions/document_parts，不更新聊天排序时间。配置比较仅处理传入字段，避免为判等再次序列化整棵消息树；显式重命名即使文字相同仍更新 titleRevision，继续保护人工名称不被运行中自动标题覆盖。真正改文/换设置仍采用原完整不可变快照，这里没有引入新的消息存储架构。


最终生产生命周期补验：关闭浏览器 35 秒后真实任务仍在运行，44.32 秒后 4,761 字符和末尾标记完整保存，并自动生成已采用摘要。这验证了可清理超时仍允许服务端任务独立于页面存活；该证据来自真实上游，不是本地延迟 mock。首个快速模型样本不足 30 秒，没有计作此项通过。

## 全账号额度面板（2026-10-18）

设置“账号额度”和聊天侧栏底部共用同一份账号级数据，固定查询 Workers、SQLite DO、D1、Workflows；不按本站脚本、命名空间或数据库筛选。来源为 Cloudflare 官方 GraphQL Analytics，因为这些消费量跨多个资源，不能用单个数据库的 REST 元数据当作全账号账单。服务端固定查询，不接收客户端任意 GraphQL。

- 数据随已有 bootstrap/navigation 返回，没有新增自动轮询。Cache API 保存 5 分钟软缓存，不写 D1/DO；手动刷新最快每分钟一次，页面也拦截重复点击。失败保留上次成功值，首次失败显示未知，UTC 跨日使用新缓存键。
- 日用量与长期容量分开。CPU 显示累计时间，不与每次调用的 CPU 上限作比例。Workflows 调用共享 Workers 请求额度，单独展示启动次数，不凭未经验证的关系重复相加；step.do 参考额度为 3k/天。
- 存储是近 24 小时各 D1 数据库 / DO 命名空间的最大样本之和，明确标为峰值，可能高于当前存储；空样本不当成零。Workflows storageRate 不是总存储，状态存储无可靠账号总量时显示“暂无数据”。没有付费升级或购买功能。
- API 凭证仅使用 `CF_ANALYTICS_TOKEN`、`CF_ANALYTICS_ACCOUNT_ID` Worker secrets，登录后的数据不含账号 ID、Token、资源 ID 或原始 API 错误；不进入设置备份。推荐单账号 Account Analytics Read 令牌。开发初始化仅补 disabled 占位，未配置时仍可正常聊天。
- Workers fetch 使用 `redirect: manual` 并拒绝非 2xx，8 秒超时显式清理，响应限制 1 MiB；不把凭证随重定向发到其他主机。

参考：[Analytics Token 权限](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)、[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)、[DO 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[Workflows 价格](https://developers.cloudflare.com/workflows/reference/pricing/)。界面参考免费套餐上限，不宣称统计是实时计费明细；Analytics 延迟、采样和按数据集的可用性仍适用。

索引回归的构造数据证据（历史测试，非线上账单）：最新标题任务读取 2004→1 行，某聊天摘要任务读取 2003→8 行，无关联子任务文档删除的外键检查读取 8001→1 行。0006 首次建索引仍扫描现有数据并增加索引维护成本；生产已应用，后续环境先检查 migrations list。当前完整聊天仍以版本化快照保存，真实改文的长聊天写放大尚未改成增量存储。
