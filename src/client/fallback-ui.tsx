import { createContext, useContext, useState } from "react";
import type { ModelRef, Provider, Settings } from "../shared/chat";
import { ActionIcons as I } from "./action-icons";
import { Loading } from "./controls";
export const FallbackContext = createContext<{
  models: ModelRef[];
  providers: Provider[];
}>({ models: [], providers: [] });
const options = (providers: Provider[]) =>
  providers.flatMap((p) =>
    p.models
      .filter((m) => m.enabled)
      .map((m) => ({
        ref: { providerId: p.id, modelId: m.id },
        label: p.prefix + m.id + " · " + p.name,
      })),
  );
export function FallbackButton({
  retry,
  disabled = false,
}: {
  retry: (model: ModelRef) => Promise<unknown>;
  disabled?: boolean;
}) {
  const { models, providers } = useContext(FallbackContext);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const available = options(providers).filter((o) =>
    models.some(
      (m) => m.providerId === o.ref.providerId && m.modelId === o.ref.modelId,
    ),
  );
  return (
    <span className="fallback-control">
      <button
        className="du-btn du-btn-sm"
        disabled={disabled || busy}
        onClick={() => setOpen(!open)}
      >
        <I.fallback size={14} />
        切换备用模型
      </button>
      {open && (
        <span className="fallback-options">
          <select
            className="du-select du-select-sm"
            aria-label="本次备用模型"
            disabled={disabled || busy}
            value=""
            onChange={(e) => {
              const model = JSON.parse(e.target.value) as ModelRef;
              setBusy(true);
              setError("");
              void retry(model)
                .then(() => setOpen(false))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <option value="">选择模型，仅重试本次…</option>
            {available.map((o) => (
              <option key={JSON.stringify(o.ref)} value={JSON.stringify(o.ref)}>
                {o.label}
              </option>
            ))}
          </select>
          {!available.length && (
            <small>请在设置 → 插件中添加共享备用模型。</small>
          )}
          {busy && <Loading small />}
        </span>
      )}
      {error && (
        <small role="alert" className="danger-text">
          {error}
        </small>
      )}
    </span>
  );
}
export function FallbackSettings({
  settings,
  providers,
  save,
}: {
  settings: Settings;
  providers: Provider[];
  save: (s: Settings) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const models = settings.pluginFallbackModels ?? [];
  const persist = async (next: ModelRef[]) => {
    setBusy(true);
    setError("");
    try {
      await save({ ...settings, pluginFallbackModels: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="du-card fallback-settings">
      <h3>
        <I.fallback size={17} />
        共享备用模型
      </h3>
      <p className="muted">
        所有插件和回复摘要共用。失败后手动选择，仅切换本次请求；不自动重试、不更改已保存模型。
      </p>
      <ul className="du-list">
        {models.map((m) => (
          <li className="du-list-row" key={JSON.stringify(m)}>
            <span className="du-list-col-grow">
              {options(providers).find(
                (o) => JSON.stringify(o.ref) === JSON.stringify(m),
              )?.label ?? m.modelId + "（不可用）"}
            </span>
            <button
              className="du-btn du-btn-ghost du-btn-square du-btn-sm"
              aria-label={"移除备用模型 " + m.modelId}
              disabled={busy}
              onClick={() => void persist(models.filter((v) => v !== m))}
            >
              <I.delete size={15} />
            </button>
          </li>
        ))}
      </ul>
      <select
        className="du-select"
        aria-label="添加共享备用模型"
        disabled={busy || models.length >= 16}
        value=""
        onChange={(e) => void persist([...models, JSON.parse(e.target.value)])}
      >
        <option value="">添加备用模型…</option>
        {options(providers)
          .filter(
            (o) =>
              !models.some(
                (m) =>
                  m.providerId === o.ref.providerId &&
                  m.modelId === o.ref.modelId,
              ),
          )
          .map((o) => (
            <option key={JSON.stringify(o.ref)} value={JSON.stringify(o.ref)}>
              {o.label}
            </option>
          ))}
      </select>
      {error && (
        <p className="du-alert du-alert-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
