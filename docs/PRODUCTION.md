# 生产部署记录

## 当前版本：2026-10-16 界面更新

- 地址仍为 <https://workers-chat.1907018245.workers.dev>。
- 应用代码提交：`5298ef0`。
- 当前 Cloudflare 版本：`969c25ba-da37-4393-8c8e-b8571927013b`。
- 32 项单元/workerd 集成测试、9 项 Chromium/WebKit 浏览器用例、类型检查、生产构建及 dry run 通过。
- 已在真实 HTTPS 站点验证桌面大设置页、手机全屏设置、头像菜单、上下文用量弹层、强度滑杆及免责声明移除，无页面脚本错误或手机整页横向溢出；旧消息/子树删除接口返回 404。
- 上线检查未提交模型生成请求，也没有替换生产服务商/模型/聊天设置或初始化生产数据库。沿用已有 D1、DO、Workflows 和加密密钥；没有套餐升级。测试登录已退出。
- 最终行为、构造数据截图和参考图见 [UI-UPDATE-2026-10-16.md](UI-UPDATE-2026-10-16.md)。

## 首次部署记录

2026-10-16（北京时间），用户明确授权后从本机部署。应用代码来自已合并 PR #1 的 `main`（`f9bb081`），本次仅将真实 D1 ID 写入部署配置，没有修改业务逻辑。

- 入口：<https://workers-chat.1907018245.workers.dev>
- Worker：`workers-chat`。
- 版本：`8208bb2f-9dbc-4905-8bcc-0786995a26fa`。
- D1：`workers-chat`，ID `b10d9d32-d892-4aad-80a1-17b6b208fa45`，APAC，已应用 `0001.sql`—`0003.sql`。
- SQLite Durable Object：`Progress`。
- Workflows：`workers-chat-generation`、`workers-chat-titles`。
- 使用锁文件中的 `cf@1.0.0-beta.17`，生产构建通过 dry run 后用 `cf deploy --prebuilt --mode production --secrets-file ...` 发布同一份产物。
- 没有执行套餐升级，没有新增付费订阅或付费 CPU 配置。沿用 Workers、D1、SQLite DO 和 Workflows；下面的检查不等于免费配额压力测试。

## 已完成验证

| 项目 | 结果 |
| --- | --- |
| 安装与本地检查 | `npm ci`、类型检查、30 项 Vitest/workerd 集成及单测、2 项 Python 离线测试、生产构建、部署 dry run 通过 |
| 页面和访问控制 | HTTPS 首页 200，未登录读取设置 401，登录成功；Cookie 带 Secure、HttpOnly、SameSite=Strict；首页含 CSP、HSTS、nosniff |
| 真实服务商 | Worker 经 HTTPS 成功读取 `https://gemini.yaemiko.lol/v1/models`，返回 36 个模型，服务商密钥由应用加密保存 |
| 初始模型 | 启用并设默认 `gemini-3.8-flash-low`；其他模型保持初次关闭，可在模型管理中自行启用；新聊天仍默认思考强度 `max` |
| 真实流式 | `low`，完成并持久化，返回 usage |
| 真实非流式 | `max`，完成并持久化，返回 usage；未删参数、未静默降低强度 |
| 关闭页面后台运行 | 从真实网页发送，收到 202 后立即关闭页面，35 秒后读取原聊天；生成耗时 30635ms，完成并保存 3330 字符；自动标题随后完成 |
| 浏览器 | Chromium 1440×1000 桌面与 390×844 手机尺寸，登录、默认模型加载、模型搜索正常；无页面脚本错误、整页横向溢出 |
| 测试数据清理 | 仅清理本次记录的 3 条测试聊天和测试会话，保留服务商、模型与默认设置 |

线上截图：[桌面](screenshots/production-desktop.png)、[手机](screenshots/production-mobile.png)。截图不含密钥、密码或用户真实聊天。

## 凭证与后续发布

正式密码随机生成，凭证仅存本机用户目录的 `.codex/secrets/`，没有进入仓库、构建产物或部署日志：

- `workers-chat-login.json`：访问地址、初始登录密码。
- `workers-chat-deployment-secrets.json`：密码校验、恢复码校验及 API Key 加密密钥；其中加密密钥须保留，以免已有服务商 Key 无法恢复。
- `workers-chat-deployment-secrets.json.recovery.txt`：初始离线恢复码。

Windows 文件 ACL 已确认只允许本机用户、Administrators 与 SYSTEM。后续修改密码后，以应用内最新密码和恢复码为准；部署凭证的初始校验不会覆盖已经初始化的 D1 账号。

再次部署使用现有 D1 ID，先检查待应用迁移，再构建、dry run 和发布。保留上述加密密钥，勿重新运行生成脚本轮换现有密钥。Cloudflare API 身份仍读取本机独立基础设施凭证，不进入项目。

## 验收边界

真实浏览器、模型及后台流程已通过上述检查，但不能据此声称全部规格完成。实际 OpenWebUI 导出/重新导入、大型数据和接近百万 Token 的免费配额、平台重启/中断及极端故障仍以 [PROGRESS.md](PROGRESS.md)、[REVIEW-2026-10-16.md](REVIEW-2026-10-16.md) 的未完成记录为准。现有本地集成测试未在生产运行，避免替换用户设置。

## 2026-10-16 UI / Svelte Flow / 设备直连发布

- 应用代码：`90cde58`（五项改动）、`6ea9941`（聊天初始载入前暂禁输入，避免草稿被恢复操作覆盖）。
- 最终 CF Version：`6b5d621a-79b4-4cf6-9fce-f6ae891cbcb5`；同一生产地址、D1、DO、Workflows 及既有加密 Secret。没有迁移或覆盖用户聊天，没有升级套餐。
- 本轮更新：单 SVG 互补圆弧修复使用量错位；Open WebUI v0.12.2 实际 Svelte Flow 源码的概述标签（设置关于保留来源/许可）；设备前端 HTTPS/CORS 直连；删除列表多选并改七项菜单/完整树复制；全局标题模板变量与 JSON title 提取。详见 [本轮变更](ACTIVE-IMPLEMENTATION.md)。
- `npm run check` 通过（38 项单元/workerd 测试、TypeScript/Svelte 检查、构建）；加载保护补丁后类型检查、构建和全部 11 项 Chromium/WebKit 浏览器回归再次通过。预构建部署 dry run 通过。
- 线上桌面/手机检查：头像菜单、宽大/全屏设置、用量弹层、思考滑块、圆环几何、无整页横向溢出、无页面脚本错误。
- 线上真实设备直连：使用既有默认服务商和模型、仅合成测试聊天显式选 low，浏览器原生 HTTPS 流式请求 **1 次**，完成并持久化；没有经过 Worker 请求上游，没有自动回退/重放。测试聊天手动命名，避免增加自动标题调用。
- 用户提供的完整标题提示词已写入生产整体设置的 `titlePrompt`，其余设置和模型选择保留。
- 测试会话、合成聊天及提前输入产生的独立草稿已清理。私有防重复记录保留在仓库外；首次探测只保存了草稿、并未发起模型任务，修正等待/输入保护后才进行上述一次真实请求。

设备直连默认关闭，在“头像 → 设置 → 连接 → 此设备直连”开启；要求上游支持浏览器 CORS，Key 再验证后只存页面内存。关闭页面会中断直连，需后台继续时使用原服务端模式。云端保存失败的文字保留在当前页面，可以单独重试保存；不会因此再次请求模型。
