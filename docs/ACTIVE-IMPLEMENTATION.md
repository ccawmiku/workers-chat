# 2026-10-16 本轮变更记录

本轮用户连续追加的五项要求均已实现。生产结果与版本见 [PRODUCTION.md](PRODUCTION.md)。

1. **设备直连**：整体设置“连接”提供按设备保存、默认关闭的开关。聊天、标题、模型刷新与连接测试由浏览器直接通过 HTTPS/CORS 请求上游；密钥经密码再验证，只留页面内存。约 50ms 显示流式更新、2 秒同步 DO 检查点；停止保留半截，保存失败保留页面文字并可只重试保存。跨域/网络失败明确显示，不回退或重复调用。关闭页面会中断，90 秒无心跳显示失败；原服务端模式继续支持后台运行。
2. **对话列表**：删除多选，三点菜单依次为导出 JSON、重命名、重新生成标题、置顶、复制、归档、删除。复制保留全部消息树与设置且重映射节点 ID；Fork 仍只复制祖先路线。
3. **标题模板**：全局使用用户提供的中文 emoji / 15 字 / JSON title 提示词；模板变量 `{{MESSAGES:END:2}}` 插入当前路线最后两条消息，支持 START:N / END:N，不发送思考。只提取 JSON 的 title 字段。移除右栏标题范围。
4. **Svelte Flow**：实际采用 Open WebUI v0.12.2 Overview 源码，接入右栏设置/概述标签；保留画布、平滑连线、卡片、缩放/平移、横竖布局和点击切路线。完整许可、来源及适配记录保留在 vendor 和公开 licenses，整体设置“关于”标注来源。React 主界面保留，仅图形组件使用 Svelte。
5. **用量圆环**：单 SVG 内首尾相接的圆弧，无叠加遮盖圆或伪元素；桌面、手机、80%/100%/125% 缩放对齐检查通过。

## 验证

- `npm run check`：TypeScript、Svelte 检查零错误/警告；38 项单元/workerd 用例通过；生产构建通过。
- `npm run test:browser`：11 项 Chromium/WebKit 浏览器用例通过，包含提前显示流式、解锁、停止、CORS 失败不重发、保存故障及单独重试保存、菜单完整复制、Svelte Flow 切路线、手机与圆环缩放。
- `cf deploy --dry-run --prebuilt --mode production`：通过，保留原 D1、DO 和 Workflows。
- Svelte checker 不能使用原 TypeScript 7 原生实现的编译器 API，开发工具固定为兼容的 TypeScript 6.0.2。
- 图形截图：[暗色](screenshots/overview-dark.png)、[手机](screenshots/overview-mobile.png)；仅为合成测试内容。

## 前一项已发布

重新生成按独立用户发送（用户问题与回复为一组切换），提交 `5ba8aaf`，版本 `4fd32064-1e44-4d84-8b64-67f9b9152795`。真实单次短生成已验证并清理测试聊天，私有防重复记录保持 complete，不再次提交同一测试。

## 本机维护

项目 `C:/Users/19070/Documents/codex工作目录/在线ai/workers-chat`；凭证在项目外 `.codex/secrets/`，不进入日志/仓库。CF helper `~/.codex/tools/workers_chat_ops.py` 读取已有范围令牌并脱敏；保留既有加密密钥/资源，免费套餐不升级。浏览器测试会替换本地模拟器设置，禁止对生产运行该测试套件。npm 临时代理参数只影响当前命令，不修改用户全局配置。
