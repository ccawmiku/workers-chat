# 在线AI · Workers Chat

运行于 Cloudflare 免费套餐的单用户、纯文字 AI 聊天网站，调用自己的 OpenAI 兼容 Chat Completions API。当前生产地址：[chat.yaemiko.lol](https://chat.yaemiko.lol/)。

支持消息树与分支、Markdown、流式与后台生成、服务商和模型管理、分组/归档、导入导出、设备直连、外观设置及全账号 Cloudflare 额度。插件包括提问澄清、写前分析、追问建议、重写提示，另有独立回复摘要。默认思考强度“跟随接口”，显式设置不支持的参数时直接显示错误。

## 本地运行

需要 Node.js 22.18 以上和 npm。

```sh
npm ci
npm run dev:init
npm run dev
```

打开 http://localhost:5173 。随机本地密码位于 `~/.config/workers-chat/local-login.json`；`.dev.vars`、运行数据和真实凭证不进入 Git。设置中保存服务商与手动获取模型是独立操作；新模型默认关闭，需要启用并选择默认模型。

## 验证

```sh
npm run check
npx playwright install chromium webkit
npm run test:browser
npm run deploy:dry
```

单元测试包含真实 workerd、D1、DO、Workflows 和超过 30 秒的后台用例。浏览器测试会替换专用本地数据库中的设置，生成的截图仅保留为本地测试产物。Chromium/WebKit 的手机视口不等同实体 iPhone 验证。

可选上游检查：按环境变量提供 `UPSTREAM_BASE_URL`、`UPSTREAM_API_KEY`，运行 `python scripts/test-upstream.py`。私有尝试记录避免重新发送已经完成或结果未知的请求。离线检查：`python -m unittest discover -s tests -p '*_test.py'`。

## 维护资料

- [规格](SPEC.md)、[工程约束](AGENTS.md)、[当前进度与边界](docs/PROGRESS.md)、[验收检查](docs/ACCEPTANCE.md)。
- [插件工作原理、流程图、默认提示词](docs/PLUGINS.md)、[各插件上下文组成](docs/PLUGIN_CONTEXT.md)。
- [部署与恢复](docs/DEPLOYMENT.md)、[生产验证](docs/PRODUCTION.md)、[运行时及额度依据](docs/RUNTIME.md)。
- [第三方许可](docs/THIRD_PARTY.md)、原始视觉参考 `references/`。

重复历史报告、旧交接问答和过时生成截图已清理，历史版本可在 Git 中查阅。当前状态以源码、上述维护文档和用户最新确认需求为准。
