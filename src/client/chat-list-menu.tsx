import React, { useRef, useState } from "react";
import {
  Archive,
  Copy,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { FloatingPanel } from "./composer-widgets";

export function ChatListMenu({
  chat,
  onAction,
}: {
  chat: {
    id: string;
    title: string;
    pinned: boolean;
    archived: boolean;
    deleted: boolean;
    status?: string;
  };
  onAction: (name: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const running = ["running", "pending"].includes(chat.status ?? "");
  const actions = [
    { name: "export", label: "导出 JSON", Icon: Download },
    { name: "rename", label: "重命名", Icon: Pencil },
    {
      name: "title",
      label: "重新生成标题",
      Icon: RotateCcw,
      disabled: running || chat.deleted,
    },
    { name: "pin", label: chat.pinned ? "取消置顶" : "置顶", Icon: Pin },
    { name: "duplicate", label: "复制", Icon: Copy, disabled: running },
    {
      name: "archive",
      label: chat.archived ? "取消归档" : "归档",
      Icon: Archive,
    },
    { name: "delete", label: chat.deleted ? "永久删除" : "删除", Icon: Trash2 },
  ];
  return (
    <>
      <button
        ref={anchor}
        className="chat-more"
        aria-label={"管理 " + chat.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={16} />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={238}
        label="对话菜单"
        className="chat-list-menu"
        focus
      >
        {actions.map(({ name, label, Icon, disabled }) => (
          <button
            key={name}
            disabled={disabled}
            className={name === "delete" ? "danger-text" : ""}
            onClick={() => {
              setOpen(false);
              onAction(name);
            }}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </FloatingPanel>
    </>
  );
}
