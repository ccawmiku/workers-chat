# 依赖和参考来源

本项目的界面和服务端代码独立编写。用户提供的六张截图保留在 `references/`，用于布局和行为参考。

生产依赖 React、React DOM、react-markdown、remark-gfm 按其 MIT 许可使用；Lucide 图标按其 ISC 许可使用。构建与测试依赖及其传递依赖的许可和版权声明随 npm 包保留在 `node_modules`，精确版本见 `package-lock.json`。本仓库未擅自为所有来源代码声明统一开源许可。

Cloudflare 官方技能、文档和运行时用于 API/生命周期/配置核对，版本记录见 [RUNTIME.md](RUNTIME.md)。OpenWebUI v0.12.2 的 Overview Svelte 组件已按用户后续要求复用于分支图，保留源码头、许可及设置内说明（见 `src/vendor/open-webui` 和 `public/licenses`）；未复制 Python 后端或 logo。OpenWebUI 自身使用带品牌条款的 Open WebUI License，本项目不将其代码重新标成 MIT/ISC，也不声称可直接在 Workers 运行其后端。

本轮加入 daisyUI 5.7.50、Tailwind CSS/@tailwindcss/vite 4.3.3，均按 MIT 许可使用；包内版权/许可随依赖保留。仅在构建时编译样式，无运行时 CDN。

图标后续统一：新增 @lucide/svelte 1.57.0（ISC），与 React 图标使用同一 Lucide 图标集；替换概述原布局/固定图标，保留 Open WebUI 来源和适配记录。

实际发布包的主要前端依赖许可同时随网站分发于 `/licenses/ui-components.txt`，保留包内原始版权/许可全文，不只依赖构建机的 node_modules。

颜色面板采用 react-colorful 5.8.1（MIT），使用其 HexColorPicker/HexColorInput，外层复用 daisyUI Dropdown/Card，保留键盘与触屏支持；许可全文附于公开 ui-components.txt。
