# 生产部署记录

## 当前版本：2026-10-17 UA 对调候选 / JSON 人工确认 / 用量格式

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。应用提交 `d23f9b9`（功能提交 `ea218d0`）；CF Version：`ad15ddcd-f0c1-43a2-bc2b-6ff13c8107c9`。
- 追问与 user 重写替换为完整历史 UA 对调，不继承主聊天 system；各自可选 system 默认空白。开头 U0 固定保留，默认“好的”，可编辑且非空。取消候选插件的历史轮数、水位裁剪和超长 user 截断，超预算仅提示，不静默裁剪或换模型。
- 重写返回 `rewrites` 三候选，必须单选一个并对比确认后替换对应输入框，不自动发送。最新背景正文和唯一待改写的 user 指令明确标记；保留相近长度与原意，取消原句字符硬上限。Radio 使用实际编译的 daisyUI 组件，隔离通用表单样式，移动端确认按钮可见。部署前已开始的旧单 `prompt` 任务仍按原契约保存。
- 主聊天、模型连通性测试与所有插件的新建默认强度改为“跟随接口”，不发送 reasoning_effort；已有显式选择保留。候选插件新建默认温度 0.7，可独立调整。
- JSON 结构校验后停在等待确认阶段，支持通过、重新生成、跳过；刷新不自动继续。重新生成只重跑分析并保留已回答澄清，旧结果不能再通过；跳过不注入该 JSON；修复无效 JSON 后也必须确认。服务端、设备直连均采用同一确认逻辑。
- 主回答末尾、追问末尾、重写候选窗口、JSON 与澄清输出框均显示上游返回的缓存率百分比，没有则隐藏，不从 cached_tokens 推算。Token 用量统一为不足 1k 的整数、达到 1k 的一位小数 k；水位输入框仍标注 k Token。
- 74 项单元/Worker 集成测试、TypeScript/Svelte 检查与构建通过。8 项 Chromium/WebKit 桌面/手机插件与设置场景通过；最终 Radio 样式、圆形几何与同排文字另通过 2 项 Chromium 场景。兼容旧在途任务的最终 34 项共享逻辑测试通过。
- Gemini 3.1 Flash Lite 与 Gemini 3.8 Flash Low 各真实流式测试追问、普通重写、短句“继续”。发现初版会改写背景正文后收紧对象标记与保意要求，最终 6/6 结构通过，并人工核对重写针对原指令、短句保持简短。效果仍由上游模型决定，没有自动重试、补写或截断。
- 线上完整流程 20 项检查通过，共 9 次真实模型调用：桌面/手机真实三候选单选替换、UA 请求快照、默认无 system/强度参数、澄清→分析暂停、刷新保留、分析重新生成不重问、通过后主回复和追问、跳过。最终样式再用合成设备结果进行 7 项线上检查，0 次额外模型调用；确认 `18.9k / 500 / 19.4k / 85.8%`、圆形单选、无原生 fieldset 框及手机按钮可见。
- 所有本次合成聊天和测试登录已清理，全局设置与服务商配置前后完全一致。沿用原 D1、DO、Workflows、加密密钥和免费套餐，无迁移。发布前 dry run 与秘密扫描通过。[PLUGINS.md](PLUGINS.md) 已同步实际默认任务、输入排列、确认阶段与水位规则。

## 前一版本：叙事状态 JSON / 澄清编排 / 发送框布局

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。应用提交 `173805b`；CF Version：`c1bfac6d-e985-4bff-bb03-d6e9bc49280b`。
- user 重写改为插件图标右侧的独立 Lucide 图标，仅启用时出现；四个插件上下文组件移至输入框上方，数值统一一位小数 k，移除“预计”。历史 user 编辑框保留重写操作。
- 插件列表移除全部排序操作，旧绑定顺序也统一按提问澄清 → JSON 分析 → 主回复运行。JSON 分析接收同一流程中已经回答的完整问题与回答，默认 Tool Call；澄清设置可切换为直接附加到 user。追问与 user 重写独立触发。
- JSON 默认改为所有主要角色的第一人称内心、既有场景、已发生动作和认知边界四项，均支持 `none`，限制未来要求被写成历史事实。旧默认提示词与 Schema 成对升级，自定义配置保留。字数是生成目标，结构与非空字段严格校验；没有自动补写、截断或额外模型重试。
- 72 项单元/Worker 集成测试、TypeScript/Svelte 检查与生产构建通过；14 项桌面/手机 Chromium/WebKit 浏览器回归通过，包括插件流程、设置、控件和请求次数检查。发布前 dry run、秘密扫描通过。
- Gemini 3.1 Flash Lite 与 Gemini 3.8 Flash Low 各测试非叙事、资料不足、双角色知识差异三种真实请求，最终 6/6 通过结构校验：前两类四项 `none`，叙事类保留角色知情差异且未把未来地点加入当前场景。轻量模型部分记录略短于字数目标，未为凑字数作补写。
- 线上最终 25 项检查通过：两种注入模式各真实运行澄清及流式 JSON，共 4 次模型调用；验证问答完整传入、固定顺序、四项输出、导出隔离、桌面/手机图标与上下文位置、一位小数 k、无排序、无页面错误或整页横向溢出。调试模式在主回复前暂停；两个合成聊天及测试登录已清理，全局设置与服务商配置前后完全一致。
- 沿用原 D1、DO、Workflows、加密密钥和免费套餐，无迁移。[PLUGINS.md](PLUGINS.md) 已同步默认提示词、Schema、消息组成与标有水位线的 Mermaid 图，持续维护规则写入 AGENTS.md。

