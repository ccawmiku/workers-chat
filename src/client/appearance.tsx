import { Check, ChevronDown, Monitor, Sun, Moon } from "lucide-react";
import { useEffect, useRef } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";

function useColorDropdown() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && ref.current)
        ref.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
        e.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  return ref;
}
function ColorControl({ label, color, onChange }: {
  label: string; color: string; onChange: (color: string) => void;
}) {
  const ref = useColorDropdown();
  return <details className="du-dropdown du-dropdown-end color-control" ref={ref}>
    <summary className="du-btn du-btn-ghost du-btn-sm color-value" aria-label={label + "选择器"}>
      <i className="color-swatch" style={{ background: color }} aria-hidden="true" />
      <span>{color.toUpperCase()}</span>
    </summary>
    <div className="du-dropdown-content du-card color-popover" aria-label={label + "面板"}>
      <HexColorPicker color={color} onChange={onChange} aria-label={label + "色板"} />
      <HexColorInput className="du-input du-input-sm" aria-label={label} color={color}
        onChange={onChange} prefixed />
    </div>
  </details>;
}

export type Appearance = {
  densityVersion: number;
  theme: string;
  font: number;
  width: number;
  line: number;
  collapse: boolean;
  enter: boolean;
  accent: string;
  surface?: Partial<Record<"light" | "dark", string>>;
  ink?: Partial<Record<"light" | "dark", string>>;
};
export const validColor = (v: unknown): v is string =>
  typeof v === "string" && /^#[\da-f]{6}$/i.test(v);
