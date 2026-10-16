import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Unplug,
  UserRound,
} from "lucide-react";
import type { Effort } from "../shared/chat";
import { useDialogFocus } from "./controls";

export function FloatingPanel({
  anchor,
  open,
  onClose,
  width,
  label,
  children,
  className = "",
  focus = false,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width: number;
  label: string;
  children: React.ReactNode;
  className?: string;
  focus?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useDialogFocus(panel, onClose, open && focus);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const element = panel.current;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0,
        top = viewport?.offsetTop ?? 0;
      const availableWidth = viewport?.width ?? innerWidth,
        availableHeight = viewport?.height ?? innerHeight;
      const size = Math.min(width, availableWidth - 24);
      element.style.width = size + "px";
      element.style.maxHeight = availableHeight - 24 + "px";
      const height = element.getBoundingClientRect().height;
      element.style.left =
        Math.max(
          left + 12,
          Math.min(rect.right - size, left + availableWidth - size - 12),
        ) + "px";
      const above = rect.top - height - 10;
      const y = above >= top + 12 ? above : rect.bottom + 10;
      element.style.top =
        Math.max(top + 12, Math.min(y, top + availableHeight - height - 12)) +
        "px";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!anchor.current?.contains(node) && !element.contains(node))
        close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close.current();
        anchor.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, width, anchor]);
  return open
    ? createPortal(
        <div
          ref={panel}
          role={focus ? "dialog" : "tooltip"}
          aria-label={label}
          className={"floating-panel " + className}
        >
          {children}
        </div>,
        document.body,
      )
    : null;
}

function compact(value: number) {
  if (value < 1000) return String(value);
  const divisor = value >= 1000000 ? 1000000 : 1000;
  return Number((value / divisor).toFixed(1)) + (divisor === 1000 ? "k" : "M");
}

export function ContextUsage({
  used,
  capacity,
}: {
  used: number;
  capacity: number;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false),
    [pinned, setPinned] = useState(false);
  const percent = Math.round((used / capacity) * 100);
  const fraction = Math.max(0, Math.min(1, used / Math.max(1, capacity)));
  const arc = (start: number, end: number) => {
    const point = (angle: number) =>
      `${10 + 7 * Math.sin(angle)} ${10 - 7 * Math.cos(angle)}`;
    return `M ${point(start)} A 7 7 0 ${end - start > Math.PI ? 1 : 0} 1 ${point(end)}`;
  };
  const whole = "M 10 3 A 7 7 0 1 1 10 17 A 7 7 0 1 1 10 3";
  return (
    <>
      <button
        ref={anchor}
        className="context-trigger"
        aria-label="上下文使用量"
        aria-expanded={hover || pinned}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => setPinned(!pinned)}
      >
        <svg
          className={"context-ring " + (used > capacity ? "over" : "")}
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          strokeWidth="2.5"
        >
          {fraction === 0 || fraction === 1 ? (
            <path d={whole} stroke={fraction ? "currentColor" : "#7c7c7c"} />
          ) : (
            <>
              <path d={arc(0, fraction * Math.PI * 2)} stroke="currentColor" />
              <path
                d={arc(fraction * Math.PI * 2, Math.PI * 2)}
                stroke="#7c7c7c"
              />
            </>
          )}
        </svg>
      </button>
      <FloatingPanel
        anchor={anchor}
        open={hover || pinned}
        onClose={() => {
          setPinned(false);
          setHover(false);
        }}
        width={242}
        label="上下文使用量"
        className="context-popover"
      >
        <div className="context-heading">背景信息窗口：</div>
        <strong>
          {percent}% 已用（剩余 {Math.max(0, 100 - percent)}%）
        </strong>
        <div>
          已用 {compact(used)} 标记，共 {compact(capacity)}
        </div>
      </FloatingPanel>
    </>
  );
}

