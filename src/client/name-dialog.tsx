import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton, Loading, useDialogFocus } from "./controls";

export function NameDialog({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const ref = useRef<HTMLElement>(null),
    [name, setName] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const close = () => {
    if (!busy) onClose();
  };
  useDialogFocus(ref, close, true);
  return createPortal(
    <div
      className="du-modal du-modal-open name-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={ref}
        className="du-modal-box name-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <IconButton label="关闭名称窗口" disabled={busy} onClick={close}>
            <X size={18} />
          </IconButton>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            setBusy(true);
            setError("");
            void onSave(name.trim())
              .then(onClose)
              .catch((e) =>
                setError(e instanceof Error ? e.message : "保存失败，请重试。"),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            分组名称
            <input
              className="du-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              disabled={busy}
              placeholder="输入分组名称"
            />
          </label>
          {error && (
            <p className="du-alert du-alert-error" role="alert">
              {error}
            </p>
          )}
          <div className="name-dialog-actions">
            <button
              className="du-btn du-btn-ghost du-btn-sm"
              type="button"
              disabled={busy}
              onClick={close}
            >
              <X size={15} />
              取消
            </button>
            <button
              className="du-btn du-btn-sm primary"
              disabled={busy || !name.trim()}
            >
              {busy && <Loading small />}确认
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