## 前一版本：插件界面 / user 重写 / 消息删除

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。应用提交 `3082fe2`；CF Version：`22664128-0c6f-4735-8fd9-22f1f5e12a9a`。
- 插件设置改为 daisyUI List，操作横排；上下文使用 Stats/Progress，消息选择器使用 Dropdown/Menu 和按角色分色的 Badge。配置表单采用 Fieldset/Collapse，提问与插件回答按 Markdown 渲染，水位统一 k Token。四个内置插件保留，不能删除。
- 缓存只显示上游提供的合法百分比，没有则隐藏；主回答与各插件统一，不显示缓存 Token 数。
- 重新生成 user 提示使用严格 JSON `prompt` 字段、长度及任务说明校验，历史只读引用且不继承主聊天 system；禁止默认提示词扩展要求。发送框底部与历史 user 编辑框均有独立按钮，生成中旋转加载；对比支持重新生成结果。确认仅替换对应文本，历史编辑仍需手动保存为新分支。
- user 与回答均可删除。逻辑参考 OpenWebUI：移除选中节点及直接子节点，后续节点接回原父节点；组件弹窗先说明影响范围。消息树与相应插件状态在同一 D1 batch 中提交，不恢复“删除全部后续”功能。
- 68 项单元/workerd、TypeScript/Svelte 检查及构建通过。完整浏览器回归 31 项通过；另 2 项旧断言仍要求缓存 Token 数，按新的百分比需求修正后通过，最终 6 项插件/控件场景再次通过，覆盖桌面、手机、Chromium 与 WebKit。插件设置另核对了浅暗色、紧凑操作和 k 单位保存。
- Gemini 3.1 Flash Lite、Gemini 3.8 Flash Low 各 5 种合成请求；收紧长度指令后最终 10/10 通过 JSON/长度校验，人工核对没有新增限制或续写正文。线上另用一次真实 Worker 模型调用验证历史 user 重写、JSON 提取及编辑框替换。
- 线上桌面/手机 15 项检查通过：缓存百分比、角色颜色、历史范围、内置保护、k 水位、删除衔接、关联插件记录清理、无页面错误。全局设置与服务商配置前后完全相同，合成聊天和测试会话已清理。
- 最终预构建 dry run 与发布成功；沿用原 D1、DO、Workflows、加密密钥和免费套餐，无迁移。插件原理、Mermaid 图与完整默认提示词见 [PLUGINS.md](PLUGINS.md)。

## 前一版本：设置整理 / 对话刻度 / 紧凑排版

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。应用提交 `88d5d36`；CF Version：`ef856226-6ae5-45cf-ae44-5b1173a9ef33`。
- 服务商改为紧凑列表与独立编辑弹窗，保存配置和刷新模型分离；模型页电脑两栏、手机一栏，上下文预算纳入“模型设置”。分组命名使用 daisyUI 弹窗，菜单补 Lucide 图标并缩短文字。
- 参数单行排列，普通滑条两侧等粗、滑块与横条等高；继续回答为 CirclePlay，favicon 为粉色 Sparkles。上游返回缓存率时显示，没有时隐藏；删除用量冗余文字。
- 左侧增加当前路线的问答刻度、预览与跳转，无书签。正文两端对齐，默认行高 1.6、段距 12px，组件和文字尺度收紧；旧默认行距迁移，保留其他自定义值。
- 41 项单元/workerd、TypeScript/Svelte 检查、完整 19 个 Chromium/WebKit 场景通过；最后行距调整后的 6 个桌面/手机场景再次通过。最终构建、部署 dry run 与秘密扫描通过。
- 真实 HTTPS 检查确认缓存条件显示、刻度跳转、排版、图标、参数、服务商表单、模型两栏/手机一栏和分组弹窗。0 页面错误、0 模型请求、0 服务商写入；整体设置与服务商配置前后完全一致，合成聊天和测试会话已清理。
- 沿用原 D1、DO、Workflows 和加密密钥，无数据迁移或初始化，免费套餐不变。
- 本地合成截图：[服务商](screenshots/providers-desktop.png)、[模型设置](screenshots/model-cards-desktop.png)、[紧凑参数](screenshots/compact-parameters-desktop.png)、[对话刻度](screenshots/conversation-timeline-desktop.png)。

