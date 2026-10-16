import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, X } from "lucide-react";
import type { Message } from "../shared/chat";

export function ConversationTimeline({
  messages,
  scrollRef,
  onJump,
}: {
  messages: Message[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
}) {
  const turns = useMemo(() => {
    const result: { question: Message; reply: string }[] = [];
    for (const message of messages) {
      if (message.role === "user")
        result.push({ question: message, reply: "" });
      else if (message.role === "assistant" && result.length)
        result[result.length - 1]!.reply += message.content + "\n";
    }
    return result;
  }, [messages]);
  const rail = useRef<HTMLElement>(null),
    preview = useRef<HTMLElement>(null),
    anchor = useRef<HTMLButtonElement | null>(null),
    closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(0),
    [opened, setOpened] = useState<number | null>(null),
    [position, setPosition] = useState({ left: 0, top: 0, width: 320 });
  const clear = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const closeSoon = () => {
    clear();
    closeTimer.current = setTimeout(() => setOpened(null), 160);
  };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nodes = container.querySelectorAll<HTMLElement>(
          "article.user[data-message-id]",
        );
        const threshold = container.getBoundingClientRect().top + 80;
        let lo = 0,
          hi = nodes.length - 1,
          index = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (nodes[mid]!.getBoundingClientRect().top <= threshold) {
            index = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        setActive(index);
      });
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [turns.length, scrollRef]);
  useLayoutEffect(() => {
    if (opened === null || !preview.current || !anchor.current || !rail.current)
      return;
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect(),
        bounds = rail.current!.getBoundingClientRect();
      const left = bounds.right + 10,
        width = Math.min(360, innerWidth - left - 12),
        height = preview.current!.getBoundingClientRect().height;
      setPosition({
        left,
        width,
        top: Math.max(
          12,
          Math.min(rect.top - height / 2, innerHeight - height - 12),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(preview.current);
    window.addEventListener("resize", place);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpened(null);
    };
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", escape);
    };
  }, [opened]);
  const show = (index: number, element: HTMLButtonElement) => {
    clear();
    anchor.current = element;
    setOpened(index);
  };
  const jump = (index: number) => {
    const turn = turns[index];
    if (turn) onJump(turn.question.id);
    setOpened(null);
  };
  if (turns.length < 2) return null;
  const selected = opened === null ? null : turns[opened];
  return (
    <>
      <nav
        ref={rail}
        className="conversation-timeline"
        aria-label="对话导航"
        style={
          { "--timeline-size": turns.length * 12 + "px" } as React.CSSProperties
        }
        onPointerEnter={clear}
        onPointerLeave={closeSoon}
      >
        {turns.map((turn, index) => (
          <button
            key={turn.question.id}
            className={
              "timeline-tick " +
              (active === index ? "current " : "") +
              (opened === index ? "previewed" : "")
            }
            aria-label={`第${index + 1}轮：${turn.question.content.slice(0, 48)}`}
            aria-current={active === index ? "location" : undefined}
            onPointerEnter={(e) => {
              if (e.pointerType !== "touch") show(index, e.currentTarget);
            }}
            onFocus={(e) => show(index, e.currentTarget)}
            onBlur={closeSoon}
            onClick={(e) => {
              if (e.detail !== 0 && matchMedia("(max-width:760px)").matches)
                show(index, e.currentTarget);
              else jump(index);
            }}
          >
            <span />
          </button>
        ))}
      </nav>
      {selected &&
        createPortal(
          <aside
            ref={preview}
            className="timeline-preview du-card"
            role="dialog"
            aria-label={`第${opened! + 1}轮预览`}
            style={position}
            onPointerEnter={clear}
            onPointerLeave={closeSoon}
          >
            <button
              className="timeline-preview-jump"
              aria-label={`跳转到第${opened! + 1}轮`}
              onClick={() => jump(opened!)}
            >
              <strong>{selected.question.content || "空问题"}</strong>
              <p>{selected.reply.trim() || "尚未收到回复"}</p>
              <CornerDownRight size={16} />
            </button>
            <button
              className="timeline-preview-close"
              aria-label="关闭对话预览"
              onClick={() => setOpened(null)}
            >
              <X size={14} />
            </button>
          </aside>,
          document.body,
        )}
    </>
  );
}
