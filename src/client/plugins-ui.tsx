import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Blocks,
  SlidersHorizontal,
  Plus,
  Copy,
  Trash2,
  X,
  Play,
  RotateCcw,
  Check,
  SkipForward,
  Square,
  FileSearch,
  Pencil,
  WandSparkles,
  MessageCircleQuestion,
  ChevronRight,
  ChevronDown,
  Info,
  Folder,
} from "lucide-react";
import type { Chat, Provider, Settings, Message } from "../shared/chat";
import { route, estimateTokens } from "../shared/chat";
import {
  type PluginDefinition,
  type PluginBinding,
  type PluginState,
  type PluginRun,
  type APIMessage,
  definitions,
  enabledPlugins,
  pluginDefaults,
  pluginName,
  preparePlugin,
  upgradeLegacyPlugin,
  normalizePluginOutput,
  extractRewritePrompt,
  isBuiltinPlugin,
  flowClarifications,
} from "../shared/plugins";
import {
  IconButton,
  ParameterControl,
  useDialogFocus,
  Loading,
} from "./controls";
import { MessageUsage } from "./chat-controls";
import { api } from "./api";
type Command = (
  action: string,
  body?: Record<string, unknown>,
) => Promise<void>;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const k = (n: number) => (n / 1000).toFixed(1) + "k";
function PluginUsage({ run }: { run: PluginRun }) {
  return (
    <div className="plugin-usage">
      <MessageUsage
        message={{
          id: run.id,
          parentId: null,
          role: "assistant",
          content: "",
          createdAt: run.createdAt,
          model: run.model ?? run.plugin.model ?? undefined,
          usage: run.usage,
          elapsedMs: run.elapsedMs,
        }}
      />
    </div>
  );
}
function PluginMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown plugin-markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
function Dialog({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, close, true);
  return createPortal(
    <div className="plugin-modal du-modal du-modal-open" role="presentation">
      <div
        className={"du-modal-box plugin-dialog " + (wide ? "wide" : "")}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <IconButton label="关闭插件窗口" onClick={close}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </div>
      <div className="du-modal-backdrop" onClick={close} />
    </div>,
    document.body,
  );
}
export function PluginEditor({
  value,
  providers,
  onSave,
  onClose,
  local = false,
  onReset,
}: {
  value: PluginDefinition;
  providers: Provider[];
  onSave: (p: PluginDefinition) => Promise<void>;
  onClose: () => void;
  local?: boolean;
  onReset?: () => Promise<void>;
}) {
  const [p, setP] = useState(() => structuredClone(value)),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const update = (patch: Partial<PluginDefinition>) =>
    setP((old) => ({ ...old, ...patch }));
  const number = (
    key:
      | "historyRounds"
      | "referenceCount"
      | "userHistoryCount"
      | "highWater"
      | "lowWater"
      | "suggestions",
    label: string,
    min = 0,
  ) => (
    <label>
      {label}
      <input
        className="du-input du-input-sm"
        aria-label={label}
        type="number"
        min={key === "highWater" || key === "lowWater" ? min / 1000 : min}
        value={
          key === "highWater" || key === "lowWater" ? p[key] / 1000 : p[key]
        }
        step={key === "highWater" || key === "lowWater" ? 0.001 : 1}
        onChange={(e) =>
          update({
            [key]:
              key === "highWater" || key === "lowWater"
                ? Math.round(Number(e.target.value) * 1000)
                : Number(e.target.value),
          })
        }
      />
    </label>
  );
  return (
    <Dialog
      title={(local ? "当前聊天 · " : "全局 · ") + p.name}
      close={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          void onSave(p)
            .then(onClose)
            .catch((e) => setError(e.message))
            .finally(() => setSaving(false));
        }}
      >
        <p className="muted">
          {local
            ? "只覆盖当前聊天。已经运行的结果保留当时配置。"
            : "新聊天默认关闭插件；在发送框左下角启用。"}
        </p>
        <fieldset className="du-fieldset plugin-editor-section">
          <legend className="du-fieldset-legend">基本设置</legend>
          <div className="plugin-fields">
            <label>
              名称
              <input
                className="du-input"
                aria-label="插件名称"
                value={p.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <label>
              卡片标题
              <input
                className="du-input"
                aria-label="插件卡片标题"
                value={p.cardTitle}
                onChange={(e) => update({ cardTitle: e.target.value })}
              />
            </label>
            <label>
              模型
              <select
                className="du-select"
                aria-label="插件模型"
                value={p.model ? JSON.stringify(p.model) : ""}
                onChange={(e) =>
                  update({
                    model: e.target.value ? JSON.parse(e.target.value) : null,
                  })
                }
              >
                <option value="">跟随主聊天模型</option>
                {providers.flatMap((provider) =>
                  provider.models.map((model) => (
                    <option
                      key={provider.id + model.id}
                      value={JSON.stringify({
                        providerId: provider.id,
                        modelId: model.id,
                      })}
                    >
                      {provider.prefix + model.id} · {provider.name}
                    </option>
                  )),
                )}
              </select>
            </label>
            <label>
              思考强度
              <select
                className="du-select"
                aria-label="插件思考强度"
                value={p.effort}
                onChange={(e) =>
                  update({
                    effort: e.target.value as PluginDefinition["effort"],
                  })
                }
              >
                {[
                  ["inherit", "跟随接口"],
                  ["none", "无"],
                  ["low", "低"],
                  ["medium", "中"],
                  ["high", "高"],
                  ["max", "最高"],
                ].map(([v, label]) => (
                  <option value={v} key={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset className="du-fieldset plugin-editor-section">
          <legend className="du-fieldset-legend">任务指令</legend>
          <label>
            任务提示词
            <textarea
              className="du-textarea"
              aria-label="插件任务提示词"
              rows={7}
              value={p.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
            />
          </label>
          <small>
            {
              "支持 {{USER_INPUT}} 和 {{COUNT}}。当前请求、示例与参考由上下文组装器分别追加。"
            }
          </small>
          {p.kind === "rewrite" && (
            <div className="du-alert" role="note">
              输出格式固定为 {`{"prompt":"新的 user 请求"}`}
              。只忠实改述原请求，不新增内容；原文长度校验按提取后的 prompt
              计算。
            </div>
          )}
        </fieldset>
        <fieldset className="du-fieldset plugin-editor-section">
          <legend className="du-fieldset-legend">上下文与输出</legend>
          {(p.kind === "analysis" || p.kind === "clarify") && (
            <>
              <div className="plugin-fields">
                <label>
                  历史范围
                  <select
                    className="du-select"
                    aria-label="插件历史范围"
                    value={p.contextMode}
                    onChange={(e) =>
                      update({
                        contextMode: e.target.value as "sync" | "rounds",
                      })
                    }
                  >
                    <option value="sync">完全同步主聊天上下文</option>
                    <option value="rounds">最近 N 轮完整问答</option>
                  </select>
                </label>
                {number("historyRounds", "历史问答轮数", 1)}
                <label>
                  注入方式
                  <select
                    className="du-select"
                    aria-label="插件注入方式"
                    value={p.injection}
                    onChange={(e) =>
                      update({ injection: e.target.value as "tool" | "user" })
                    }
                  >
                    <option value="tool">Tool Call 结果</option>
                    <option value="user">附加到当前 user</option>
                  </select>
                </label>
              </div>
              <label>
                注入模板
                <textarea
                  className="du-textarea"
                  aria-label="插件注入模板"
                  rows={3}
                  value={p.injectionTemplate}
                  onChange={(e) =>
                    update({ injectionTemplate: e.target.value })
                  }
                />
              </label>
              <small>
                {p.kind === "clarify" &&
                  "提问和回答用于后续 JSON 分析与主回复；默认 Tool Call，也可附加到 user。"}
                {
                  "支持 {{RESULT}}、{{PLUGIN_NAME}}、{{USER_INPUT}}。不改变保存的正文。"
                }
              </small>
              <label>
                固定示例（可选）
                <textarea
                  className="du-textarea"
                  aria-label="插件固定示例"
                  rows={4}
                  value={p.example}
                  onChange={(e) => update({ example: e.target.value })}
                />
              </label>
            </>
          )}
          {p.kind === "analysis" && (
            <>
              <label>
                JSON Schema
                <textarea
                  className="du-textarea code-input"
                  aria-label="插件 JSON Schema"
                  rows={8}
                  value={p.schema}
                  onChange={(e) => update({ schema: e.target.value })}
                />
              </label>
              {number("referenceCount", "保留完整参考配对数")}
            </>
          )}
          {(p.kind === "suggest" || p.kind === "rewrite") && (
            <div className="plugin-fields">
              {number("userHistoryCount", "历史 user 条数（0 为全部）")}
              {number("historyRounds", "最近完整问答对数", 1)}
              {p.kind === "suggest" && number("suggestions", "候选条数", 1)}
            </div>
          )}
          {p.kind !== "analysis" && (
            <div className="plugin-fields">
              {number("highWater", "高水位（k Token）", 1)}
              {number("lowWater", "裁后目标（k Token）")}
            </div>
          )}
        </fieldset>
        <details className="du-collapse du-collapse-arrow">
          <summary className="du-collapse-title">生成参数</summary>
          <div className="du-collapse-content">
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
                value={p.parameters[key]}
                max={key === "temperature" ? 2 : key === "top_p" ? 1 : 100000}
                step={key === "top_k" ? 1 : 0.05}
                onChange={(value) => {
                  const next = { ...p.parameters };
                  if (value === undefined) delete next[key];
                  else next[key] = value;
                  update({ parameters: next });
                }}
              />
            ))}
          </div>
        </details>
        {error && (
          <p className="du-alert du-alert-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          {local && onReset && (
            <button
              type="button"
              className="du-btn du-btn-ghost"
              onClick={() =>
                void onReset()
                  .then(onClose)
                  .catch((e) => setError(e.message))
              }
            >
              <RotateCcw size={15} />
              恢复全局
            </button>
          )}
          <button
            type="button"
            className="du-btn du-btn-ghost"
            onClick={onClose}
          >
            取消
          </button>
          <button className="du-btn du-btn-primary" disabled={saving}>
            {saving ? <Loading small /> : <Check size={15} />}保存
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function GlobalPlugins({
  settings,
  providers,
  save,
}: {
  settings: Settings;
  providers: Provider[];
  save: (s: Settings) => Promise<void>;
}) {
  const [editing, setEditing] = useState<PluginDefinition | null>(null),
    [error, setError] = useState("");
  const list = definitions(settings);
  const persist = async (next: PluginDefinition[]) => {
    try {
      await save({ ...settings, plugins: next });
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  return (
    <>
      <h3>插件默认配置</h3>
      <p className="muted">
        四种内置能力支持多个配置实例。聊天内开关和覆盖设置在发送框左下角；这里的修改不会覆盖已有结果。
      </p>
      <ul className="plugin-global-list du-list" aria-label="插件默认配置">
        {list.map((p) => (
          <li className="plugin-definition-row du-list-row" key={p.id}>
            <div className="du-list-col-grow plugin-definition-info">
              <strong>{p.name}</strong>
              <small>
                {pluginName(p.kind)} · {p.model?.modelId ?? "跟随主聊天"}
              </small>
            </div>
            <div className="plugin-definition-actions">
              <IconButton
                className="du-btn du-btn-ghost du-btn-square du-btn-sm"
                label={"编辑插件 " + p.name}
                onClick={() => setEditing(p)}
              >
                <SlidersHorizontal size={17} />
              </IconButton>
              <IconButton
                className="du-btn du-btn-ghost du-btn-square du-btn-sm"
                label={"复制插件 " + p.name}
                onClick={() =>
                  setEditing({
                    ...structuredClone(p),
                    id: crypto.randomUUID(),
                    name: p.name + " 副本",
                  })
                }
              >
                <Copy size={17} />
              </IconButton>
              {!isBuiltinPlugin(p) && (
                <IconButton
                  className="du-btn du-btn-ghost du-btn-square du-btn-sm"
                  label={"删除插件 " + p.name}
                  onClick={() =>
                    void persist(list.filter((item) => item.id !== p.id)).catch(
                      () => {},
                    )
                  }
                >
                  <Trash2 size={17} />
                </IconButton>
              )}
              {isBuiltinPlugin(p) && (
                <span className="du-badge du-badge-ghost du-badge-sm">
                  内置
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="plugin-add-types">
        {(["analysis", "clarify", "suggest", "rewrite"] as const).map(
          (kind) => (
            <button
              key={kind}
              className="du-btn du-btn-sm"
              onClick={() =>
                setEditing(pluginDefaults(kind, crypto.randomUUID()))
              }
            >
              <Plus size={15} />
              {pluginName(kind)}
            </button>
          ),
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {editing && (
        <PluginEditor
          value={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSave={(p) =>
            persist([...list.filter((item) => item.id !== p.id), p])
          }
        />
      )}
    </>
  );
}
function ContextDetails({
  chatId,
  plugin,
  prepared,
  close,
  run,
  usageRun,
  onCommand,
}: {
  chatId: string;
  plugin: PluginDefinition;
  prepared: ReturnType<typeof preparePlugin> | null;
  close: () => void;
  run?: PluginRun;
  usageRun?: PluginRun;
  onCommand: Command;
}) {
  const [snapshot, setSnapshot] = useState<APIMessage[] | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<number | null>(null);
  const m = run?.metrics ?? prepared?.metrics,
    messages = snapshot ?? prepared?.request.messages ?? [];
  return (
    <Dialog title={plugin.name + " · 上下文"} close={close} wide>
      {m && (
        <>
          <div className="plugin-metric-grid du-stats">
            <div className="du-stat">
              <div className="du-stat-title">总输入／模型容量</div>
              <div className="du-stat-value">
                {k(m.total)}／{k(m.capacity)}
              </div>
              <div className="du-stat-desc">上游用量单独展示</div>
              <progress
                className={
                  "du-progress " +
                  (m.total > m.capacity
                    ? "du-progress-error"
                    : "du-progress-primary")
                }
                max={m.capacity}
                value={Math.min(m.total, m.capacity)}
                aria-label="插件上下文用量"
              />
            </div>
            <div className="du-stat">
              <div className="du-stat-title">历史档案</div>
              <div className="du-stat-value">{k(m.archive)}</div>
              <div className="du-stat-desc">
                {m.highWater > 0
                  ? `${k(m.highWater)} 时裁到 ${k(m.lowWater)}`
                  : "· 按完整配对数保留"}
              </div>
              {m.highWater > 0 && (
                <progress
                  className="du-progress du-progress-info"
                  max={m.highWater}
                  value={m.archive}
                  aria-label="插件历史水位"
                />
              )}
            </div>
          </div>
          <p className="muted">
            档案原始 {k(m.originalArchive)} · 已移除 {m.trimmed} 组 · 已截短{" "}
            {m.shortened} 条 user。仅影响发送视图，原始记录保留。
          </p>
          <table className="du-table du-table-sm">
            <tbody>
              {m.sections.map((s, index) => (
                <tr key={index}>
                  <td>{s.name}</td>
                  <td title={s.tokens.toLocaleString() + " Token"}>
                    {k(s.tokens)} Token
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(run ?? usageRun) && <PluginUsage run={(run ?? usageRun)!} />}
      {run && (
        <button
          className="du-btn du-btn-sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void api<{ messages: APIMessage[] } | null>(
              "/chats/" + chatId + "/plugins",
              "POST",
              { action: "request", runId: run.id },
            )
              .then((data) => {
                setSnapshot(data?.messages ?? []);
                if (!data) setError("这条复制记录没有独立的请求快照。");
                setSelected(null);
              })
              .catch((e) => setError(e.message))
              .finally(() => setLoading(false));
          }}
        >
          {loading ? <Loading small /> : <FileSearch size={15} />}
          查看本次请求快照
        </button>
      )}
      <div className="plugin-messages">
        {m && m.total > m.capacity && (
          <p className="du-alert" role="alert">
            超出所选模型的上下文预算，仍可发送；插件不会自动换模型或额外裁剪。
          </p>
        )}
        {(plugin.kind === "analysis" || plugin.kind === "clarify") && (
          <button
            className="du-btn du-btn-sm"
            onClick={() =>
              void onCommand("clear-reference", { pluginId: plugin.id })
                .then(close)
                .catch((e) => setError(e.message))
            }
          >
            <RotateCcw size={14} />
            重置后续参考
          </button>
        )}
        <div>
          <span>消息列表</span>
          <ContextMessagePicker
            messages={messages}
            selected={selected}
            select={setSelected}
            disabled={loading || (!prepared && snapshot === null)}
          />
        </div>
        {selected !== null && messages[selected] && (
          <pre className="plugin-context-text">
            {messages[selected]!.content}
          </pre>
        )}
      </div>
      {error && (
        <p className="du-alert du-alert-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
function ContextMessagePicker({
  messages,
  selected,
  select,
  disabled,
}: {
  messages: APIMessage[];
  selected: number | null;
  select: (n: number) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        ref.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const badge = (role: APIMessage["role"]) => (
    <span className={"du-badge du-badge-sm plugin-role plugin-role-" + role}>
      {role}
    </span>
  );
  return (
    <details
      ref={ref}
      className="du-dropdown du-dropdown-top plugin-message-picker"
    >
      <summary
        className="du-btn plugin-message-choice"
        role="button"
        aria-label="选择插件上下文消息"
        aria-disabled={disabled}
        onClick={(e) => {
          if (disabled) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !disabled) {
            e.preventDefault();
            ref.current!.open = true;
            requestAnimationFrame(() =>
              ref.current
                ?.querySelector<HTMLButtonElement>("li button")
                ?.focus(),
            );
          }
        }}
      >
        <span>
          {disabled ? (
            "先加载本次请求快照"
          ) : selected !== null && messages[selected] ? (
            <>
              {selected + 1}. {badge(messages[selected]!.role)} ·{" "}
              {k(estimateTokens(messages[selected]!.content ?? ""))} Token
            </>
          ) : (
            `选择一条查看完整内容（共 ${messages.length} 条）`
          )}
        </span>
        <ChevronDown size={16} />
      </summary>
      <ul
        className="du-dropdown-content du-menu plugin-message-menu"
        aria-label="上下文消息类型"
        onKeyDown={(e) => {
          const items = Array.from(
              ref.current!.querySelectorAll<HTMLButtonElement>("li button"),
            ),
            index = items.indexOf(document.activeElement as HTMLButtonElement);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                    items.length;
            items[next]?.focus();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            ref.current!.open = false;
            ref.current?.querySelector<HTMLElement>("summary")?.focus();
          }
        }}
      >
        {messages.map((msg, i) => (
          <li key={i}>
            <button
              className={selected === i ? "du-menu-active" : ""}
              type="button"
              onClick={() => {
                select(i);
                ref.current!.open = false;
                ref.current?.querySelector<HTMLElement>("summary")?.focus();
              }}
            >
              <span>{i + 1}.</span>
              {badge(msg.role)}
              <span className="muted">
                {k(estimateTokens(msg.content ?? ""))} Token
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
export function PluginBar({
  entryTarget,
  chat,
  settings,
  providers,
  state,
  draft,
  debug,
  setDebug,
  configure,
  command,
  busy,
}: {
  entryTarget: HTMLElement | null;
  chat: Chat | null;
  settings: Settings;
  providers: Provider[];
  state: PluginState;
  draft: string;
  debug: boolean;
  setDebug: (v: boolean) => void;
  configure: (b: PluginBinding[]) => Promise<void>;
  command: Command;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<PluginDefinition | null>(null),
    [context, setContext] = useState<string | null>(null),
    [error, setError] = useState("");
  const [optimistic, setOptimistic] = useState<PluginBinding[] | null>(null);
  const entryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!entryRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        entryRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const selected = chat ? enabledPlugins(chat, settings) : [],
    list = definitions(settings),
    bindings = optimistic ?? chat?.plugins ?? [];
  const [previews, setPreviews] = useState<
    Map<string, ReturnType<typeof preparePlugin> | null>
  >(new Map());
  const previewInputs = useRef({ chat, settings, providers, state, draft });
  previewInputs.current = { chat, settings, providers, state, draft };
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimer.current) return;
    // Coalesce typing and streaming paints; previews never perform a request.
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      const { chat, settings, providers, state, draft } = previewInputs.current;
      const ids = new Set(chat ? route(chat).map((m) => m.id) : []);
      const flow = state.flows.findLast(
        (f) =>
          ids.has(f.userId) &&
          ["running", "waiting", "error", "debug"].includes(f.status),
      );
      const values = (chat ? enabledPlugins(chat, settings) : []).map((p) => {
        try {
          const active = state.runs.findLast(
            (r) =>
              r.plugin.id === p.id &&
              (r.anchorId === chat!.currentId ||
                (!!r.anchorId && ids.has(r.anchorId))) &&
              ["running", "waiting"].includes(r.status),
          );
          return [
            p.id,
            preparePlugin(
              chat!,
              p,
              settings,
              providers,
              state,
              active?.input ??
                ((p.kind === "analysis" || p.kind === "clarify") && flow
                  ? chat!.messages[flow.userId]!.content
                  : p.kind === "suggest"
                    ? ""
                    : draft),
              active
                ? (active.contextAnchorId ?? null)
                : (p.kind === "analysis" || p.kind === "clarify") && flow
                  ? chat!.messages[flow.userId]!.parentId
                  : chat!.currentId,
              p.kind === "analysis" && flow
                ? flowClarifications(state, flow)
                : [],
            ),
          ] as const;
        } catch {
          return [p.id, null] as const;
        }
      });
      setPreviews(new Map(values));
    }, 200);
  }, [chat, settings, providers, state, draft]);
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = null;
    },
    [],
  );
  const persist = async (next: PluginBinding[]) => {
    setOptimistic(next);
    try {
      await configure(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setOptimistic(null);
    }
  };
  const toggle = (id: string, enabled: boolean) =>
    persist(
      bindings.some((b) => b.id === id)
        ? bindings.map((b) => (b.id === id ? { ...b, enabled } : b))
        : [...bindings, { id, enabled }],
    );
  const activeRun = (id: string) =>
    state.runs.findLast(
      (r) =>
        r.plugin.id === id &&
        (r.anchorId === chat?.currentId ||
          (!!r.anchorId && route(chat!).some((m) => m.id === r.anchorId))) &&
        ["running", "waiting"].includes(r.status),
    );
  return (
    <>
      <div
        className={"plugin-bar" + (selected.length ? "" : " empty")}
        data-chat-id={chat?.id ?? ""}
        aria-label="插件栏"
      >
        <div className="plugin-chips">
          {selected.map((p) => {
            const run = activeRun(p.id),
              metrics = run?.metrics ?? previews.get(p.id)?.metrics;
            return (
              <button
                key={p.id}
                className={
                  "du-btn du-btn-ghost du-btn-sm plugin-chip " +
                  (metrics && metrics.total > metrics.capacity
                    ? "over-budget"
                    : "")
                }
                aria-label={p.name + "上下文"}
                onClick={() => setContext(p.id)}
              >
                <span>
                  <span className="plugin-chip-name">{p.name}</span>
                  <b>{metrics ? k(metrics.total) : "未选模型"}</b>
                </span>
                <progress
                  className={
                    "du-progress " +
                    (metrics && metrics.total > metrics.capacity
                      ? "du-progress-error"
                      : "du-progress-primary")
                  }
                  max={metrics?.capacity ?? 1}
                  value={Math.min(metrics?.total ?? 0, metrics?.capacity ?? 1)}
                />
                {metrics && (metrics.trimmed > 0 || metrics.shortened > 0) && (
                  <small>
                    {metrics.trimmed ? `裁 ${metrics.trimmed} 组 ` : ""}
                    {metrics.shortened ? `截 ${metrics.shortened} 条` : ""}
                  </small>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {entryTarget &&
        createPortal(
          <div className="plugin-entry" ref={entryRef}>
            <button
              className={
                "icon-button plugin-menu-button " + (open ? "active" : "")
              }
              aria-label="插件"
              title="插件"
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={() => setOpen(!open)}
            >
              <Blocks size={20} />
            </button>
            {open && (
              <div
                className="plugin-picker du-card"
                role="dialog"
                aria-label="当前聊天插件"
              >
                <div className="plugin-picker-heading">
                  <strong>当前聊天插件</strong>
                  <IconButton
                    label="关闭插件列表"
                    onClick={() => setOpen(false)}
                  >
                    <X size={15} />
                  </IconButton>
                </div>
                <p className="muted">
                  提问澄清 → JSON 分析 → 主回答。追问和 user 重写独立触发。
                </p>
                {list.map((p) => {
                  const binding = bindings.find((b) => b.id === p.id),
                    merged = upgradeLegacyPlugin({
                      ...p,
                      ...binding?.overrides,
                    });
                  return (
                    <div className="plugin-picker-row" key={p.id}>
                      <span>
                        {merged.name}
                        <small>{pluginName(p.kind)}</small>
                      </span>
                      {p.kind === "suggest" && binding?.enabled && (
                        <IconButton
                          label={"运行 " + p.name}
                          disabled={busy}
                          onClick={() => {
                            setOpen(false);
                            void command("suggest", {
                              pluginId: p.id,
                              content: draft,
                            }).catch((e) => setError(e.message));
                          }}
                        >
                          <Play size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        label={"配置 " + p.name}
                        onClick={() => {
                          setOpen(false);
                          setEditing(merged);
                        }}
                      >
                        <SlidersHorizontal size={15} />
                      </IconButton>
                      <input
                        className="du-toggle du-toggle-primary du-toggle-sm"
                        type="checkbox"
                        aria-label={"启用 " + p.name}
                        checked={binding?.enabled ?? false}
                        disabled={busy || optimistic !== null}
                        onChange={(e) =>
                          void toggle(p.id, e.target.checked).catch(() => {})
                        }
                      />
                    </div>
                  );
                })}
                <label className="toggle">
                  仅调试前置插件
                  <input
                    className="du-toggle du-toggle-info du-toggle-sm"
                    type="checkbox"
                    aria-label="仅调试插件"
                    checked={debug}
                    onChange={(e) => setDebug(e.target.checked)}
                  />
                </label>
                {error && <p role="alert">{error}</p>}
              </div>
            )}
          </div>,
          entryTarget,
        )}
      {editing && (
        <PluginEditor
          local
          value={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSave={(p) =>
            persist(
              bindings.some((b) => b.id === p.id)
                ? bindings.map((b) =>
                    b.id === p.id ? { ...b, overrides: p } : b,
                  )
                : [...bindings, { id: p.id, enabled: false, overrides: p }],
            )
          }
          onReset={() =>
            persist(
              bindings.map((b) =>
                b.id === editing.id ? { id: b.id, enabled: b.enabled } : b,
              ),
            )
          }
        />
      )}
      {context && selected.find((p) => p.id === context) && (
        <ContextDetails
          chatId={chat!.id}
          plugin={selected.find((p) => p.id === context)!}
          prepared={previews.get(context) ?? null}
          run={activeRun(context)}
          usageRun={state.runs.findLast(
            (r) =>
              r.plugin.id === context &&
              (r.anchorId === chat?.currentId ||
                (!!r.anchorId &&
                  route(chat!).some((m) => m.id === r.anchorId))),
          )}
          close={() => setContext(null)}
          onCommand={command}
        />
      )}
    </>
  );
}
function ResultCard({
  chatId,
  run,
  active,
  command,
  busy,
}: {
  chatId: string;
  run: PluginRun;
  active: boolean;
  command: Command;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [context, setContext] = useState(false);
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setError("");
    setSaving(true);
    try {
      await command(action, { runId: run.id, ...body });
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setSaving(false);
    }
  };
  const question = run.plugin.kind === "clarify",
    open =
      active &&
      ["running", "waiting", "error", "candidate"].includes(run.status);
  return (
    <details
      className={
        "plugin-result du-collapse du-collapse-arrow " +
        (question ? "plugin-question" : "")
      }
      open={open}
    >
      <summary className="du-collapse-title">
        <span>
          {question ? (
            <MessageCircleQuestion size={16} />
          ) : (
            <Blocks size={16} />
          )}{" "}
          {run.plugin.cardTitle || run.plugin.name}
        </span>
        <small>
          {run.status === "running" ? (
            <Loading small />
          ) : run.status === "waiting" ? (
            "等待回答"
          ) : run.status === "answered" ? (
            "已回答"
          ) : run.status === "candidate" ? (
            "新问题预览"
          ) : run.status === "error" ? (
            "失败"
          ) : run.status === "skipped" ? (
            "已跳过"
          ) : (
            "已完成"
          )}
        </small>
      </summary>
      <div className="plugin-result-body du-collapse-content">
        {question ? (
          <PluginMarkdown>{run.output || "正在生成…"}</PluginMarkdown>
        ) : (
          <pre className="plugin-output">{run.output || "正在生成…"}</pre>
        )}
        {run.answer !== undefined && (
          <div className="plugin-answer">
            <strong>你的回答</strong>
            <PluginMarkdown>{run.answer}</PluginMarkdown>
          </div>
        )}
        {run.error && (
          <p role="alert" className="danger-text">
            {run.error}
          </p>
        )}
        <PluginUsage run={run} />
        <div className="plugin-card-actions">
          <button className="du-btn du-btn-sm" onClick={() => setContext(true)}>
            <FileSearch size={14} />
            上下文
          </button>
          {run.status === "waiting" && active && (
            <>
              <button
                className="du-btn du-btn-sm"
                disabled={busy}
                onClick={() => void act("regenerate-question").catch(() => {})}
              >
                <RotateCcw size={14} />
                重新生成问题
              </button>
              <button
                className="du-btn du-btn-sm"
                disabled={busy}
                onClick={() => void act("skip").catch(() => {})}
              >
                <SkipForward size={14} />
                跳过并继续
              </button>
            </>
          )}
          {run.status === "candidate" && active && (
            <>
              <button
                className="du-btn du-btn-primary du-btn-sm"
                disabled={busy}
                onClick={() => void act("replace").catch(() => {})}
              >
                <Check size={14} />
                替换原问题
              </button>
              <button
                className="du-btn du-btn-sm"
                onClick={() => void act("dismiss").catch(() => {})}
              >
                取消
              </button>
            </>
          )}
          {run.status === "error" && active && (
            <>
              <button
                className="du-btn du-btn-sm"
                disabled={busy}
                onClick={() => void act("retry").catch(() => {})}
              >
                <RotateCcw size={14} />
                重试插件
              </button>
              <button
                className="du-btn du-btn-sm"
                disabled={busy}
                onClick={() =>
                  void act(run.replaces ? "dismiss" : "skip").catch(() => {})
                }
              >
                <SkipForward size={14} />
                {run.replaces ? "关闭候选" : "跳过插件"}
              </button>
            </>
          )}
          {run.plugin.kind === "analysis" && run.status !== "running" && (
            <button
              className="du-btn du-btn-sm"
              disabled={busy}
              onClick={() => {
                setValue(run.output);
                setError("");
                setEditing(true);
              }}
            >
              <Pencil size={14} />
              编辑 JSON
            </button>
          )}
          {run.status === "answered" && (
            <button
              className="du-btn du-btn-sm"
              disabled={busy}
              onClick={() => {
                setValue(run.answer ?? "");
                setEditing(true);
              }}
            >
              <Pencil size={14} />
              修改回答
            </button>
          )}
          {run.plugin.kind === "analysis" && run.status === "complete" && (
            <button
              className="du-btn du-btn-sm"
              disabled={busy}
              onClick={() => void act("regenerate-main").catch(() => {})}
            >
              <RotateCcw size={14} />
              用于重新生成正文
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
      {editing && (
        <Dialog
          title={question ? "修改澄清回答" : "编辑插件 JSON"}
          close={() => setEditing(false)}
          wide
        >
          <textarea
            className="du-textarea plugin-edit-text"
            aria-label="编辑插件结果"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {run.originalOutput && (
            <details>
              <summary>原始模型输出</summary>
              <pre>{run.originalOutput}</pre>
            </details>
          )}
          {error && <p role="alert">{error}</p>}
          <footer>
            <button className="du-btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              className="du-btn du-btn-primary"
              disabled={saving}
              onClick={() => {
                if (!question)
                  try {
                    normalizePluginOutput(run.plugin, value);
                  } catch (e) {
                    setError((e as Error).message);
                    return;
                  }
                void act(
                  question ? "regenerate-main" : "edit",
                  question ? { answer: value } : { content: value },
                )
                  .then(() => setEditing(false))
                  .catch(() => {});
              }}
            >
              {" "}
              {question ? "确认并重新生成" : "校验并保存"}
            </button>
          </footer>
        </Dialog>
      )}
      {context && (
        <ContextDetails
          chatId={chatId}
          plugin={run.plugin}
          run={run}
          prepared={null}
          close={() => setContext(false)}
          onCommand={command}
        />
      )}
    </details>
  );
}
export function PluginTurnCards({
  chatId,
  userId,
  state,
  activeUserId,
  command,
  busy,
}: {
  chatId: string;
  userId: string;
  state: PluginState;
  activeUserId?: string;
  command: Command;
  busy: boolean;
}) {
  const runs = state.runs.filter(
    (r) =>
      r.anchorId === userId &&
      !r.dismissed &&
      ["analysis", "clarify"].includes(r.plugin.kind) &&
      r.status !== "superseded",
  );
  return runs.length ? (
    <div className="plugin-turn-cards">
      {runs.map((run) => (
        <ResultCard
          chatId={chatId}
          key={run.id}
          run={run}
          active={userId === activeUserId}
          command={command}
          busy={busy}
        />
      ))}
    </div>
  ) : null;
}
export function Suggestions({
  state,
  messageId,
  onChoose,
  command,
  busy,
}: {
  state: PluginState;
  messageId: string;
  onChoose: (text: string) => void;
  command: Command;
  busy: boolean;
}) {
  const runs = [
    ...new Map(
      state.runs
        .filter(
          (r) =>
            r.plugin.kind === "suggest" &&
            r.anchorId === messageId &&
            !r.dismissed,
        )
        .map((r) => [r.plugin.id, r]),
    ).values(),
  ];
  return (
    <>
      {runs.map((run) => (
        <SuggestionSet
          key={run.id}
          run={run}
          onChoose={onChoose}
          command={command}
          busy={busy}
        />
      ))}
    </>
  );
}
function SuggestionSet({
  run,
  onChoose,
  command,
  busy,
}: {
  run: PluginRun;
  onChoose: (text: string) => void;
  command: Command;
  busy: boolean;
}) {
  let items: string[] = [];
  if (run.status === "complete")
    try {
      items = JSON.parse(run.output).suggestions;
    } catch {}
  return (
    <div className="plugin-suggestions" aria-label="追问建议">
      {run.status === "running" ? (
        <span>
          <Loading small />
          正在生成追问建议
        </span>
      ) : (
        items.map((text, index) => (
          <button
            key={index}
            className="du-btn du-btn-ghost"
            onClick={() => onChoose(text)}
          >
            <ChevronRight size={14} />
            <span>{text}</span>
          </button>
        ))
      )}
      <PluginUsage run={run} />
      {run.error && (
        <p className="du-alert du-alert-error" role="alert">
          {run.error}
        </p>
      )}
      {run.status !== "running" && (
        <button
          className="du-btn du-btn-ghost du-btn-xs"
          disabled={busy}
          onClick={() =>
            void command("suggest", { pluginId: run.plugin.id }).catch(() => {})
          }
        >
          <RotateCcw size={13} />
          换一组
        </button>
      )}
    </div>
  );
}
export function RewriteReview({
  run,
  current,
  apply,
  command,
  busy,
  regenerating,
  failure,
}: {
  run: PluginRun;
  current: string;
  apply: (value: string) => void;
  command: Command;
  busy: boolean;
  regenerating: boolean;
  failure?: string;
}) {
  const [candidate, setCandidate] = useState(() => {
      try {
        return extractRewritePrompt(run.output);
      } catch {
        return run.output;
      }
    }),
    [error, setError] = useState(""),
    [starting, setStarting] = useState(false);
  return (
    <Dialog
      title="重新生成 user 提示 · 对比"
      close={() => void command("dismiss", { runId: run.id }).catch(() => {})}
      wide
    >
      <PluginUsage run={run} />
      {failure && (
        <div className="du-alert du-alert-error" role="alert">
          {failure}
        </div>
      )}
      <div className="rewrite-compare">
        <label>
          原内容
          <textarea
            className="du-textarea"
            aria-label="原用户请求"
            value={current}
            readOnly
          />
        </label>
        <label>
          新内容
          <textarea
            className="du-textarea"
            aria-label="新用户请求"
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          />
        </label>
      </div>
      {run.input !== current && (
        <p className="muted">
          生成期间原内容发生了变化，请对比当前内容后再替换。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          className="du-btn du-btn-ghost"
          disabled={busy || starting || regenerating || !current.trim()}
          aria-label="重新生成结果"
          onClick={() => {
            setStarting(true);
            setError("");
            void command("rewrite", {
              pluginId: run.plugin.id,
              content: current,
              ...(run.rewriteMessageId
                ? { messageId: run.rewriteMessageId }
                : {}),
            })
              .catch((e) => setError(e.message))
              .finally(() => setStarting(false));
          }}
        >
          {starting || regenerating ? (
            <Loading small />
          ) : (
            <RotateCcw size={15} />
          )}
          重新生成结果
        </button>
        <button
          className="du-btn"
          disabled={busy || starting || regenerating}
          onClick={() =>
            void command("dismiss", { runId: run.id }).catch((e) =>
              setError(e.message),
            )
          }
        >
          取消
        </button>
        <button
          className="du-btn du-btn-primary"
          disabled={!candidate.trim() || busy || starting || regenerating}
          onClick={() =>
            void command("dismiss", { runId: run.id })
              .then(() => apply(candidate))
              .catch((e) => setError(e.message))
          }
        >
          <Check size={15} />
          确认替换
        </button>
      </footer>
    </Dialog>
  );
}
export function MessageDeleteDialog({
  message,
  childCount,
  close,
  remove,
}: {
  message: Message;
  childCount: number;
  close: () => void;
  remove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title="删除消息"
      close={() => {
        if (!busy) close();
      }}
    >
      <p>
        删除这条{message.role === "user" ? " user 消息" : "回答"}
        {childCount ? `及其直接下一层的 ${childCount} 条消息` : ""}
        ？更后面的内容会接回前一个节点。
      </p>
      <p className="muted">删除后无法恢复。</p>
      {error && (
        <div className="du-alert du-alert-error" role="alert">
          {error}
        </div>
      )}
      <footer>
        <button className="du-btn" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="du-btn du-btn-error"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void remove()
              .then(close)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loading small /> : <Trash2 size={16} />}删除
        </button>
      </footer>
    </Dialog>
  );
}
export function DraftReplacement({
  current,
  candidate,
  close,
  apply,
}: {
  current: string;
  candidate: string;
  close: () => void;
  apply: () => void;
}) {
  return (
    <Dialog title="替换当前草稿" close={close} wide>
      <div className="rewrite-compare">
        <label>
          当前草稿
          <textarea className="du-textarea" value={current} readOnly />
        </label>
        <label>
          追问建议
          <textarea className="du-textarea" value={candidate} readOnly />
        </label>
      </div>
      <footer>
        <button className="du-btn" onClick={close}>
          取消
        </button>
        <button className="du-btn du-btn-primary" onClick={apply}>
          <Check size={15} />
          确认替换
        </button>
      </footer>
    </Dialog>
  );
}
export function GroupPicker({
  groups,
  close,
  choose,
}: {
  groups: { id: string; name: string }[];
  close: () => void;
  choose: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title="移进分组"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="group-picker">
        {groups.length ? (
          groups.map((group) => (
            <button
              key={group.id}
              className="du-btn du-btn-ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void choose(group.id)
                  .then(close)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <Folder size={17} />
              {group.name}
            </button>
          ))
        ) : (
          <p className="muted">还没有分组，请先在侧边栏新建。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="du-btn" disabled={busy} onClick={close}>
          取消
        </button>
      </div>
    </Dialog>
  );
}
