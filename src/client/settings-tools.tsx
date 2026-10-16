import React, { useRef, useState, useEffect } from "react";
import { Eye, X } from "lucide-react";
import type { Provider, Settings } from "../shared/chat";
import type { SettingsBackup } from "../shared/backup";
import { DEFAULT_TITLE_PROMPT } from "../shared/default-title-prompt";
import { api, download } from "./api";
import { IconButton, ParameterControl, useDialogFocus } from "./controls";
type Run = (fn: () => Promise<void>) => Promise<void>;
export function SettingsTools({
  tab,
  settings,
  providers,
  run,
  refresh,
}: {
  tab: string;
  settings: Settings;
  providers: Provider[];
  run: Run;
  refresh: () => Promise<void>;
}) {
  const [includeKeys, setIncludeKeys] = useState(false),
    [password, setPassword] = useState(""),
    [backup, setBackup] = useState<SettingsBackup | null>(null),
    [mode, setMode] = useState("merge"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setIncludeKeys(false);
    setPassword("");
    setBackup(null);
    setNotice("");
  }, [tab]);
  async function save(value: Settings) {
    await api("/settings", "PUT", value);
    await refresh();
  }
  if (tab === "generation")
    return (
      <>
        <h3>全局生成默认值</h3>
        <p className="muted">
          模型默认值优先于这里的设置，当前聊天的手动值优先于模型默认值。恢复“默认”后不发送该参数。
        </p>
        {(["temperature", "top_p", "top_k"] as const).map((key) => (
          <ParameterControl
            key={key}
            name={
              key === "temperature"
                ? "温度"
                : key === "top_p"
                  ? "Top P"
                  : "Top K"
            }
            value={settings.parameters[key]}
            max={key === "temperature" ? 2 : key === "top_p" ? 1 : 100000}
            step={key === "top_k" ? 1 : 0.05}
            onChange={(value) =>
              void run(async () => {
                const next = { ...settings.parameters };
                if (value === undefined) delete next[key];
                else next[key] = value;
                await save({ ...settings, parameters: next });
              })
            }
          />
        ))}
        <h3>聊天标题</h3>
        <label>
          标题生成模型
          <select
            aria-label="标题生成模型"
            value={
              settings.titleModel ? JSON.stringify(settings.titleModel) : ""
            }
            onChange={(e) =>
              void run(() =>
                save({
                  ...settings,
                  titleModel: e.target.value
                    ? JSON.parse(e.target.value)
                    : null,
                }),
              )
            }
          >
            <option value="">使用当前聊天模型</option>
            {providers.flatMap((p) =>
              p.models.map((m) => (
                <option
                  key={p.id + "/" + m.id}
                  value={JSON.stringify({ providerId: p.id, modelId: m.id })}
                >
                  {p.prefix + m.id} · {p.name}
                </option>
              )),
            )}
          </select>
        </label>
        <label>
          标题生成提示词
          <textarea
            aria-label="标题生成提示词"
            key={settings.titlePrompt}
            defaultValue={settings.titlePrompt}
            rows={5}
            onBlur={(e) => {
              if (e.target.value !== settings.titlePrompt)
                void run(() =>
                  save({ ...settings, titlePrompt: e.target.value }),
                );
            }}
          />
        </label>
        <p className="muted">
          {"{{MESSAGES:END:2}}"} 插入当前路线最后两条用户/助手消息；也支持
          START:N 和 END:N。只提取返回 JSON 的 title 字段。
        </p>
        <button
          onClick={() =>
            void run(() =>
              save({ ...settings, titlePrompt: DEFAULT_TITLE_PROMPT }),
            )
          }
        >
          恢复默认标题提示词
        </button>
        <p className="muted">
          首轮回答后自动生成。失败后最多尝试一次不同的默认聊天模型，手动改名不会被旧的后台任务覆盖。
        </p>
      </>
    );
  if (tab !== "backup") return null;
  return (
    <>
      <h3>应用设置备份</h3>
      <p className="muted">
        备份提供商、模型开关/预算、参数和提示词模板。聊天记录请使用聊天 JSON
        导出。
      </p>
      <label className="toggle">
        包含 API Key
        <input
          type="checkbox"
          checked={includeKeys}
          onChange={(e) => {
            setIncludeKeys(e.target.checked);
            setPassword("");
          }}
        />
      </label>
      {includeKeys && (
        <>
          <p className="danger-text">
            下载的是包含密钥的普通 JSON，请妥善保管。
          </p>
          <label>
            验证当前登录密码
            <input
              aria-label="备份验证密码"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      )}
      <button
        className="primary"
        disabled={busy || (includeKeys && !password)}
        onClick={() => {
          setBusy(true);
          void run(async () => {
            try {
              const data = await api<SettingsBackup>(
                "/settings/export",
                "POST",
                { includeKeys, ...(includeKeys ? { password } : {}) },
              );
              download(
                data.containsKeys
                  ? "在线AI-settings-with-keys.json"
                  : "在线AI-settings.json",
                JSON.stringify(data, null, 2),
              );
              setNotice("设置备份已下载。");
            } finally {
              setPassword("");
              setBusy(false);
            }
          });
        }}
      >
        导出设置备份
      </button>
      <hr />
      <h3>恢复应用设置</h3>
      <input
        ref={file}
        aria-label="设置备份文件"
        className="hidden"
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          const selected = e.target.files?.[0];
          if (selected)
            void run(async () => {
              const data = JSON.parse(await selected.text()) as SettingsBackup;
              if (
                data.format !== "workers-chat.settings" ||
                data.version !== 1 ||
                !Array.isArray(data.providers)
              )
                throw new Error(
                  "请选择在线AI设置备份；聊天 JSON 应从“导入聊天”恢复。",
                );
              setBackup(data);
              setMode("merge");
              setNotice("");
            });
          e.target.value = "";
        }}
      />
      <button onClick={() => file.current?.click()}>选择设置备份文件</button>
      {backup && (
        <div className="backup-preview">
          <p>
            {backup.providers.length} 个服务商，
            {Array.isArray(backup.settings?.templates)
              ? backup.settings.templates.length
              : 0}{" "}
            个提示词模板。
          </p>
          {backup.providers.some((p) => typeof p.apiKey === "string") && (
            <p className="danger-text">文件包含明文 API Key。</p>
          )}
          <label>
            恢复方式
            <select
              aria-label="设置恢复方式"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="merge">合并</option>
              <option value="replace">替换</option>
            </select>
          </label>
          <p className="muted">
            {mode === "merge"
              ? "合并服务商和模板，匹配项采用备份中的配置。"
              : "提供商和设置将替换为备份内容；聊天与登录凭证保留。"}{" "}
            不含密钥时，仅保留地址未变的已有密钥。
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void run(async () => {
                try {
                  const result = await api<{ warnings: string[] }>(
                    "/settings/import",
                    "POST",
                    { data: backup, mode },
                  );
                  await refresh();
                  setBackup(null);
                  setNotice("设置已恢复。" + result.warnings.join("；"));
                } finally {
                  setBusy(false);
                }
              });
            }}
          >
            确认恢复设置
          </button>
          <button onClick={() => setBackup(null)}>取消</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
