import { historicalCacheReading } from "./cache-usage";
import { UsageRing, PluginChipContents } from "./usage-bar";
import { ActionIcons as I } from "./action-icons";
import { FallbackButton } from "./fallback-ui";
import { api } from "./api";
import { useEffect, useState, useMemo } from "react";
import type { PluginRequest } from "../shared/plugins";
import {
  BookOpenText,
  RotateCcw,
  Check,
  X,
  SlidersHorizontal,
  AlertCircle,
} from "lucide-react";
import {
  type Chat,
  type Settings,
  type Provider,
  formatTokenCount,
  route,
  estimateTokens,
  cacheHitRate,
} from "../shared/chat";
import {
  type SummaryConfig,
  type SummaryState,
  type SummaryRun,
  defaultSummaryConfig,
  upgradeSummaryConfig,
  summaryConfig,
  summarySourceKey,
  prepareSummary,
} from "../shared/summaries";
import { Dialog, ContextMessagePicker } from "./plugins-ui";
import { ParameterControl, Loading } from "./controls";
import { MessageUsage } from "./chat-controls";
export function SummaryEditor({
  value,
  providers,
  close,
  save,
  local = false,
  reset,
}: {
  value: SummaryConfig;
  providers: Provider[];
  close: () => void;
  save: (c: SummaryConfig) => Promise<void>;
  local?: boolean;
  reset?: () => Promise<void>;
}) {
  const [p, setP] = useState(() => structuredClone(value)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      title={(local ? "当前聊天" : "全局") + " · 回复摘要"}
      close={close}
      wide
    >
      <form
        className="sticky-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void save(p)
            .then(close)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="settings-form-scroll">
          <p className="muted">
            每条完整回复结束后与追问同时生成。只影响新请求；旧摘要保留，可手动重新生成。
            {local
              ? "当前聊天配置优先于全局，点击恢复全局可清除覆盖。"
              : "已有聊天的独立摘要配置优先于全局。"}
          </p>
          <fieldset className="du-fieldset plugin-editor-section">
            <legend className="du-fieldset-legend">摘要模型</legend>
            <label>
              模型
              <select
                className="du-select"
                aria-label="摘要模型"
                value={p.model ? JSON.stringify(p.model) : ""}
                onChange={(e) =>
                  setP({
                    ...p,
                    model: e.target.value ? JSON.parse(e.target.value) : null,
                  })
                }
              >
                <option value="">跟随当前主聊天模型</option>
                {providers.flatMap((v) =>
                  v.models
                    .filter((m) => m.enabled)
                    .map((m) => (
                      <option
                        key={v.id + m.id}
                        value={JSON.stringify({
                          providerId: v.id,
                          modelId: m.id,
                        })}
                      >
                        {v.prefix + m.id} · {v.name}
                      </option>
                    )),
                )}
              </select>
            </label>
            <label>
              思考强度
              <select
                className="du-select"
                aria-label="摘要思考强度"
                value={p.effort}
                onChange={(e) =>
                  setP({
                    ...p,
                    effort: e.target.value as SummaryConfig["effort"],
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
                ].map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <ParameterControl
              name="温度"
              value={p.parameters.temperature}
              max={2}
              step={0.05}
              onChange={(v) => {
                setP((current) => {
                  const parameters = { ...current.parameters };
                  if (v === undefined) delete parameters.temperature;
                  else parameters.temperature = v;
                  return { ...current, parameters };
                });
              }}
            />
            <label className="plugin-stream-toggle">
              流式输出
              <input
                className="du-toggle du-toggle-primary du-toggle-sm"
                type="checkbox"
                aria-label="摘要流式输出"
                checked={p.stream}
                onChange={(e) => {
                  const stream = e.target.checked;
                  setP((current) => ({ ...current, stream }));
                }}
              />
            </label>
          </fieldset>
          <label>
            摘要 system
            <textarea
              className="du-textarea"
              rows={9}
              aria-label="摘要 system"
              value={p.system}
              onChange={(e) => setP({ ...p, system: e.target.value })}
            />
          </label>
          <div className="du-alert" role="note">
            输出格式固定为 {`{"summary":"摘要文字"}`}；100–150
            字是目标，超出仅提示，不截断或自动重试。历史 user 最多 500
            字符，上一轮范例正文最多 2500 字符，均取首尾；本轮 U/A 完整。
          </div>
          {error && (
            <p className="du-alert du-alert-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          {reset && (
            <button
              className="du-btn du-btn-ghost"
              type="button"
              onClick={() =>
                void reset()
                  .then(close)
                  .catch((e) => setError(e.message))
              }
            >
              <I.reset size={15} />
              恢复全局
            </button>
          )}
          <button className="du-btn du-btn-ghost" type="button" onClick={close}>
            <I.cancel size={15} />
            取消
          </button>
          <button className="du-btn du-btn-primary" disabled={busy}>
            {busy ? <Loading small /> : <Check size={15} />}保存
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function GlobalSummarySettings({
  settings,
  providers,
  save,
}: {
  settings: Settings;
  providers: Provider[];
  save: (s: Settings) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="summary-setting-row du-card">
        <div>
          <strong>回复摘要</strong>
          <small className="muted">所有聊天自动生成 · 独立模型与温度</small>
        </div>
        <button className="du-btn du-btn-sm" onClick={() => setOpen(true)}>
          <SlidersHorizontal size={15} />
          摘要设置
        </button>
      </div>
      {open && (
        <SummaryEditor
          value={{
            ...defaultSummaryConfig(),
            ...upgradeSummaryConfig(settings.replySummary ?? {}),
          }}
          providers={providers}
          close={() => setOpen(false)}
          save={async (replySummary) => save({ ...settings, replySummary })}
        />
      )}
    </>
  );
}
function Usage({ run }: { run: SummaryRun }) {
  return (
    <div className="plugin-usage">
      <MessageUsage
        message={{
          id: run.id,
          parentId: null,
          role: "assistant",
          content: "",
          createdAt: run.createdAt,
          model: run.model,
          usage: run.usage,
          elapsedMs: run.elapsedMs,
        }}
      />
    </div>
  );
}
export type SummaryCommand = (
  action: string,
  body?: Record<string, unknown>,
) => Promise<void>;
export function ReplySummaryCard({
  chat,
  messageId,
  sourceKey,
  runs,
  latest,
  command,
}: {
  chat: Chat;
  messageId: string;
  sourceKey: string;
  runs: SummaryRun[];
  latest: boolean;
  command: SummaryCommand;
}) {
  const [open, setOpen] = useState(latest),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [compare, setCompare] = useState(false);
  useEffect(() => setOpen(latest), [latest]);
  const all = runs,
    valid = all.filter((r) => r.sourceKey === sourceKey);
  const accepted = valid.findLast((r) => r.status === "complete" && r.summary),
    pending = valid.findLast((r) => r.status === "running"),
    candidate = valid.findLast((r) => r.status === "candidate"),
    last = valid.at(-1) ?? all.at(-1);
  useEffect(() => {
    if (candidate) setCompare(true);
  }, [candidate?.id]);
  const action = async (name: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      await command(name, body);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "摘要操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!last) {
    if (chat.messages[messageId]?.status === "running") return null;
    return (
      <details className="plugin-result reply-summary du-collapse">
        <summary className="du-collapse-title">
          <BookOpenText size={15} />
          回复摘要 <small className="muted">未生成</small>
        </summary>
        <div className="du-collapse-content">
          <p className="muted">历史回复不会自动补发摘要请求；可手动生成。</p>
          {chat.messages[messageId]?.status !== "complete" && (
            <p className="du-alert du-alert-warning">
              原回复未完整结束，只会概括已收到的部分。
            </p>
          )}
          <button
            className="du-btn du-btn-sm"
            disabled={busy || !chat.messages[messageId]?.content.trim()}
            onClick={() => void action("regenerate", { messageId })}
          >
            {busy ? <Loading small /> : <I.regenerateSummary size={14} />}
            生成摘要
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      </details>
    );
  }
  return (
    <>
      <details
        className="plugin-result reply-summary du-collapse"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="du-collapse-title">
          <BookOpenText size={15} />
          <span>回复摘要</span>
          <small className="muted">
            {pending
              ? "生成中"
              : candidate
                ? "待确认替换"
                : accepted
                  ? "已保存"
                  : last.status === "error"
                    ? "生成失败"
                    : "待重新生成"}
          </small>
        </summary>
        <div className="du-collapse-content">
          {(pending ?? accepted ?? last).sourceIncomplete && (
            <p className="du-alert du-alert-warning">
              原回复未完整结束，这份摘要仅涵盖已收到的部分。
            </p>
          )}
          {pending ? (
            <>
              <Loading small />
              <pre className="summary-stream">{pending.output}</pre>
            </>
          ) : accepted ? (
            <p className="summary-text">{accepted.summary}</p>
          ) : last.status === "error" ? (
            <div className="du-alert du-alert-error" role="alert">
              <AlertCircle size={15} />
              {last.error}
            </div>
          ) : (
            <p className="muted">原文或上下文已变化，这份摘要不再用于请求。</p>
          )}
          {(pending ?? accepted ?? last).warning && (
            <div className="du-alert du-alert-warning">
              {(pending ?? accepted ?? last).warning}
            </div>
          )}
          {accepted && last.status === "error" && (
            <p className="du-alert du-alert-error" role="alert">
              {last.error}；原摘要仍然保留。
            </p>
          )}
          <Usage run={pending ?? accepted ?? last} />
          <div className="plugin-actions">
            <button
              className="du-btn du-btn-sm"
              disabled={busy || !!pending}
              onClick={() => void action("regenerate", { messageId })}
            >
              <I.regenerateSummary size={14} />
              重新生成摘要
            </button>
            {pending && (
              <button
                className="du-btn du-btn-sm"
                onClick={() => void action("cancel", { runId: pending.id })}
              >
                <X size={14} />
                停止摘要
              </button>
            )}
            {candidate && (
              <button
                className="du-btn du-btn-sm"
                onClick={() => setCompare(true)}
              >
                <I.compare size={14} />
                查看新摘要
              </button>
            )}
            <small className="muted">
              上下文 {formatTokenCount((pending ?? last).inputTokens)} Token
            </small>
            {last.status === "error" && !pending && (
              <FallbackButton
                disabled={busy}
                retry={(model) =>
                  action("fallback", { runId: last.id, model }).then((ok) => {
                    if (!ok) throw Error("备用模型请求未启动");
                  })
                }
              />
            )}
          </div>
          {error && (
            <p className="du-alert du-alert-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </details>
      {candidate && compare && (
        <Dialog title="确认替换摘要" close={() => setCompare(false)} wide>
          <div className="rewrite-compare">
            <section>
              <h3>原摘要</h3>
              <p className="summary-text">
                {accepted?.summary ?? "暂无有效摘要"}
              </p>
            </section>
            <section>
              <h3>新摘要</h3>
              <p className="summary-text">{candidate.summary}</p>
              {candidate.warning && (
                <p className="du-alert du-alert-warning">{candidate.warning}</p>
              )}
              <Usage run={candidate} />
            </section>
          </div>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button
              className="du-btn du-btn-ghost"
              disabled={busy}
              onClick={() =>
                void action("dismiss", { runId: candidate.id }).then(
                  (ok) => ok && setCompare(false),
                )
              }
            >
              <I.cancel size={15} />
              保留原摘要
            </button>
            <button
              className="du-btn du-btn-primary"
              disabled={busy}
              onClick={() =>
                void action("accept", { runId: candidate.id }).then(
                  (ok) => ok && setCompare(false),
                )
              }
            >
              <Check size={15} />
              确认替换
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}
export function SummaryTools({
  chat,
  settings,
  providers,
  command,
  backfillOnly = false,
}: {
  chat: Chat;
  settings: Settings;
  providers: Provider[];
  command: SummaryCommand;
  backfillOnly?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [filling, setFilling] = useState(false);
  return (
    <>
      <div className="summary-tools">
        {!backfillOnly && (
          <button className="du-btn du-btn-sm" onClick={() => setOpen(true)}>
            <SlidersHorizontal size={14} />
            摘要设置
          </button>
        )}
        <button
          className="du-btn du-btn-sm"
          disabled={filling}
          onClick={() => {
            setFilling(true);
            setError("");
            void command("backfill")
              .catch((e) => setError(e.message))
              .finally(() => setFilling(false));
          }}
        >
          {filling ? <Loading small /> : <BookOpenText size={14} />}
          补齐本分支全部摘要
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {open && (
        <SummaryEditor
          local
          value={summaryConfig(chat, settings)}
          providers={providers}
          close={() => setOpen(false)}
          save={async (config) => command("configure", { config })}
          reset={() => command("configure", { config: null })}
        />
      )}
    </>
  );
}
export function SummaryContextChip({
  chat,
  settings,
  providers,
  state,
}: {
  chat: Chat;
  settings: Settings;
  providers: Provider[];
  state: SummaryState;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<number | null>(null),
    [snapshot, setSnapshot] = useState<PluginRequest | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const path = route(chat),
    routeIds = new Set(path.map((m) => m.id));
  const message = path.findLast(
    (m) => m.role === "assistant" && m.status !== "running" && m.content.trim(),
  );
  const run = message
    ? state.runs.findLast(
        (r) =>
          r.messageId === message.id &&
          r.sourceKey === summarySourceKey(chat, message.id),
      )
    : undefined;
  const prepared = useMemo(() => {
    try {
      return message
        ? prepareSummary(chat, message.id, state, settings, providers)
        : null;
    } catch {
      return null;
    }
  }, [chat, message?.id, state, settings, providers]);
  useEffect(() => {
    setSnapshot(null);
    setSelected(null);
    setError("");
    if (!open || !run) return;
    let stopped = false;
    setLoading(true);
    void api<PluginRequest | null>(`/chats/${chat.id}/summaries`, "POST", {
      action: "request",
      runId: run.id,
    })
      .then((v) => {
        if (!stopped) setSnapshot(v?.messages ? v : null);
      })
      .catch((e) => {
        if (!stopped) setError(e.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [open, run?.id, chat.id]);
  const request = snapshot ?? prepared?.request,
    messages = request?.messages ?? [],
    tokens =
      run?.inputTokens ??
      messages.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0),
    ref = run?.model ?? prepared?.modelRef,
    capacity =
      providers
        .find((p) => p.id === ref?.providerId)
        ?.models.find((m) => m.id === ref?.modelId)?.capacity ?? 1048576;
  return (
    <>
      <button
        className="du-btn du-btn-ghost du-btn-sm plugin-chip summary-context-chip"
        aria-label="回复摘要上下文"
        onClick={() => setOpen(true)}
      >
        <PluginChipContents
          name="回复摘要"
          inputLabel={message ? formatTokenCount(tokens) : "待回复"}
          used={tokens}
          capacity={capacity}
          usage={run?.usage}
          cacheId={run?.id}
          historicalCache={historicalCacheReading(
            state.runs.filter((r) => routeIds.has(r.messageId)),
            run?.id,
            run?.model ?? prepared?.modelRef,
          )}
          fallback={
            tokens
              ? { input: tokens, thinking: 0, output: 0, total: tokens }
              : undefined
          }
          preview={
            run?.status === "running" &&
            prepared &&
            run.model?.providerId === prepared.modelRef.providerId &&
            run.model?.modelId === prepared.modelRef.modelId
              ? prepared
              : undefined
          }
        />
      </button>
      {open && (
        <Dialog title="回复摘要 · 上下文" close={() => setOpen(false)} wide>
          <p className="muted">
            {snapshot
              ? "本次请求快照"
              : run
                ? "请求快照不可用时显示当前组装内容"
                : "按当前分支组装的请求内容"}
          </p>
          <div className="du-stats plugin-context-stats">
            <div className="du-stat">
              <div className="du-stat-title">输入 / 模型容量</div>
              <div className="du-stat-value">
                {formatTokenCount(tokens)} / {formatTokenCount(capacity)}
              </div>
              <progress
                className="du-progress du-progress-primary"
                value={Math.min(tokens, capacity)}
                max={capacity}
              />
              <UsageRing
                usage={run?.usage}
                fallback={
                  tokens
                    ? { input: tokens, thinking: 0, output: 0, total: tokens }
                    : undefined
                }
              />
            </div>
          </div>
          {run && <Usage run={run} />}
          <p className="muted">
            历史要求摘录 + 历史摘要 → 上一轮原文与摘要范例 →
            本轮完整问答。首轮不添加范例。
          </p>
          {loading && <Loading small />}
          {error && <p role="alert">{error}</p>}
          <ContextMessagePicker
            messages={messages}
            selected={selected}
            select={setSelected}
            disabled={!messages.length || loading}
          />
          {selected !== null && messages[selected] && (
            <pre className="plugin-request-preview">
              {messages[selected]!.content}
            </pre>
          )}
          {!message && <p className="muted">完整回复结束后生成摘要。</p>}
        </Dialog>
      )}
    </>
  );
}
export function ConfirmPostSend({
  confirm,
  cancel,
}: {
  confirm: () => void;
  cancel: () => void;
}) {
  return (
    <Dialog title="仍有摘要或追问正在生成" close={cancel}>
      <p>
        继续发送下一条消息？原任务会继续，结果仍显示在原回复下；缺摘要时本次请求使用原回复前
        300 字。
      </p>
      <footer>
        <button className="du-btn du-btn-ghost" onClick={cancel}>
          <I.cancel size={15} />
          暂不发送
        </button>
        <button className="du-btn du-btn-primary" onClick={confirm}>
          <I.submit size={15} />
          继续发送
        </button>
      </footer>
    </Dialog>
  );
}
