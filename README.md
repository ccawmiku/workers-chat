# 在线AI · Workers Chat

面向 Cloudflare Workers 免费套餐的单用户、纯文字 AI 聊天网页。视觉参考 Codex，消息树与聊天 JSON 交换行为参考最新版稳定 OpenWebUI。

当前仓库是云端开发交接包，应用代码尚未开始实现。产品功能 1—131 项已确认；名称、实现起点和云端交付范围另见交接文件，不把尚未答复的推荐当成新的用户授权。

## 阅读顺序

1. [AGENTS.md](AGENTS.md)：工程约束、凭证与免费套餐边界。
2. [SPEC.md](SPEC.md)：当前有效需求，开发以此为准。
3. [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)：必须通过的行为验收。
4. [docs/CLOUD_HANDOFF.md](docs/CLOUD_HANDOFF.md)：可直接交给云端 Codex 的任务说明。
5. [docs/DECISIONS.md](docs/DECISIONS.md)：历轮原题和决策来源，原题里的未选项不是需求。
6. [references/](references/)：用户提供的 6 张 UI 参考图。

## 已确认的关键范围

- HTTPS 上游、单用户密码登录、设备会话、离线恢复码、云端历史和草稿。
- 多提供商、可选显示前缀、模型开关与搜索、模型上下文容量配置。
- 默认最高 `max` 思考强度；显式 `none` 与不发送参数的“跟随接口”分开。
- 完整消息树、用户编辑分支、重新生成、续写版本、可视化分支总览和 Fork。
- OpenWebUI 聊天 JSON 双向兼容；附件清除，文字和分支保留。
- 当前已开始的回答在网页关闭后继续处理并保存；必须在免费套餐下实测。
- 不做 RAG、附件输入、语音、生图、临时聊天、消息排队、代码高亮、数学公式解析、Responses API 和聊天内容搜索。

## 云端运行准备

上游 URL 和测试模型见 `.env.example`；真正的 API Key 通过云端环境的安全配置提供，不提交到仓库。原电脑的 `127.0.0.1` 和 Windows secrets 路径在云端不可用。

若使用的云端环境只在 setup 阶段提供 Secrets，可将 `scripts/cloud-setup.sh` 配置为 setup/maintenance 脚本；它只把专用测试凭证写到云端主目录的私有文件，供本任务测试使用，不打印值、不写进 Git。详见交接说明。

仅创建本私人仓库不等于已经配置了 Codex 环境、部署了应用或开通了任何 Cloudflare 付费功能。
