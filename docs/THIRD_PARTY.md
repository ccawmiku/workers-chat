# 依赖和参考来源

本项目的界面和服务端代码独立编写。用户提供的六张截图保留在 `references/`，用于布局和行为参考。

生产依赖 React、React DOM、react-markdown、remark-gfm 按其 MIT 许可使用；Lucide 图标按其 ISC 许可使用。构建与测试依赖及其传递依赖的许可和版权声明随 npm 包保留在 `node_modules`，精确版本见 `package-lock.json`。本仓库未擅自为所有来源代码声明统一开源许可。

Cloudflare 官方技能、文档和运行时用于 API/生命周期/配置核对，版本记录见 [RUNTIME.md](RUNTIME.md)。OpenWebUI v0.12.2 的源码仅用于确认消息树和聊天 JSON 形状；未复制其 Svelte 组件、Python 后端或 logo。OpenWebUI 自身使用带品牌条款的 Open WebUI License，本项目不将其代码重新标成 MIT/ISC，也不声称可直接在 Workers 运行其后端。
