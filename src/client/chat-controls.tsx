import { UsageBar } from "./usage-bar";
import { useState, useRef } from "react";
import {
  type Chat,
  type Message,
  type Provider,
  cacheHitRate,
  formatTokenCount,
} from "../shared/chat";
import { api } from "./api";
import { IconButton, ParameterControl } from "./controls";
import {
  Plus,
  GripVertical,
  ArrowUp,
  ArrowDown,
  X,
  ChevronDown,
  Check,
  PlugZap,
} from "lucide-react";
import { directFetch, useDeviceConnection } from "./device-connection";
import { readCompletion, redactUpstreamError } from "../shared/completion";
import type { Settings } from "../shared/chat";
type Run = (fn: () => Promise<void>) => Promise<void>;
export function ModelControls({
  provider,
  model,
  run,
  refresh,
}: {
  provider: Provider;
  model: Provider["models"][number];
  run: Run;
  refresh: () => Promise<void>;
}) {
  const connection = useDeviceConnection();
  const [effort, setEffort] = useState("inherit"),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  return (
    <details className="model-controls du-collapse du-collapse-arrow">
      <summary className="du-collapse-title">模型设置</summary>
      <div className="du-collapse-content">
        <fieldset className="du-fieldset model-budget">
          <legend className="du-fieldset-legend">上下文预算</legend>
          <input
            className="du-input du-input-sm"
            aria-label={model.id + "上下文预算"}
            type="number"
            min="1"
            defaultValue={model.capacity}
            onBlur={(e) => {
              const capacity = Number(e.target.value);
              if (capacity === model.capacity) return;
              void run(async () => {
                await api("/providers/" + provider.id + "/models", "PUT", {
                  models: [{ id: model.id, capacity }],
                });
                await refresh();
              });
            }}
          />
          <small>用于上下文用量提示，不代表服务商实际支持的长度。</small>
        </fieldset>
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
            value={model.parameters[key]}
            max={key === "temperature" ? 2 : key === "top_p" ? 1 : 100000}
            step={key === "top_k" ? 1 : 0.05}
            onChange={(value) =>
              void run(async () => {
                const next = { ...model.parameters };
                if (value === undefined) delete next[key];
                else next[key] = value;
                await api("/providers/" + provider.id + "/models", "PUT", {
                  models: [{ id: model.id, parameters: next }],
                });
                await refresh();
              })
            }
          />
        ))}
        <label>
          测试强度
          <select
            className="du-select du-select-sm"
            aria-label={model.id + "测试思考强度"}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          >
            <option value="max">最高 max</option>
            <option value="high">高 high</option>
            <option value="medium">中 medium</option>
            <option value="low">低 low</option>
            <option value="none">无 none</option>
            <option value="inherit">跟随接口</option>
          </select>
        </label>
        <button
          className="du-btn du-btn-sm du-btn-ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setResult("");
            void run(async () => {
              try {
                let elapsedMs: number;
                if (connection.enabled) {
                  const key = await connection.key({
                    providerId: provider.id,
                    baseUrl: provider.baseUrl,
                    hasKey: !!(provider as Provider & { hasKey?: boolean })
                      .hasKey,
                  });
                  const defaults = await api<Settings>("/settings"),
                    started = Date.now();
                  try {
                    const signal = AbortSignal.timeout(120000);
                    const response = await directFetch(
                      provider.baseUrl,
                      "/chat/completions",
                      key,
                      {
                        model: model.id,
                        stream: false,
                        ...defaults.parameters,
                        ...model.parameters,
                        ...(effort !== "inherit"
                          ? { reasoning_effort: effort }
                          : {}),
                        messages: [{ role: "user", content: "请只回复 OK。" }],
                      },
                      signal,
                    );
                    await readCompletion(
                      response,
                      false,
                      signal,
                      { content: "", reasoning: "" },
                      () => {},
                    );
                    elapsedMs = Date.now() - started;
                  } catch (error) {
                    throw Error(
                      redactUpstreamError(
                        error instanceof Error ? error.message : "直连测试失败",
                        key,
                      ),
                    );
                  }
                } else {
                  const r = await api<{ elapsedMs: number }>(
                    "/providers/" + provider.id + "/test",
                    "POST",
                    { modelId: model.id, effort },
                  );
                  elapsedMs = r.elapsedMs;
                }
                setResult(`连接成功 · ${(elapsedMs / 1000).toFixed(1)} 秒`);
              } finally {
                setBusy(false);
              }
            });
          }}
        >
          <PlugZap size={15} />
          {busy ? "正在测试…" : "测试连接"}
        </button>
        {result && <p role="status">{result}</p>}
      </div>
    </details>
  );
}
export function SystemPrompts({
  templates,
  value,
  onChange,
}: {
  templates: Chat["system"];
  value: Chat["system"];
  onChange: (templates: Chat["system"]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState<string | null>(null),
    [dragged, setDragged] = useState<number | null>(null),
    [target, setTarget] = useState<number | null>(null),
    [busy, setBusy] = useState(false);
  const dragPosition = useRef<{ from: number; to: number } | null>(null);
  const save = async (next: Chat["system"]) => {
    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  };
  const move = (from: number, to: number) => {
    if (from === to || busy) return;
    const next = [...value],
      [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    void save(next);
  };
  return (
    <div className="prompt-list" aria-label="当前聊天系统提示词">
      {value.map((t, i) => (
        <div
          key={t.id + i}
          className={
            "prompt-item du-card " +
            (dragged === i ? "dragging " : "") +
            (target === i && dragged !== i ? "drag-target" : "")
          }
          data-prompt-index={i}
        >
          <div className="prompt-row">
            <button
              type="button"
              className="prompt-grip"
              disabled={busy}
              aria-label={"拖动排序 " + t.name}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                dragPosition.current = { from: i, to: i };
                setDragged(i);
              }}
              onPointerMove={(e) => {
                if (!dragPosition.current) return;
                const row = document
                  .elementFromPoint(e.clientX, e.clientY)
                  ?.closest<HTMLElement>("[data-prompt-index]");
                if (
                  row &&
                  e.currentTarget.closest(".prompt-list")?.contains(row)
                ) {
                  const to = Number(row.dataset.promptIndex);
                  dragPosition.current.to = to;
                  setTarget(to);
                }
              }}
              onPointerUp={(e) => {
                const position = dragPosition.current;
                dragPosition.current = null;
                setDragged(null);
                setTarget(null);
                e.currentTarget.releasePointerCapture(e.pointerId);
                if (position) move(position.from, position.to);
              }}
              onPointerCancel={() => {
                dragPosition.current = null;
                setDragged(null);
                setTarget(null);
              }}
            >
              <GripVertical size={16} />
            </button>
            <button
              className="prompt-name"
              aria-expanded={expanded === t.id + i}
              onClick={() =>
                setExpanded(expanded === t.id + i ? null : t.id + i)
              }
            >
              {t.name}
              <ChevronDown size={12} />
            </button>
            <IconButton
              label={"上移提示词 " + t.name}
              disabled={i === 0 || busy}
              onClick={() => move(i, i - 1)}
            >
              <ArrowUp size={13} />
            </IconButton>
            <IconButton
              label={"下移提示词 " + t.name}
              disabled={i === value.length - 1 || busy}
              onClick={() => move(i, i + 1)}
            >
              <ArrowDown size={13} />
            </IconButton>
            <IconButton
              label={"移除提示词 " + t.name}
              disabled={busy}
              onClick={() => void save(value.filter((_, j) => j !== i))}
            >
              <X size={13} />
            </IconButton>
          </div>
          {expanded === t.id + i && (
            <textarea
              className="du-textarea"
              aria-label={t.name}
              defaultValue={t.content}
              onBlur={(e) => {
                if (e.target.value !== t.content)
                  void save(
                    value.map((v, j) =>
                      j === i ? { ...v, content: e.target.value } : v,
                    ),
                  );
              }}
            />
          )}
        </div>
      ))}
      <div className="prompt-add">
        <button
          className="du-btn du-btn-ghost du-btn-sm"
          aria-label="选择系统提示词模板"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Plus size={17} />
          <span>选择提示词模板</span>
        </button>
        {open && (
          <div className="prompt-choices" aria-label="系统提示词模板">
            {templates.map((t) => {
              const added = value.some((v) => v.id === t.id);
              return (
                <button
                  key={t.id}
                  disabled={added || busy}
                  onClick={() => void save([...value, structuredClone(t)])}
                >
                  {added ? <Check size={15} /> : <Plus size={15} />}
                  <span>{t.name}</span>
                </button>
              );
            })}
            {!templates.length && (
              <p className="muted">请先在总体设置的“提示词模板”中添加模板。</p>
            )}
          </div>
        )}
      </div>
      <small className="prompt-help">
        {value.length
          ? "按从上到下的顺序发送；拖动或用箭头排序，点击名称编辑本聊天的副本。"
          : "未选择模板，不发送系统提示词。"}
      </small>
    </div>
  );
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
export function MessageUsage({
  message,
  historical = false,
  showBar = false,
}: {
  message: Message;
  historical?: boolean;
  showBar?: boolean;
}) {
  const usage = message.usage ?? {},
    outputDetails = object(
      usage.completion_tokens_details ?? usage.output_tokens_details,
    );
  const rows: [string, number | undefined][] = [
    ["输入", count(usage.prompt_tokens ?? usage.input_tokens)],
    ["输出", count(usage.completion_tokens ?? usage.output_tokens)],
    ["思考", count(outputDetails.reasoning_tokens)],
    ["总计", count(usage.total_tokens)],
  ];
  return (
    <div
      className={
        "message-meta " +
        (historical && !cacheHitRate(usage.cache_hit_rate) ? "historical" : "")
      }
    >
      <span>{message.model?.modelId ?? String(message.raw?.model ?? "")}</span>
      {message.elapsedMs !== undefined && (
        <span> · {(message.elapsedMs / 1000).toFixed(1)} 秒</span>
      )}
      {rows
        .filter((r): r is [string, number] => r[1] !== undefined)
        .map(([label, value]) => (
          <span key={label}>
            {" "}
            · {label} {formatTokenCount(value)}
          </span>
        ))}
      {rows.some((r) => r[1] !== undefined) && <span> Token</span>}
      {showBar && <UsageBar usage={usage} />}
      {cacheHitRate(usage.cache_hit_rate) !== undefined && (
        <span> · 缓存率 {cacheHitRate(usage.cache_hit_rate)}</span>
      )}
    </div>
  );
}
