import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Server,
  Pencil,
  RotateCcw,
  Trash2,
  List,
  X,
  CircleAlert,
} from "lucide-react";
import type { Provider } from "../shared/chat";
import { api } from "./api";
import { IconButton, Loading, useDialogFocus } from "./controls";
import { KeyReveal } from "./settings-tools";
import { directModels, useDeviceConnection } from "./device-connection";

type ProviderView = Provider & { hasKey: boolean };
type Form = {
  id: string;
  name: string;
  baseUrl: string;
  prefix: string;
  apiKey: string;
};
const emptyForm = (): Form => ({
  id: "",
  name: "",
  baseUrl: "https://",
  prefix: "",
  apiKey: "",
});
export function ProvidersPanel({
  providers,
  refresh,
  run,
  onModels,
}: {
  providers: ProviderView[];
  refresh: () => Promise<void>;
  run: (fn: () => Promise<void>) => Promise<void>;
  onModels: (name: string) => void;
}) {
  const connection = useDeviceConnection(),
    dialog = useRef<HTMLElement>(null);
  const [form, setForm] = useState<Form | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const close = () => {
    if (busy === "editor") return;
    setForm(null);
    setError("");
  };
  useDialogFocus(dialog, close, !!form);
  const operate = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      setBusy(null);
    }
  };
  const save = async (value: Form, refreshModels: boolean) => {
    const existing = providers.find((p) => p.id === value.id);
    if (
      existing?.hasKey &&
      existing.baseUrl !== value.baseUrl.replace(/\/$/, "") &&
      !value.apiKey
    )
      throw Error("修改接口地址时请重新输入密钥，避免旧密钥被发送到其他地址。");
    let key = value.apiKey || undefined,
      models: { id: string }[] | undefined;
    if (connection.enabled && refreshModels) {
      key ??= existing
        ? await connection.key({
            providerId: existing.id,
            baseUrl: existing.baseUrl,
            hasKey: existing.hasKey,
          })
        : "";
      models = await directModels(value.baseUrl, key);
    }
    const saved = await api<ProviderView>("/providers", "POST", {
      ...value,
      id: value.id || undefined,
      apiKey: value.apiKey || undefined,
      refreshModels,
      models,
    });
    if (key !== undefined) connection.remember(saved.id, saved.baseUrl, key);
    await refresh();
    return saved;
  };
  const submit = (refreshModels: boolean) => {
    if (!form) return;
    void operate("editor", async () => {
      const saved = await save(form, refreshModels);
      setForm(null);
      setNotice(
        refreshModels
          ? `已保存 ${saved.name}，获取到 ${saved.models.length} 个模型。新发现的模型默认关闭。`
          : `已保存 ${saved.name}，模型列表保持不变。`,
      );
    });
  };
  const alert = error && (
    <div className="du-alert du-alert-error provider-error" role="alert">
      <CircleAlert size={17} />
      <span>{error}</span>
    </div>
  );
  return (
    <div className="providers-page">
      <div className="settings-page-heading">
        <div>
          <h3>服务商</h3>
          <p className="muted">管理 OpenAI 兼容接口及其模型。</p>
        </div>
        <button
          className="du-btn du-btn-primary du-btn-sm primary"
          onClick={() => {
            setError("");
            setForm(emptyForm());
          }}
        >
          <Plus size={16} />
          添加服务商
        </button>
      </div>
      {!form && alert}
      {notice && (
        <p className="provider-notice" role="status">
          {notice}
        </p>
      )}
      <div className="provider-list">
        {providers.map((p) => (
          <article className="provider-item du-card" key={p.id}>
            <div className="provider-identity">
              <span className="provider-symbol">
                <Server size={20} />
              </span>
              <div>
                <strong>{p.name}</strong>
                <small className="provider-url" title={p.baseUrl}>
                  {p.baseUrl}
                </small>
                <div className="provider-meta">
                  <span>{p.models.length} 个模型</span>
                  <span>{p.hasKey ? "已保存密钥" : "无需密钥"}</span>
                  {p.prefix && <span>前缀 {p.prefix}</span>}
                </div>
              </div>
            </div>
            <div className="provider-actions">
              <IconButton
                label={"管理 " + p.name + " 模型"}
                onClick={() => onModels(p.name)}
              >
                <List size={17} />
              </IconButton>
              {p.hasKey && <KeyReveal provider={p} run={run} />}
              <IconButton
                label={"编辑 " + p.name}
                disabled={busy !== null}
                onClick={() => {
                  setError("");
                  setForm({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    prefix: p.prefix,
                    apiKey: "",
                  });
                }}
              >
                <Pencil size={17} />
              </IconButton>
              <IconButton
                label={"刷新 " + p.name + " 模型"}
                disabled={busy !== null}
                onClick={() =>
                  void operate(p.id, async () => {
                    const saved = await save(
                      {
                        id: p.id,
                        name: p.name,
                        baseUrl: p.baseUrl,
                        prefix: p.prefix,
                        apiKey: "",
                      },
                      true,
                    );
                    setNotice(
                      `已刷新 ${p.name}，共 ${saved.models.length} 个模型。已有开关和模型设置保持不变。`,
                    );
                  })
                }
              >
                {busy === p.id ? <Loading small /> : <RotateCcw size={17} />}
              </IconButton>
              <IconButton
                label={"删除 " + p.name}
                className="danger-text"
                disabled={busy !== null}
                onClick={() => {
                  if (confirm(`删除服务商“${p.name}”？已有聊天记录会保留。`))
                    void operate(p.id, async () => {
                      await api("/providers/" + p.id, "DELETE", {});
                      await refresh();
                      setNotice("服务商已删除，历史聊天保留。");
                    });
                }}
              >
                <Trash2 size={17} />
              </IconButton>
            </div>
          </article>
        ))}
        {!providers.length && (
          <div className="provider-empty du-card">
            <Server size={28} />
            <strong>还没有服务商</strong>
            <p className="muted">
              添加接口地址后获取模型，再到模型页开启需要的模型。
            </p>
          </div>
        )}
      </div>
      <p className="muted provider-security-note">
        密钥加密保存；设备直连时经访问密码验证后临时解锁。修改名称或前缀可直接保存，不必连接上游。
      </p>
      {form &&
        createPortal(
          <div
            className="modal-backdrop provider-editor-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <section
              ref={dialog}
              className="modal provider-editor"
              role="dialog"
              aria-modal="true"
              aria-label={form.id ? "编辑服务商" : "添加服务商"}
            >
              <div className="modal-header">
                <h2>{form.id ? "编辑服务商" : "添加服务商"}</h2>
                <IconButton
                  label="关闭服务商表单"
                  disabled={busy === "editor"}
                  onClick={close}
                >
                  <X size={19} />
                </IconButton>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const button = (e.nativeEvent as SubmitEvent)
                    .submitter as HTMLButtonElement | null;
                  submit(button?.value === "refresh");
                }}
              >
                <div className="provider-form-body">
                  {alert}
                  <div className="provider-form-grid">
                    <label>
                      名称
                      <input
                        disabled={busy === "editor"}
                        className="du-input"
                        required
                        maxLength={100}
                        aria-label="名称"
                        value={form.name}
                        placeholder="例如 OpenRouter"
                        onChange={(e) =>
                          setForm({ ...form, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      显示前缀（可选）
                      <input
                        disabled={busy === "editor"}
                        className="du-input"
                        maxLength={100}
                        aria-label="显示前缀（可选）"
                        value={form.prefix}
                        placeholder="例如 OR/"
                        onChange={(e) =>
                          setForm({ ...form, prefix: e.target.value })
                        }
                      />
                      <small>仅用于区分同名模型，不改变请求中的模型 ID。</small>
                    </label>
                  </div>
                  <label>
                    接口地址（Base URL）
                    <input
                      disabled={busy === "editor"}
                      className="du-input"
                      type="url"
                      required
                      aria-label="接口地址（Base URL）"
                      value={form.baseUrl}
                      placeholder="https://example.com/v1"
                      onChange={(e) =>
                        setForm({ ...form, baseUrl: e.target.value })
                      }
                    />
                    <small>填写接口根地址，例如 https://example.com/v1。</small>
                  </label>
                  <label>
                    API Key
                    <input
                      disabled={busy === "editor"}
                      className="du-input"
                      type="password"
                      autoComplete="new-password"
                      aria-label="API Key"
                      value={form.apiKey}
                      placeholder={
                        form.id
                          ? "留空保留已保存的密钥"
                          : "接口无需密钥时可留空"
                      }
                      onChange={(e) =>
                        setForm({ ...form, apiKey: e.target.value })
                      }
                    />
                    <small>
                      已有密钥不会回填到表单；修改地址时需重新输入密钥。
                    </small>
                  </label>
                </div>
                <div className="provider-form-footer">
                  <button
                    type="button"
                    className="du-btn du-btn-ghost du-btn-sm"
                    disabled={busy === "editor"}
                    onClick={close}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    value="save"
                    className={
                      "du-btn du-btn-sm " +
                      (form.id ? "primary" : "du-btn-ghost")
                    }
                    disabled={busy === "editor"}
                  >
                    {busy === "editor" ? <Loading small /> : null}
                    {form.id ? "保存更改" : "仅保存"}
                  </button>
                  <button
                    type="submit"
                    value="refresh"
                    className={
                      "du-btn du-btn-sm " +
                      (form.id ? "du-btn-ghost" : "primary")
                    }
                    disabled={busy === "editor"}
                  >
                    {form.id ? "保存并刷新模型" : "保存并获取模型"}
                  </button>
                </div>
              </form>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
