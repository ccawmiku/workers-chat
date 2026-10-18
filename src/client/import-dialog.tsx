import { useRef, useState } from "react";
import { api } from "./api";
import { useDialogFocus } from "./controls";

export type ImportPreview = {
  count: number;
  branches: number;
  attachments: number;
  failures: { index: number; reason: string }[];
};

export function ImportDialog({
  data,
  preview,
  close,
  refresh,
}: {
  data: unknown;
  preview: ImportPreview;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const ref = useRef<HTMLElement>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [result, setResult] = useState<{
      count: number;
      failures: ImportPreview["failures"];
    } | null>(null),
    [notice, setNotice] = useState("");
  useDialogFocus(
    ref,
    () => {
      if (!busy) close();
    },
    true,
  );
  const rows = Array.isArray(data) ? data : [data];
  async function start() {
    if (busy) return;
    setBusy(true);
    const failures = [...preview.failures],
      invalid = new Set(failures.map((f) => f.index));
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!invalid.has(i + 1)) {
        try {
          const imported = await api<{
            ids: string[];
            failures: ImportPreview["failures"];
          }>("/import", "POST", { data: rows[i] });
          count += imported.ids.length;
          failures.push(
            ...imported.failures.map((f) => ({ ...f, index: i + 1 })),
          );
        } catch (error) {
          // Do not retry an uncertain write. Continue other independent entries
          // and report exactly which item needs the user's attention.
          failures.push({
            index: i + 1,
            reason:
              (error instanceof Error ? error.message : "导入失败") +
              "；请核对聊天列表后再决定是否重新导入。",
          });
        }
      }
      setProgress(i + 1);
    }
    setResult({ count, failures: failures.sort((a, b) => a.index - b.index) });
    try {
      await refresh();
    } catch {
      setNotice("导入已结束，聊天列表刷新失败，请重新加载页面。");
    }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="导入预览"
      >
        <h2>{result ? "导入结果" : "导入预览"}</h2>
        {result ? (
          <p role="status">
            已导入 {result.count} 个聊天，失败 {result.failures.length} 项。
          </p>
        ) : (
          <p>
            {preview.count} 个聊天，{preview.branches} 个分叉点，将移除{" "}
            {preview.attachments} 个附件引用。
          </p>
        )}
        {(result?.failures ?? preview.failures).map((f) => (
          <p key={f.index} className="danger-text">
            第 {f.index} 项：{f.reason}
          </p>
        ))}
        {busy && (
          <p role="status">
            正在导入 {progress} / {rows.length}…
          </p>
        )}
        {notice && <p role="alert">{notice}</p>}
        <p className="muted">每次导入都会新增独立会话。</p>
        <button disabled={busy} onClick={close}>
          {result ? "关闭导入结果" : "取消"}
        </button>
        {!result && (
          <button
            className="primary"
            disabled={busy || !preview.count}
            onClick={() => void start()}
          >
            确认导入有效聊天
          </button>
        )}
      </section>
    </div>
  );
}
