# 在线AI · Workers Chat (DeepSeek Harness 桌面插件版)

> 本分支 (`DeepSeekHarness`) 将 [ccawmiku/workers-chat](https://github.com/ccawmiku/workers-chat) 原生移植至 **DeepSeek Harness (DSH)** 桌面客户端插件生态中，实现 100% 相同的界面与全功能体验，并支持全离线 SQLite 存储与本地模型（Ollama 等）直连。

---

## 目录
- [功能特性](#功能特性)
- [迁移背景与平台差异](#迁移背景与平台差异)
- [移植架构与核心技术实现](#移植架构与核心技术实现)
  - [1. 存储层：Cloudflare D1 → Node.js SQLite](#1-存储层cloudflare-d1--nodejs-sqlite)
  - [2. 状态与广播：Durable Objects → 本地 WebSocket 事件总线](#2-状态与广播durable-objects--本地-websocket-事件总线)
  - [3. 异步生成流：Cloudflare Workflows → 本地异步执行器](#3-异步生成流cloudflare-workflows--本地异步执行器)
  - [4. 网络与安全层：支持本地私有模型](#4-网络与安全层支持本地私有模型)
  - [5. DSH 插件体系：Cordis 服务端与 Client Module 客户端注入](#5-dsh-插件体系cordis-服务端与-client-module-客户端注入)
- [移植文件结构映射表](#移植文件结构映射表)
- [构建与打包指南](#构建与打包指南)
- [在 DeepSeek Harness 中安装与启用](#在-deepseek-harness-中安装与启用)
- [后续同步上游更新与维护指南](#后续同步上游更新与维护指南)

---

## 功能特性

- 🌳 **消息分支树系统**：基于 Svelte Flow (`@xyflow/svelte`) 构建的多分支对话流，支持在任意历史节点分叉、多回复版本对比、回退与合并。
- 🧩 **五大内置智能插件**：
  - 🔍 **补充提问 (Clarification)**：自动侦测模糊需求并在生成前向用户提问。
  - 📝 **写前分析 (Pre-writing)**：回答前自动构思输出提纲与结构拆解。
  - 💡 **追问建议 (Follow-up)**：回答完成后自动推荐下一步探索问题。
  - ✏️ **重写提示 (User Rewrite)**：润色重构用户输入提示词。
  - 📏 **字数要求 (Word Count)**：精准限制模型输出字数区间。
  - 独立支持“仅调试前置插件”模式。
- 🤖 **多服务商与多模型管理**：支持 OpenAI、Anthropic、DeepSeek、SiliconFlow、OpenRouter 及本地端点（Ollama、LM Studio、vLLM、LocalAI 等）。
- 🔄 **宿主 DSH 模型一键无缝同步**：一键自动读取当前 DeepSeek Harness 宿主已配置的所有服务商（如 `llm-pi-ai` 等）与几十个已配模型，自动解密关联 API 密钥，无需手动输入即可直接对话。
- 🔒 **纯本地离线隐私**：所有会话历史、分支树版本均保存在本地 SQLite（WAL模式），敏感 API 密钥使用 PBKDF2/AES 加密存储在本地。
- ⚡ **WebSocket 实时流式响应**：极低延迟的本地流式输出与状态追踪。

---

## 迁移背景与平台差异

| 维度 | 原版 `workers-chat` (Cloudflare Workers) | DSH 插件版 (`DeepSeekHarness` 分支) |
| :--- | :--- | :--- |
| **运行时环境** | Cloudflare Workers (V8 Isolate / workerd) | Node.js 24 (DSH 桌面独立进程) + Electron |
| **数据库** | Cloudflare D1 (分布式 SQLite) | Node.js 原生内置 `node:sqlite` (`DatabaseSync`) |
| **状态协调与广播** | Cloudflare Durable Objects (`Progress`) | 本地内存 `EventEmitter` + `ws` 广播 |
| **异步工作流** | Cloudflare Workflows (`Generation`, `TitleGeneration`) | 本地异步任务调度引擎 (`WorkflowManager`) |
| **网络请求限制** | 禁止访问私网与本地 IP (`127.0.0.1`, `192.168.x.x`) | 放开本地与局域网 IP，全面支持本地大模型 |
| **挂载形式** | 独立网站 (如 `https://chat.yaemiko.lol`) | DSH 侧边栏按钮 + 工作区主面板无缝内嵌 |

---

## 移植架构与核心技术实现

为了最大程度保证原版业务逻辑与前端界面 100% 还原，并便于未来无缝拉取上游更新，本次移植采用了**无侵入的适配器/垫片模式（Shim / Adapter Pattern）**。业务代码无需重写，而是通过垫片使其在 Node.js 下透明运行。

### 1. 存储层：Cloudflare D1 → Node.js SQLite
- **核心文件**：[`src/server/sqlite-compat.ts`](src/server/sqlite-compat.ts)
- **机制**：
  - 使用 Node.js 22+ 原生内置的 `node:sqlite`（`DatabaseSync`），避免了对外部 C++ 原生编译扩展（如 `better-sqlite3`）的依赖。
  - 封装 `D1DatabaseCompat` 与 `D1StatementCompat`，完全模拟 D1 的 `prepare`、`bind`、`first`、`all`、`run`、`batch` 接口。
  - 解决 SQLite 参数绑定差异：将 JavaScript 的 `undefined` 安全映射为 SQL `NULL`。
  - 开启 SQLite WAL（Write-Ahead Logging）模式与 `PRAGMA foreign_keys = ON`。
  - 内置了自 `0001.sql` 至 `0006.sql` 的完整数据库迁移，首次启动自动在 `~/.dsh/storages/workers_chat/workers-chat.db` 中建表。

### 2. 状态与广播：Durable Objects → 本地 WebSocket 事件总线
- **核心文件**：[`src/server/progress.ts`](src/server/progress.ts)
- **机制**：
  - 原版依赖 Durable Object 的 WebSocket 连接池和状态暂存。
  - 移植层通过内存 EventEmitter 配合 `ws` 库实现 `ProgressDOCompat`，对接到 DSH 的 WebServer Upgrade 机制（`/api/workers-chat/jobs/events`），实现毫秒级本地流式推送。

### 3. 异步生成流：Cloudflare Workflows → 本地异步执行器
- **核心文件**：[`src/server/workflow.ts`](src/server/workflow.ts)
- **机制**：
  - 实现了本地 `WorkflowManager`，将 `GenerationWorkflow`（主回答生成）与 `TitleGenerationWorkflow`（标题提取）解耦为 Node.js 异步非阻塞任务。
  - 模拟 step 重试、步骤超时与进度保存，保证前端查询 job 状态时完全兼容。

### 4. 网络与安全层：支持本地私有模型
- **核心文件**：[`src/server/security.ts`](src/server/security.ts)
- **机制**：
  - 移除了针对 IPv4 私有网段（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`）的拦截规则，允许直连 `http://127.0.0.1:11434` (Ollama) 等本地或局域网服务。
  - 调整 CSP（Content-Security-Policy）头，允许在 DSH 的 `dsh-app://app/` 容器内安全嵌套 iframe，并放行外部 API 与本地 WebSocket。

### 5. DSH 插件体系：Cordis 服务端与 Client Module 客户端注入
- **服务端入口**：[`src/server/cordis.ts`](src/server/cordis.ts)
  - 声明 `inject = ["webServer"]`，监听并挂载：
    - 静态页面：`/workers-chat`（映射到 `dist/` 前端构建产物）
    - 后端接口：`/api/workers-chat`（无缝派发给后端 Hono 路由）
    - WebSocket 升级：`/api/workers-chat/jobs/events`
- **客户端入口**：[`src/client/dsh-client-entry.ts`](src/client/dsh-client-entry.ts)
  - 基于 DSH 的微前端模块规范打包为 IIFE。
  - 注册 `sidebar.panellist` 槽位：在 DSH 左侧全局面板区添加“Workers Chat”按钮与专属 SVG 图标。
  - 注册 `main` 槽位：点击后激活主工作区页面，内嵌 `/workers-chat`。

### 6. 宿主模型与凭据集成：从当前 DSH 一键导入模型
- **核心文件**：[`src/server/dsh-models.ts`](src/server/dsh-models.ts)、[`src/client/providers-panel.tsx`](src/client/providers-panel.tsx)
- **机制**：
  - DSH 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中配置了如 `llm-pi-ai` 等 LLM 服务商端点，在 `~/.dsh/.credentials.yaml` 中安全保存 API Key 引用。
  - 后端提供 `/api/dsh/providers` 与 `/api/dsh/import` 接口，自动读取 DSH 当前激活的全部服务商、模型列表与默认模型标记，并在导入时自动关联解密密钥。
  - 前端“服务商”页面提供**从当前 DSH 导入**快捷按钮与单项同步按钮，无需用户重复繁琐配置，开箱即用 DSH 现成的大模型资源。

---

## 移植文件结构映射表

```
.
├── cordis.patch.yml               # DSH Cordis 插件注册清单配置
├── icon.svg                       # DSH 侧边栏与插件列表图标
├── locale/
│   ├── en.json                    # 英文元数据与配置标签
│   └── zh.json                    # 中文元数据与配置标签
├── src/
│   ├── client/
│   │   ├── api.ts                 # [修改] API 路径前缀适配为 /api/workers-chat
│   │   ├── job-events.ts          # [修改] WebSocket 连接路径适配
│   │   ├── providers-panel.tsx    # [修改] 新增 DSH 宿主模型发现与一键导入 UI
│   │   ├── dsh-client-entry.ts    # [新增] DSH 客户端微前端模块入口（注册侧边栏与主工作区）
│   │   └── ...                    # 保持原版前端 Svelte/React 业务代码完全不变
│   ├── server/
│   │   ├── cordis.ts              # [新增] DSH 服务端 Cordis 插件生命周期入口
│   │   ├── dsh-adapter.ts         # [新增] 静态资源挂载、路由代理与 WebSocket 升级适配器
│   │   ├── dsh-models.ts          # [新增] 宿主 DSH 模型与密钥自动解析提取层
│   │   ├── env.ts                 # [新增] Node 运行时兼容的 Env 环境变量与类型定义
│   │   ├── sqlite-compat.ts       # [新增] 模拟 Cloudflare D1 接口的本地 SQLite 兼容层
│   │   ├── progress.ts            # [修改] 模拟 Durable Object 的内存 WebSocket 进度系统
│   │   ├── workflow.ts            # [修改] 模拟 Workflows 的本地异步任务调度系统
│   │   ├── security.ts            # [修改] 放开本地/局域网私有 IP 访问规则
│   │   ├── account-usage.ts       # [修改] 增加 Node 环境下 caches 全局对象的降级防御
│   │   ├── index.ts               # [修改] 增加 DSH 模型同步接口并优化 CSP 响应头
│   │   └── ...                    # 保持原版 Hono 路由与后端核心逻辑不变
├── vite.config.ts                 # [修改] 前端构建配置（base: "/workers-chat/", outDir: "dist"）
└── package.json                   # [修改] 增加 DSH 插件元数据与打包构建脚本
```

---

## 构建与打包指南

### 环境要求
- Node.js >= 20.x (建议 Node.js 22 或 24)
- npm / pnpm

### 一键构建全部产物
```sh
npm run build
```

该命令会依次执行三个构建步骤：
1. **构建前端界面** (`npm run build:web`)
   - 运行 Vite，将 Svelte 5 / React 19 前端编译至 `dist/`，产物路径基底自动对齐 `/workers-chat/`。
2. **构建服务端插件** (`npm run build:server`)
   - 运行 esbuild，将 `src/server/cordis.ts` 及其依赖打包为 Node ESM 模块 `dist-server/index.js`，外部化 `@deepseek-ai/*` 并注入 Node.js 全局变量垫片。
3. **构建客户端注入模块** (`npm run build:client`)
   - 运行 esbuild，将 `src/client/dsh-client-entry.ts` 打包为纯前端 IIFE 文件 `dist-client/client.js`。

---

## 在 DeepSeek Harness 中安装与启用

### 方式一：直接在 DSH 桌面 profile 中链接使用（推荐开发与自用）

1. **链接插件到 DSH profile**：
   在 Windows 上（以管理员身份打开 cmd 或 PowerShell）：
   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-workers-chat" "C:\你的代码路径\workers-chat"
   ```
   在 macOS / Linux 上：
   ```sh
   ln -s "/你的代码路径/workers-chat" "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-workers-chat"
   ```

2. **在 DSH profile 的 `package.json` 中声明依赖**：
   编辑 `~/.dsh/profiles/desktop/package.json`：
   ```json
   {
     "dependencies": {
       "dsh-plugin-workers-chat": "*"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-plugin-workers-chat"
         ]
       }
     }
   }
   ```

3. **在 `cordis.patch.yml` 中激活插件**：
   编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在相应位置添加：
   ```yaml
   - id: workers-chat
     name: dsh-plugin-workers-chat
   ```

4. **开启桌面浏览器访问权限**：
   确保 `~/.dsh/desktop-preferences.json` 中配置了允许浏览器访问：
   ```json
   {
     "browserAccess": true
   }
   ```

5. **体验插件**：
   打开 DeepSeek Harness 客户端，左侧导航栏将出现 **Workers Chat** 图标，点击即可进入对话界面。

---

## 后续同步上游更新与维护指南

当上游仓库 `main` 分支发布了新功能或优化时，按以下规范进行同步与更新：

1. **拉取上游主分支代码**：
   ```sh
   git fetch origin
   git merge origin/main
   ```

2. **解决冲突时的关注点**：
   - **`src/client/api.ts`**：确保 `API_PREFIX` 保持为 `"/api/workers-chat"`。
   - **`src/client/job-events.ts`**：确保 WebSocket 请求地址保持为 `"/api/workers-chat/jobs/events"`。
   - **`src/server/index.ts`**：确保 CSP 请求头中包含 `frame-ancestors 'self' dsh-app:` 与 `connect-src *`。
   - **`src/server/security.ts`**：确保对私网 IP 的宽松校验保持不变。
   - **数据库变更**：如果上游新增了迁移脚本（如 `0007.sql`），只需在 [`src/server/sqlite-compat.ts`](src/server/sqlite-compat.ts) 的 `EMBEDDED_MIGRATIONS` 数组尾部追加该 SQL 内容即可，系统会在启动时自动幂等执行。

3. **重新构建发布**：
   ```sh
   npm run build
   ```
   重新编译后的 `dist/`、`dist-server/` 和 `dist-client/` 会被 DSH 热重载检测到，立即生效。
