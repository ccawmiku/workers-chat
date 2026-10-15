# 在线AI · Workers Chat

面向 Cloudflare Workers 免费套餐的单用户、纯文字 AI 聊天网页，调用自己的 OpenAI 兼容 Chat Completions API。界面参考仓库中的 Codex 截图，聊天树交换格式参考 OpenWebUI v0.12.2。

已实现 React 聊天界面、Worker API、D1 历史/独立草稿、SQLite Durable Object 与 Workflow 后台生成，以及标题任务、设置备份恢复、分组管理和移动端消息操作。**这不是 1—131 项需求已全部完成的声明**；当前完成情况、验证证据和后续任务见 [实施进度](docs/PROGRESS.md) 与 [验收清单](docs/ACCEPTANCE.md)。本次不执行生产部署。

## 本地运行

需要 Node.js 22.18 以上、npm；浏览器测试可使用系统 Chromium。

```sh
npm ci
npm run dev:init
npm run dev
```

打开 `http://localhost:5173`。初始化脚本将本地专用随机密码存入 `~/.config/workers-chat/local-login.json`，权限为 0600；不会打印、提交或打包密码。`.dev.vars` 保存本地散列与加密密钥，受 Git 忽略。不要将本地测试凭证用于正式部署。

登录后在“设置 → 服务商”填入 HTTPS Base URL 和专用 API Key。保存时自动获取 `/models`；新模型默认关闭。开启需要的模型并设置默认聊天模型后即可发送。显示前缀不改变实际模型 ID；新聊天默认 `max`，上游不支持时显示错误并保留设置。

## 检查

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run deploy:dry
```

`npm test` 包含消息树/交换单测和实际 workerd + D1 + Workflows + Durable Objects 集成测试。其中一个用例持续超过 30 秒，故整体约需 35 秒。浏览器测试使用专用本地数据，会新增测试聊天、替换本地测试设置并生成 [截图](docs/screenshots/)。它覆盖 Chromium 桌面与手机视口，不等于真实 iOS Safari 验证。

可选真实上游检查：通过安全环境变量或交接文档所述私有文件配置 `UPSTREAM_BASE_URL`、`UPSTREAM_API_KEY`，运行 `python3 scripts/test-upstream.py`。脚本先从 `/models` 匹配准确 ID，再测试 low、max 与省略思考强度，不记录认证头和回答正文。每次 POST 前在私有 `~/.config/workers-chat/upstream-checks/` 持久化尝试记录；已完成和结果未知的请求不会在后续运行中重复提交。离线验证防重复逻辑可运行 `python3 -m unittest discover -s tests -p '*_test.py'`，不会连接真实上游。当前任务的真实模型列表请求返回 HTTP 403，尚未完成真实生成测试。

## 资料

- [有效规格](SPEC.md)、[工程指引](AGENTS.md)、[原始交接](docs/CLOUD_HANDOFF.md)。
- [部署与恢复](docs/DEPLOYMENT.md)、[运行时选型与参考版本](docs/RUNTIME.md)。
- [实施进度与下一步](docs/PROGRESS.md)、[许可与参考来源](docs/THIRD_PARTY.md)。