export const themeDefaults = {
  light: { surface: "#fcfcfc", ink: "#0d0d0d" },
  dark: { surface: "#000000", ink: "#ededed" },
};
const defaults: Appearance = {
  densityVersion: 2,
  theme: "system",
  font: 16,
  width: 800,
  line: 1.6,
  collapse: true,
  enter: true,
  accent: "#f077af",
};
export function readAppearance(): Appearance {
  try {
    const v = JSON.parse(localStorage.getItem("appearance") ?? "null");
    if (!v || typeof v !== "object") return { ...defaults };
    const colors = (x: unknown) =>
      Object.fromEntries(
        Object.entries(x && typeof x === "object" ? x : {}).filter(
          ([k, c]) => ["light", "dark"].includes(k) && validColor(c),
        ),
      );
    return {
      ...defaults,
      theme: ["system", "light", "dark"].includes(v.theme)
        ? v.theme
        : defaults.theme,
      accent: validColor(v.accent) ? v.accent : defaults.accent,
      font:
        Number.isFinite(v.font) && v.font >= 13 && v.font <= 24
          ? v.font
          : defaults.font,
      width:
        Number.isFinite(v.width) && v.width >= 600 && v.width <= 1200
          ? v.width
          : defaults.width,
      line:
        v.densityVersion !== 2 && [1.8, 1.75].includes(v.line)
          ? defaults.line
          : Number.isFinite(v.line) && v.line >= 1.3 && v.line <= 2.4
            ? v.line
            : defaults.line,
      collapse:
        typeof v.collapse === "boolean" ? v.collapse : defaults.collapse,
      enter: typeof v.enter === "boolean" ? v.enter : defaults.enter,
      surface: colors(v.surface),
      ink: colors(v.ink),
    };
  } catch {
    return { ...defaults };
  }
}
export function applyAppearance(a: Appearance, dark: boolean) {
  const variant =
      a.theme === "system"
        ? dark
          ? "dark"
          : "light"
        : a.theme === "dark"
          ? "dark"
          : "light",
    root = document.documentElement;
  root.dataset.theme = variant;
  root.style.setProperty("--accent", a.accent);
  const rgb = a.accent
    .slice(1)
    .match(/../g)!
    .map((c) => {
      const v = parseInt(c, 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  root.style.setProperty(
    "--accent-ink",
    rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722 > 0.179
      ? "#0d0d0d"
      : "#ffffff",
  );
  root.style.setProperty(
    "--bg",
    a.surface?.[variant] ?? themeDefaults[variant].surface,
  );
  root.style.setProperty(
    "--text",
    a.ink?.[variant] ?? themeDefaults[variant].ink,
  );
}
const presets = [
  ["粉色", "#f077af"],
  ["蓝色", "#4169e1"],
  ["绿色", "#00a88a"],
  ["黄色", "#ffc933"],
  ["橙色", "#ff826c"],
  ["紫色", "#a458ff"],
  ["黑色", "#000000"],
] as const;
export function AppearanceSettings({
  value: a,
  onChange: update,
}: {
  value: Appearance;
  onChange: (a: Appearance) => void;
}) {
  const accentRef = useColorDropdown();
  const variant =
    a.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : a.theme === "dark"
        ? "dark"
        : "light";
  const preset = presets.find(([, color]) => color === a.accent);
  return (
    <div className="appearance-settings">
      <h2>外观</h2>
      <p className="appearance-caption">视觉风格</p>
      <section className="du-card appearance-group">
        <div className="appearance-row">
          <span>模式</span>
          <div className="theme-modes" role="group" aria-label="显示模式">
            {(
              [
                ["system", "跟随系统", Monitor],
                ["light", "浅色", Sun],
                ["dark", "深色", Moon],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                className={"du-btn du-btn-ghost theme-mode " + id}
                aria-label={label}
                aria-pressed={a.theme === id}
                onClick={() => update({ ...a, theme: id })}
              >
                <span className="theme-miniature" aria-hidden="true">
                  <i />
                  <b />
                  <em />
                  <small />
                </span>
                <span>
                  <Icon size={13} />
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="du-card appearance-group">
        <div className="appearance-row">
          <span>主题</span>
          <span className="theme-label">ChatGPT</span>
        </div>
        <div className="appearance-row">
          <span>强调色</span>
          <details className="du-dropdown du-dropdown-end accent-picker" ref={accentRef}>
            <summary className="du-btn du-btn-sm du-btn-ghost">
              <i className="color-swatch" style={{ background: a.accent }} />
              {preset?.[0] ?? "自定义"}
              <ChevronDown size={14} />
            </summary>
            <ul className="du-dropdown-content du-menu accent-options">
              {presets.map(([label, color]) => (
                <li key={color}>
                  <button
                    onClick={(e) => {
                      update({ ...a, accent: color });
                      e.currentTarget.closest("details")!.open = false;
                    }}
                  >
                    <i className="color-swatch" style={{ background: color }} />
                    {label}
                    {a.accent === color && <Check size={15} />}
                  </button>
                </li>
              ))}
              <li>
                <span className="custom-color">自定义</span>
                <ColorControl label="自定义强调色" color={a.accent}
                  onChange={(accent) => update({ ...a, accent })} />
              </li>
            </ul>
          </details>
        </div>
        {(
          [
            ["surface", "背景"],
            ["ink", "前景"],
          ] as const
        ).map(([key, label]) => (
          <div className="appearance-row" key={key}>
            <span>{label}</span>
            <ColorControl
                label={label + "颜色"}
                color={a[key]?.[variant] ?? themeDefaults[variant][key]}
                onChange={(color) =>
                  update({
                    ...a,
                    [key]: { ...a[key], [variant]: color },
                  })
                }
              />
          </div>
        ))}
      </section>
      <details className="du-collapse du-collapse-arrow appearance-advanced">
        <summary className="du-collapse-title">高级</summary>
        <div className="du-collapse-content">
          {(
            [
              ["font", "字号", 13, 24, 1, "px"],
              ["width", "内容宽度", 600, 1200, 20, "px"],
              ["line", "行间距", 1.3, 2.4, 0.1, ""],
            ] as const
          ).map(([key, label, min, max, step, unit]) => (
            <label className="appearance-row" key={key}>
              <span>
                {label} {a[key]}
                {unit}
              </span>
              <input
                className="du-range du-range-primary du-range-sm"
                aria-label={label}
                type="range"
                min={min}
                max={max}
                step={step}
                value={a[key]}
                onChange={(e) =>
                  update({ ...a, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          {(
            [
              ["collapse", "折叠超长消息"],
              ["enter", "电脑按 Enter 发送"],
            ] as const
          ).map(([key, label]) => (
            <label className="appearance-row" key={key}>
              <span>{label}</span>
              <input
                className="du-toggle du-toggle-primary du-toggle-sm"
                type="checkbox"
                checked={a[key]}
                onChange={(e) => update({ ...a, [key]: e.target.checked })}
              />
            </label>
          ))}
          <button
            className="du-btn du-btn-sm du-btn-ghost"
            onClick={() => update({ ...defaults, theme: a.theme })}
          >
            恢复默认外观
          </button>
          <p className="muted">仅保存在此设备。</p>
        </div>
      </details>
    </div>
  );
}