export function KeyReveal({ provider, run }: { provider: Provider; run: Run }) {
  const [open, setOpen] = useState(false),
    [password, setPassword] = useState(""),
    [key, setKey] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    ref = useRef<HTMLElement>(null),
    revealVersion = useRef(0);
  const close = () => {
    revealVersion.current++;
    setOpen(false);
    setPassword("");
    setKey(null);
    setBusy(false);
  };
  useDialogFocus(ref, close, open);
  return (
    <>
      <IconButton
        label={"查看 " + provider.name + " 密钥"}
        onClick={() => setOpen(true)}
      >
        <Eye size={15} />
      </IconButton>
      {open && (
        <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}>
          <section
            ref={ref}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="验证后查看密钥"
          >
            <div className="modal-header">
              <h2>查看 {provider.name} 密钥</h2>
              <IconButton label="关闭密钥窗口" onClick={close}>
                <X size={18} />
              </IconButton>
            </div>
            {key === null ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setBusy(true);
                  const version = ++revealVersion.current;
                  void run(async () => {
                    try {
                      const result = await api<{ apiKey: string }>(
                        "/providers/" + provider.id + "/key",
                        "POST",
                        { password },
                      );
                      if (version === revealVersion.current)
                        setKey(result.apiKey);
                    } finally {
                      if (version === revealVersion.current) {
                        setPassword("");
                        setBusy(false);
                      }
                    }
                  });
                }}
              >
                <label>
                  当前登录密码
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    aria-label="密钥查看密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  验证并显示
                </button>
              </form>
            ) : (
              <>
                <code className="revealed-key">{key || "未设置密钥"}</code>
                <p className="muted">关闭后隐藏。</p>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