## 前一版本：daisyUI / 提示词排序 / 归档文件夹 / Lucide

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。应用提交 `3598421`（功能提交 `e28b5f5`、`3fc6deb`）；CF Version：`5e9cbfa0-6068-410d-8dba-0866820712f8`。
- 提示词为“＋选择已保存模板”的排序列表，支持电脑/触屏拖动和上下箭头、按名称展开编辑本聊天副本及移除；删除替换/追加和空白卡片。归档是对话列表固定文件夹，不能改名删除，头像菜单移除误导入口。
- daisyUI 5.7.50 / Tailwind 4.3.3 实际编译 Range/Toggle/Input/Select/Textarea/Button/Card/Avatar/Menu/Tabs/Collapse/Alert/Loading/Table；保留 Codex/ChatGPT 布局及浅暗配色。du- 前缀、无 preflight，隔离 border 变量，概述几何不受影响。
- 强度按用户最后截图采用粗圆条、白色圆形滑块及内置圆点；跟随接口为左上独立连接按钮，启用时灰色，仍与显式 none 区分。快速连续切换顺序保存，切换聊天隔离状态。上下文轮数改名并说明；用量圈保留已验证的单 SVG。
- 主界面与概述控件图标统一 Lucide（lucide-react / @lucide/svelte），移除字形图标和旧布局/固定图标。AGENTS.md 已记入后续优先 daisyUI 与 Lucide 规则。依赖许可全文随网站分发于 `/licenses/ui-components.txt`。
- 38 项单元/workerd 测试、TypeScript/Svelte 检查、15 个 Chromium/WebKit 场景通过；最后隔离强度组件后桌面/手机强度场景再次通过，最终构建和保留原资源的 dry run 通过。
- 真实 HTTPS 合成聊天核对通过：提示词排序、归档/取消归档、强度快速切换、概述 Lucide 控件/跳转/卡片端口几何、旧回复全屏编辑、手机收栏及整体设置数据页；0 页面错误、0 模型请求。生产整体设置完全一致，合成聊天及测试会话已清理。
- 最终版本只比已核对的 `202b0a41-14ca-4db7-898e-6354444fa23f` 增加许可静态文件，应用 JS/CSS 哈希一致；已用真实浏览器确认首页与许可均为 200，内容/哈希匹配。
- 沿用原 D1、DO、Workflows、加密密钥和免费套餐，无数据迁移或初始化。本地开发服务器已停止。
- 本地合成截图：[提示词](screenshots/prompts-dark.png)、[手机提示词](screenshots/prompts-mobile.png)、[强度](screenshots/effort-desktop.png)、[手机菜单](screenshots/account-mobile.png)。

## 前一版本：右栏精简 / 概述定位 / 全屏回复编辑

- 生产地址：[在线AI](https://workers-chat.1907018245.workers.dev/)。
- 应用提交：`a4fd303`；CF Version：`d807a934-8a68-49ab-abcb-38c99b44c563`。保留原 D1、DO、Workflows 和加密 Secret，无资源迁移或套餐升级。
- 右栏移除重复管理、主列表移动、请求预览与停止片段开关；系统提示词置顶，滚动条细化。全局导入/导出移至“设置 → 聊天数据”，强度弹层移除闪电。取消本轮上下文移除/加入接口及行为，历史标记仅留作交换元数据。
- 图形采用既有 Open WebUI 源码；隔离 group 间距/按钮样式，修正端点几何；概述点击定位到对应消息，手机收起面板。分支切换、新分支和 Fork 跳到末尾；编辑旧回复保持所在路线及消息位置，可全屏，保存失败显示提示并保留文字。
- 检查：38 项单元/workerd；TypeScript/Svelte 检查；15 个 Chromium/WebKit 浏览器场景；生产构建与 dry run 均通过。
- 线上合成聊天核对：右栏、整体设置数据页、概述跳转、卡片/端口几何、全屏编辑并保存、手机定位后收面板全部通过，页面脚本错误 0，模型请求 0。生产设置在检查前后完全一致；测试聊天及测试会话已清理。
- 图像仅为本地合成数据：[手机编辑](screenshots/reply-editor-phone.png)、[桌面编辑](screenshots/reply-editor-desktop.png)、[概述](screenshots/overview-mobile.png)。

## 2026-10-16 早期界面更新（历史）

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
