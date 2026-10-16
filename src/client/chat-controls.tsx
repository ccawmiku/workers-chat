import React, { useState } from "react";
import type { Chat, Message, Provider } from "../shared/chat";
import { api } from "./api";
import { ParameterControl } from "./controls";
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
  const [effort, setEffort] = useState("max"),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  return (
    <details className="model-controls">
      <summary>模型生成默认值与连通性</summary>
      {(["temperature", "top_p", "top_k"] as const).map((key) => (
        <ParameterControl
          key={key}
          name={
            key === "temperature" ? "温度" : key === "top_p" ? "Top P" : "Top K"
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
        测试思考强度
        <select
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
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setResult("");
          void run(async () => {
            try {
              const r = await api<{ elapsedMs: number }>(
                "/providers/" + provider.id + "/test",
                "POST",
                { modelId: model.id, effort },
              );
              setResult(`连接成功 · ${(r.elapsedMs / 1000).toFixed(1)} 秒`);
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        {busy ? "正在测试…" : "测试此模型连接"}
      </button>
      {result && <p role="status">{result}</p>}
    </details>
  );
}
export function TemplatePicker({
  templates,
  onApply,
}: {
  templates: Chat["system"];
  onApply: (templates: Chat["system"]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  return (
    <details className="template-picker">
      <summary>选择系统模板（可多选）</summary>
      {templates.map((t) => (
        <label key={t.id} className="template-option">
          <input
            type="checkbox"
            checked={selected.includes(t.id)}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, t.id]
                  : selected.filter((id) => id !== t.id),
              )
            }
          />
          <span>{t.name}</span>
          {selected.includes(t.id) && (
            <small>顺序 {selected.indexOf(t.id) + 1}</small>
          )}
        </label>
      ))}
      {!templates.length && <p className="muted">请先在设置中保存模板。</p>}
      <button
        disabled={!selected.length || busy}
        onClick={() => {
          setBusy(true);
          void onApply(
            selected
              .map((id) => templates.find((t) => t.id === id))
              .filter((t): t is Chat["system"][number] => !!t)
              .map((t) => structuredClone(t)),
          )
            .then(() => setSelected([]))
            .finally(() => setBusy(false));
        }}
      >
        应用所选模板
      </button>
    </details>
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
}: {
  message: Message;
  historical?: boolean;
}) {
  const usage = message.usage ?? {},
    inputDetails = object(
      usage.prompt_tokens_details ?? usage.input_tokens_details,
    ),
    outputDetails = object(
      usage.completion_tokens_details ?? usage.output_tokens_details,
    );
  const rows: [string, number | undefined][] = [
    ["输入", count(usage.prompt_tokens ?? usage.input_tokens)],
    ["输出", count(usage.completion_tokens ?? usage.output_tokens)],
    ["缓存", count(inputDetails.cached_tokens)],
    ["思考", count(outputDetails.reasoning_tokens)],
    ["总计", count(usage.total_tokens)],
  ];
  return (
    <div className={"message-meta " + (historical ? "historical" : "")}>
      <span>{message.model?.modelId ?? String(message.raw?.model ?? "")}</span>
      {message.elapsedMs !== undefined && (
        <span> · {(message.elapsedMs / 1000).toFixed(1)} 秒</span>
      )}
      {rows
        .filter((r): r is [string, number] => r[1] !== undefined)
        .map(([label, value]) => (
          <span key={label}>
            {" "}
            · {label} {value.toLocaleString()}
          </span>
        ))}
      {rows.some((r) => r[1] !== undefined) && <span> Token（实际）</span>}
    </div>
  );
}
