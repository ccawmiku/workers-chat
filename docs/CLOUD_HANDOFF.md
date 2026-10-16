# 云端 Codex 接手说明

## 后续实施进度

2026-10-16 已实施可运行应用，05:00 一次性任务已实际接续；标题任务、设置备份、分组及移动端管理交互已补上，最新测试证据与剩余限制在进度文档。请先读 [PROGRESS.md](PROGRESS.md)，从 `codex/implement-workers-chat` 分支继续；下方是实施前的原始交接范围，不能据此覆盖现有代码重新搭建。

## 初始交接状态

- 用户已经完成 1—131 项功能选择；`SPEC.md` 是有效规格，`docs/DECISIONS.md` 保存确认来源。
- 本仓库目前仅为交接材料和 setup 辅助脚本，尚无应用代码，不要声称已完成或部署。
- 已有本地其他 app 不属于本仓库基线。
- 最后 3 项已由用户确认：仓库 `workers-chat`、网页“在线AI”；按本次需求从头实现；云端交付开发、测试和 PR，之后由本机部署。没有未答交接偏好，不需再次征询这 3 项。

## 可以粘贴给云端的任务

> 请从头实现这个仓库约定的单用户 AI 聊天网页“在线AI”。先读取 AGENTS.md、SPEC.md、docs/ACCEPTANCE.md 和 references/ 下全部 UI 参考图。1—131 项功能与交接范围已经确认，不重新做大规模功能问答。按最新版稳定 OpenWebUI 的聊天树/导入导出行为设计，用 Codex 风格独立实现界面；手机消息菜单参考 ChatGPT iOS。必须只使用 Cloudflare 免费套餐可用能力。先做必要的运行时选型验证，再完成可运行应用、核心测试、桌面/手机浏览器验证和可审阅 PR。通过配置的专用 HTTPS 上游测试；缺少真实测试凭证时先完成 mock 和其余实现，明确记录实测缺口。用户确认本次云端交付代码、测试、PR 和部署说明，之后由本机部署，因此本次不直接部署、不更改现有基础设施。不要提交任何实际 API Key、密码、恢复码或 Cloudflare token。遇到普通工程选择自行决定；确有已确认要求冲突时提出具体证据，不悄悄删功能。

用户后续明确修改范围时更新上述任务，不将历史建议覆盖本次最终选择。

## 参考版本与许可

- 2026-10-16 通过 GitHub 官方 API 核实，OpenWebUI 最新稳定发布为 [v0.12.2](https://github.com/open-webui/open-webui/releases/tag/v0.12.2)，发布于 2026-10-14 21:07:29 UTC。这是交接参考基线；真正开工时再核实最新稳定版，记录最终使用版本及提交。
- 重点核实该版本的消息树、导入/导出、Fork、版本切换、标题任务设置；不是原样迁入 Python 后端。
- 外部代码复用按实际许可办理，保留必要声明；不擅自把全部派生代码改标成其他开源许可。
- Cloudflare skills 必须按 AGENTS.md 读取，缺失网络能力时使用可用网页工具或明确限制后查官方文档。

## 上游测试配置

- Base URL：`https://gemini.yaemiko.lol/v1`。
- 环境 Secret 名：`UPSTREAM_API_KEY`，真实值由用户在云端安全配置中填写，未放在 GitHub。
- 普通环境变量：`UPSTREAM_BASE_URL`；可选 `TEST_OPENAI_MODEL=Gemini3.8flash-low`。
- 原电脑的本地测试地址 `127.0.0.1:8045` 在云端不指向用户电脑，不作为云端默认上游。
- 从 `/models` 解析实际 ID，用户允许用其他可用模型做测试；这不等于在产品中加入手动添加模型或静默降级。
- 测试允许显式选择合适参数以验证成功路径，但仍必须验证产品默认 max 及“不支持时报错”的路径，不通过删掉用户要求掩盖不兼容。

## Codex 环境配置注意

按实际使用的云端产品界面配置，并核实当前文档；不能假定新建私人仓库就自动建立了环境或传递了 GitHub Secrets。

已核实的 [Codex cloud 环境文档](https://learn.chatgpt.com/docs/environments/cloud-environment) 说明：该执行路径的 Secrets 只在 setup 阶段可用，agent 阶段会移除；普通变量在任务阶段可用。因此不要只执行 `export UPSTREAM_API_KEY=...` 就假设它会跨阶段保留。

如果使用的环境符合这个规则：

1. 在环境安全配置中设置本任务专用 `UPSTREAM_API_KEY`，不要填 Cloudflare 全局令牌。
2. setup/maintenance 脚本执行 `bash scripts/cloud-setup.sh`。
3. 脚本将专用测试配置写入 `~/.config/workers-chat/upstream-test.json`，文件权限 0600，目录 0700；在仓库之外，不打印值。
4. agent 的真实上游测试读取该文件；程序部署凭证仍另外配置，不直接把测试文件打进前端或产物。
5. 该文件是任务专用明文运行材料，任务内代码可读；测试完成或回收环境时清理，避免进入共享镜像/缓存/附件。它不是不透明的外部密钥托管服务。

若实际云端环境支持运行时 Secret 注入或凭证代理，优先使用该产品提供的安全机制，不强制套用 setup 文件方案。

## 网络

参考 [Codex cloud internet access](https://learn.chatgpt.com/docs/cloud/internet-access)。使用受限网络时至少安排任务所需的官方资源、依赖源和上游域名访问：

- `github.com`、`api.github.com`、`raw.githubusercontent.com`。
- `developers.cloudflare.com`。
- `registry.npmjs.org` 以及实际选用依赖的必要下载域名。
- `gemini.yaemiko.lol`，真实 Chat Completions 测试需要允许 HTTPS POST，模型列表需要 GET。

不要为了上游测试无条件扩大到全部域名；遇到阻断记录具体域名/方法。环境网络设置未配置时，不能把网络阻断误报为模型不兼容。

## 免费后台生成是必须验证的技术点

普通 HTTP Worker 的 `waitUntil()` 不能承担网页关闭后任意长的推理任务。评估免费 SQLite Durable Objects / Workflows 等，核实 CPU、状态、存储和生命周期限制，避免逐 token 写库消耗额度。不要为了简单用付费套餐，也不要把一个 30 秒内 mock 用例当成已经证明长期后台生成。

如果确实发现免费套餐与某个已确认要求不可同时满足，提交最小复现、官方限制证据和尽量保留目标的替代方案，再请用户取舍；不要先删掉要求再报告“完成”。

## 预期交付

完整源代码、锁文件、迁移、启动/检查/构建命令、测试结果、桌面/手机截图、部署和恢复说明、已验证的运行时限制。创建 PR，并清楚区分本地模拟、真实上游调用、真实免费部署的验证状态。