export const effortLabels: Record<Effort, string> = {
  inherit: "跟随接口",
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};
const efforts: Effort[] = ["none", "low", "medium", "high", "max"];
export function EffortControl({
  value,
  model,
  onChange,
  onChooseModel,
}: {
  value: Effort;
  model: string;
  onChange: (value: Effort) => Promise<void>;
  onChooseModel: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [current, setCurrent] = useState(value);
  const pending = useRef(0),
    writes = useRef(Promise.resolve());
  useEffect(() => {
    if (!pending.current) setCurrent(value);
  }, [value]);
  const persist = (next: Effort) => {
    setCurrent(next);
    pending.current++;
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        try {
          await onChange(next);
        } finally {
          pending.current--;
        }
      });
  };
  const explicit = useRef<Effort>(value === "inherit" ? "max" : value);
  if (current !== "inherit") explicit.current = current;
  const inherited = current === "inherit";
  const index = efforts.indexOf(inherited ? explicit.current : current);
  const commit = (position: number) => {
    const next = efforts[position]!;
    persist(next);
  };
  return (
    <div className="effort-control">
      <button
        ref={anchor}
        className={"effort-trigger " + (open ? "active" : "")}
        aria-label="思考强度"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span>{effortLabels[current]}</span>
        <ChevronDown size={12} />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={320}
        label="思考强度"
        className="effort-popover"
        focus
      >
        <div className="effort-heading">
          <button
            className="icon-button"
            aria-label="跟随接口"
            title="跟随接口（不发送思考强度参数）"
            aria-pressed={inherited}
            onClick={() => {
              const next = inherited ? explicit.current : "inherit";
              persist(next);
            }}
          >
            <Unplug size={17} />
          </button>
          <strong aria-live="polite">{effortLabels[current]}</strong>
          <button
            className="icon-button"
            aria-label="恢复最高思考强度"
            title="恢复最高思考强度"
            onClick={() => commit(4)}
          >
            <RotateCcw size={18} />
          </button>
        </div>
        <button
          className="effort-model"
          onClick={() => {
            setOpen(false);
            onChooseModel();
          }}
          title={model}
        >
          <span>{model}</span>
          <ChevronRight size={13} />
        </button>
        <div className={"effort-track " + (inherited ? "inherited" : "")}>
          <input
            className="du-range du-range-primary du-range-sm"
            type="range"
            min={0}
            max={4}
            step={1}
            value={index}
            aria-label="思考强度滑块"
            aria-valuetext={
              inherited ? "跟随接口，移动滑块可指定强度" : effortLabels[current]
            }
            onChange={(e) => setCurrent(efforts[Number(e.target.value)]!)}
            onPointerUp={(e) => commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                ].includes(e.key)
              )
                commit(Number(e.currentTarget.value));
            }}
          />
          <div className="effort-marks" aria-hidden="true">
            {efforts.map((e, position) => (
              <i
                key={e}
                title={effortLabels[e]}
                className={position === index ? "at-thumb" : ""}
              />
            ))}
          </div>
        </div>
      </FloatingPanel>
    </div>
  );
}

export function AccountMenu({
  items,
}: {
  items: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    separator?: boolean;
  }[];
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        className={"account-trigger " + (open ? "active" : "")}
        aria-label="账户菜单"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="du-avatar du-avatar-placeholder">
          <span className="account-avatar">
            <UserRound size={17} aria-hidden="true" />
          </span>
        </span>
        <span className="account-name">
          <strong>个人账户</strong>
          <small>在线AI</small>
        </span>
        <ChevronDown size={15} />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={280}
        label="账户菜单"
        className="account-popover"
        focus
      >
        <div className="account-summary">
          <span className="du-avatar du-avatar-placeholder">
            <span className="account-avatar">
              <UserRound size={17} aria-hidden="true" />
            </span>
          </span>
          <div>
            <strong>个人账户</strong>
            <small>在线AI</small>
          </div>
        </div>
        <ul className="du-menu account-menu-list">
          {items.map((item) => (
            <li
              key={item.label}
              className={item.separator ? "account-menu-separated" : ""}
            >
              <button
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </FloatingPanel>
    </>
  );
}
