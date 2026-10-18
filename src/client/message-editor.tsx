import { ActionIcons as I } from "./action-icons";
import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { Expand, Minimize2 } from "lucide-react";
import { IconButton, useDialogFocus } from "./controls";

export function MessageEditor({
  value,
  expanded,
  saving,
  busy = false,
  user,
  error,
  rewriteActions,
  onChange,
  onExpand,
  onCancel,
  onSave,
}: {
  value: string;
  expanded: boolean;
  saving: boolean;
  busy?: boolean;
  user: boolean;
  error?: string;
  rewriteActions?: React.ReactNode;
  onChange: (value: string) => void;
  onExpand: (value: boolean) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, () => onExpand(false), expanded);
  const editor = (
    <div
      ref={dialog}
      className={"edit-area " + (expanded ? "edit-fullscreen" : "")}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? "全屏编辑消息" : undefined}
    >
      <div className="edit-toolbar">
        <span>{user ? "编辑问题" : "编辑回复"}</span>
        <IconButton
          label={expanded ? "退出全屏编辑" : "全屏编辑"}
          onClick={() => onExpand(!expanded)}
        >
          {expanded ? <Minimize2 size={17} /> : <Expand size={17} />}
        </IconButton>
      </div>
      <textarea
        className="du-textarea"
        aria-label="编辑消息正文"
        value={value}
        disabled={saving}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
      <div className="edit-actions">
        {user && rewriteActions && (
          <div className="edit-rewrite-actions">{rewriteActions}</div>
        )}
        <button disabled={saving} onClick={onCancel}>
          <I.cancel size={15} />
          取消
        </button>
        <button className="primary" disabled={saving || busy} onClick={onSave}>
          <I.save size={15} />
          {saving ? "保存中…" : user ? "保存为新分支" : "保存"}
        </button>
      </div>
    </div>
  );
  return expanded ? (
    <>
      <div className="edit-placeholder" />
      {createPortal(
        <div className="edit-fullscreen-backdrop">{editor}</div>,
        document.body,
      )}
    </>
  ) : (
    editor
  );
}
