# 本地开发、部署和恢复

已于 2026-10-16 从本机完成首次生产部署，地址、资源和线上验证见 [PRODUCTION.md](PRODUCTION.md)。完整规格剩余项仍见 [PROGRESS.md](PROGRESS.md)，上线不代表全部规格已验收。以下保留开发、首次部署和恢复流程；现有生产数据库不要重复创建或初始化。

## 开发

```sh
npm ci
npm run dev:init
npm run dev
```

本地地址 `http://localhost:5173`。随机本地登录密码位于 `~/.config/workers-chat/local-login.json`；`.dev.vars` 含本地散列和 AES 密钥，两者均不进入 Git。开发 D1 使用 `.cloudflare/state/v3`。`dev:init` 使用 `d1_migrations` 记录并原子应用所有未执行的本地迁移（目前 0001—0003）；后续生产迁移由 `cf d1 migrations apply` 管理，不使用开发初始化脚本。

浏览器测试需要 Chromium 和 WebKit，可运行 `npx playwright install --with-deps chromium webkit` 安装浏览器和系统依赖（Linux 安装系统依赖需要相应权限）。检测到 `/usr/bin/chromium` 时直接使用；仅跑 Chromium 可用 `npm run test:browser -- --project=chromium`。`npm run test:browser` 会启动或复用本地服务器，新增本地测试聊天，并用不含密钥的测试设置替换本地配置。请使用专用开发数据库，勿对生产运行浏览器测试。

## 准备正式凭证

```sh
npm run auth:prepare
```

交互输入至少 12 字符的访问密码，终端隐藏输入。默认生成：

- `~/.config/workers-chat/deployment-secrets.json`：`PASSWORD_HASH`、`RECOVERY_HASH`、`ENCRYPTION_KEY`。
- 同路径加 `.recovery.txt`：离线恢复码，必须单独保存。

文件均为 0600，脚本不打印值、不覆盖已有文件。`ENCRYPTION_KEY` 是服务商 Key 的恢复必需材料，不可随意轮换。生产不使用开发初始化脚本生成的随机登录信息。

## 本机部署流程

使用已经配置的专用 Cloudflare 账户/CLI 身份，保持 **Workers Free**，不升级套餐。首次先用 CLI 的 `--help` 和 `--dry-run` 核对实际版本。当前锁文件使用 `cf@1.0.0-beta.17` 与 Cloudflare Vite plugin 2.0 beta。

```sh
npx cf d1 create --name workers-chat --dry-run
npx cf d1 create --name workers-chat
```

记录创建响应中的真实 D1 ID，在 `cloudflare.config.ts` 的 `bindings.d1({ name: 'workers-chat', id: '<实际返回 ID>' })` 中配置。不要将本地模拟 ID 用于远端。使用该真实 ID 应用迁移：

```sh
npx cf d1 migrations apply <实际返回的数据库ID> --dir migrations
npm run check
npm run deploy:dry
```

正式发布时由本机执行下列命令，凭证文件路径使用本机实际路径：

```sh
npx cf deploy --secrets-file /absolute/path/to/deployment-secrets.json
```

`cf` 会按配置声明 D1 绑定、SQLite `Progress` 类、`Generation` 与 `TitleGeneration` Workflows。D1 在部署前已初始化。Secret 从受保护文件上传，不放入命令参数值、Git 或前端构建。启用 HTTPS 域名后登录，在设置中添加上游并开启模型。正式访问使用 HTTPS；本地 HTTP 仅允许 localhost。

部署后需要实测：真实 `/models` 与指定模型、默认 max 错误保留、流式与非流式、关闭页面超过 30 秒再返回、长回答、停止、运行时中断，以及免费账户 CPU/存储/请求配额。不能用本地截图代替这些线上证据。

## 恢复

- 忘记密码：在登录页使用离线恢复码设置新密码，所有会话注销，旧恢复码一次使用后失效。恢复成功立即提供新恢复码；登录后也可在“账号与设备”单独更新，立即离线保存。
- 换设备或泄露会话：在“账号与设备”撤销指定设备或全部设备。
- Key 无法解密：检查是否保留了原 `ENCRYPTION_KEY`。丢失它不能从密文恢复上游 Key，需重新配置服务商。
- 聊天备份：完整树 JSON 可独立导入为新聊天，Markdown 只有当前路线。应用设置在“设置 → 设置备份”单独导出/恢复，可合并或替换，默认不含 API Key；主动包含时再次验证密码并明确提示普通 JSON。不包含登录密码、恢复码和服务端 AES 密钥，需另行保管部署凭证。不含 Key 的恢复仅保留同 ID、相同地址的已有 Key。
- 数据库恢复：在免费 D1 的实际 Time Travel 保留窗口内按官方恢复流程处理；保留与数据库匹配的加密密钥。不要在已有生产数据库再次手动执行初始化建表 SQL。
