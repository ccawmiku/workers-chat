import { useEffect, useState, useRef } from "react";
import type { LengthGuidance } from "../shared/length-guidance";
export function LengthSettings({
  value,
  save,
  disabled,
}: {
  value?: LengthGuidance;
  save: (value: LengthGuidance) => Promise<void>;
  disabled: boolean;
}) {
  const [text, setText] = useState(value?.requirement ?? ""),
    [enabled, setEnabled] = useState(!!value?.enabled),
    [error, setError] = useState("");
  const pending = useRef(0);
  useEffect(() => {
    if (!pending.current) {
      setText(value?.requirement ?? "");
      setEnabled(!!value?.enabled);
    }
  }, [value?.requirement, value?.enabled]);
  const commit = async (nextEnabled: boolean) => {
    if (nextEnabled === !!value?.enabled && text === (value?.requirement ?? ""))
      return;
    setEnabled(nextEnabled);
    pending.current++;
    try {
      await save({ enabled: nextEnabled, requirement: text });
      if (pending.current === 1) setEnabled(nextEnabled);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setEnabled(!!value?.enabled);
    } finally {
      pending.current--;
    }
  };
  return (
    <div className="length-settings">
      <label className="toggle">
        字数要求
        <input
          className="du-toggle du-toggle-primary du-toggle-sm"
          aria-label="启用字数要求"
          type="checkbox"
          disabled={disabled}
          checked={enabled}
          onChange={(e) => void commit(e.target.checked)}
        />
      </label>
      <label>
        每轮默认要求
        <textarea
          className="du-textarea du-textarea-sm"
          aria-label="每轮默认字数要求"
          maxLength={10000}
          rows={2}
          placeholder="例如：3000字、多写点；留空则每轮在输入框询问"
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit(enabled)}
        />
      </label>
      <small>
        不调用模型。仅在正式写作前注入上一轮要求、实际输出量和本轮要求。
      </small>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
