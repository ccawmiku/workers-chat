import React, { useState, useEffect, useRef } from "react";
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={"icon-button " + className}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function ParameterControl({
  name,
  value,
  max,
  step,
  onChange,
}: {
  name: string;
  value?: number;
  max: number;
  step: number;
  onChange: (value: number | undefined) => void;
}) {
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);
  return (
    <div className="parameter">
      <div>
        <span>{name}</span>
        <button className="text-button" onClick={() => onChange(undefined)}>
          {value === undefined ? "默认" : "恢复默认"}
        </button>
      </div>
      <div>
        <input
          aria-label={name + "滑块"}
          type="range"
          min={0}
          max={max}
          step={step}
          value={current ?? max / 2}
          onChange={(e) => setCurrent(Number(e.target.value))}
          onPointerUp={(e) => onChange(Number(e.currentTarget.value))}
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
              onChange(Number(e.currentTarget.value));
          }}
        />
        <input
          aria-label={name}
          type="number"
          min={0}
          max={max}
          step={step}
          placeholder="默认"
          value={current ?? ""}
          onChange={(e) =>
            setCurrent(
              e.target.value === "" ? undefined : Number(e.target.value),
            )
          }
          onBlur={() => onChange(current)}
        />
      </div>
    </div>
  );
}

export function useDialogFocus(
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
  enabled: boolean,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const root = ref.current,
      previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.item(dialogs.length - 1) !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (!first) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      if (previous?.isConnected) previous.focus();
    };
  }, [enabled, ref]);
}
