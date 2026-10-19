import { StyledMarkdown } from "./styled-markdown";
import type { BodyStyles } from "../shared/body-styles";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import { observeJob } from "./job-events";
import { MessageUsage } from "./chat-controls";
import { ParameterControl } from "./controls";
import { useDeviceConnection } from "./device-connection";
import { ActionIcons as I } from "./action-icons";
import {
  defaultComparison,
  type ComparisonConfig,
  type ComparisonRun,
} from "../shared/comparison";
import { type Chat, type Provider, type Message, route } from "../shared/chat";
import type { GenerationStart } from "../shared/direct";

type Snapshot = {
  chat: Chat;
  job: { id: string; transport?: string } | null;
  generation?: GenerationStart;
};
export function ComparisonSettings({
  chat,
  providers,
  save,
  disabled = false,
}: {
  chat: Chat;
  providers: Provider[];
  save: (c: Partial<ComparisonConfig>) => Promise<void>;
  disabled?: boolean;
}) {
  const c = chat.comparison ?? defaultComparison();
  const change = (patch: Partial<ComparisonConfig>) =>
    void save(patch).catch(() => {});
  return (
    <div className="comparison-settings" aria-label="对比设置">
      <label className="toggle">
        双窗口对比
        <input
          aria-label="开启对比"
          className="du-toggle du-toggle-primary du-toggle-sm"
          type="checkbox"
          checked={c.enabled}
          disabled={disabled}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
      </label>
      <label>
        对比模型
        <select
          aria-label="对比模型"
          className="du-select du-select-sm"
          disabled={disabled}
          value={c.model ? JSON.stringify(c.model) : ""}
          onChange={(e) =>
            change({
              model: e.target.value ? JSON.parse(e.target.value) : null,
            })
          }
        >
          <option value="">跟随主窗口</option>
          {providers.flatMap((p) =>
            p.models
              .filter((m) => m.enabled)
              .map((m) => (
                <option
                  key={p.id + m.id}
                  value={JSON.stringify({ providerId: p.id, modelId: m.id })}
                >
                  {p.prefix + m.id}
                </option>
              )),
          )}
        </select>
      </label>
      <label>
        对比上下文
        <select
          aria-label="对比上下文"
          className="du-select du-select-sm"
          disabled={disabled}
          value={c.mode}
          onChange={(e) =>
            change({ mode: e.target.value as ComparisonConfig["mode"] })
          }
        >
          <option value="same">沿用主窗口及本轮工具结果</option>
          <option value="plain">纯净：主 system 与真实 UA，不含任何工具</option>
        </select>
      </label>
      <ParameterControl
        name="对比温度"
        value={c.parameters.temperature}
        max={2}
        step={0.05}
        onChange={(value) => {
          change({ parameters: { temperature: value } });
        }}
      />
      <ParameterControl
        name="对比 Top P"
        value={c.parameters.top_p}
        max={1}
        step={0.05}
        onChange={(value) => {
          change({ parameters: { top_p: value } });
        }}
      />
      <ParameterControl
        name="对比 Top K"
        value={c.parameters.top_k}
        max={100000}
        step={1}
        onChange={(value) => change({ parameters: { top_k: value } })}
      />
      <label>
        对比思考强度
        <select
          aria-label="对比思考强度"
          className="du-select du-select-sm"
          value={c.effort}
          onChange={(e) =>
            change({ effort: e.target.value as ComparisonConfig["effort"] })
          }
        >
          {["inherit", "none", "low", "medium", "high", "max"].map((v) => (
            <option key={v} value={v}>
              {v === "inherit" ? "跟随接口" : v}
            </option>
          ))}
        </select>
      </label>
      <small>
        配置用于下一次主回复。每轮从主窗口独立
        fork，保留分支；不接续之前的对比回答。
      </small>
    </div>
  );
}
export function ComparisonBranches({
  runs,
  open,
}: {
  runs: ComparisonRun[];
  open: (id: string) => void;
}) {
  return (
    <div className="comparison-branches">
      <h3>
        <I.compare size={15} /> 对比分支
      </h3>
      {!runs.length ? (
        <small>开启后每轮在这里保留独立分支。</small>
      ) : (
        runs.map((r, i) => (
          <button
            className="du-btn du-btn-ghost du-btn-sm"
            key={r.chatId}
            onClick={() => open(r.chatId)}
          >
            <I.navigation size={14} />
            {r.title
              ? "对比 · " + r.title
              : "对比 · 分支" + String(i + 1).padStart(2, "0")}
          </button>
        ))
      )}
    </div>
  );
}
export function ComparisonPane({
  run,
  settings,
  open,
  configure,
  bodyStyles,
}: {
  bodyStyles?: BodyStyles;
  run?: ComparisonRun;
  settings: ReactNode;
  open: (id: string) => void;
  configure: () => void;
}) {
  const connection = useDeviceConnection(),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const callbacks = useRef({ connection });
  callbacks.current = { connection };
  const activeId = useRef(run?.chatId);
  activeId.current = run?.chatId;
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const refresh = useCallback(async () => {
    if (!run) return;
    const result = await api<Snapshot>("/chats/" + run.chatId);
    if (activeId.current !== run.chatId) return;
    setSnapshot({
      ...result,
      chat: callbacks.current.connection.overlay(result.chat),
    });
    const direct = result.generation?.direct;
    if (direct)
      callbacks.current.connection.start(
        direct,
        (task, output) =>
          setSnapshot((old) =>
            !old || old.chat.id !== task.chatId
              ? old
              : {
                  ...old,
                  chat: {
                    ...old.chat,
                    messages: {
                      ...old.chat.messages,
                      [task.messageId]: {
                        ...old.chat.messages[task.messageId]!,
                        ...output,
                        status: "running",
                      },
                    },
                  },
                },
          ),
        () => void refresh().catch((e) => setError(e.message)),
      );
  }, [run?.chatId]);
  useEffect(() => {
    setSnapshot(null);
    setError("");
    follow.current = true;
    let active = true;
    void refresh().catch((e) => {
      if (active) setError(e.message);
    });
    const visible = () => {
      if (document.visibilityState === "visible")
        void refresh().catch((e) => setError(e.message));
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const job = snapshot?.job;
  useEffect(() => {
    if (!job || job.transport === "device") return;
    return observeJob(
      job.id,
      false,
      (content, reasoning) =>
        setSnapshot((old) => {
          if (!old) return old;
          const m = Object.values(old.chat.messages).find(
            (m) => m.status === "running",
          );
          return m
            ? {
                ...old,
                chat: {
                  ...old.chat,
                  messages: {
                    ...old.chat.messages,
                    [m.id]: { ...m, content, reasoning },
                  },
                },
              }
            : old;
        }),
      () => void refresh().catch((e) => setError(e.message)),
      () => void refresh().catch((e) => setError(e.message)),
    );
  }, [job?.id, job?.transport, refresh]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot?.chat.messages]);
  const answer = snapshot ? route(snapshot.chat).at(-1) : undefined;
  const prompt = snapshot
    ? route(snapshot.chat).findLast((m) => m.role === "user")
    : undefined;
  return (
    <section className="comparison-pane" aria-label="对比窗口">
      <div className="comparison-heading">
        <strong>
          <I.compare size={16} /> 对比窗口
        </strong>
        <button className="du-btn du-btn-ghost du-btn-xs" onClick={configure}>
          <I.settings size={14} />
          设置
        </button>
        {run && (
          <button
            className="du-btn du-btn-ghost du-btn-xs"
            onClick={() => open(run.chatId)}
          >
            <I.navigation size={14} />
            打开分支
          </button>
        )}
      </div>
      <details className="comparison-inline-settings">
        <summary>
          <I.settings size={14} />
          模型与参数
        </summary>
        {settings}
      </details>
      <div
        className="comparison-messages"
        ref={scroll}
        onWheel={(e) => {
          if (e.deltaY < 0) follow.current = false;
        }}
        onScroll={(e) => {
          const n = e.currentTarget;
          if (n.scrollHeight - n.scrollTop - n.clientHeight < 15)
            follow.current = true;
        }}
      >
        {error && (
          <p role="alert">
            {error}
            <button
              className="du-btn du-btn-xs"
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              <I.context size={14} />
              刷新
            </button>
          </p>
        )}
        {!run && (
          <p className="muted">
            下一次主回复开始时，将从当前主窗口创建独立对比分支。
          </p>
        )}
        {prompt && (
          <div className="comparison-prompt">
            <Markdown>{prompt.content}</Markdown>
          </div>
        )}
        {answer?.role === "assistant" && (
          <article className="comparison-answer">
            <div className="markdown">
              <StyledMarkdown config={bodyStyles ?? snapshot?.chat.bodyStyles} tagged={!!answer.styleTagged}>
                {answer.content ||
                  (answer.status === "running" ? "正在生成…" : "（空回答）")}
              </StyledMarkdown>
            </div>
            {answer.reasoning && (
              <details>
                <summary>思考</summary>
                <p>{answer.reasoning}</p>
              </details>
            )}
            {answer.error && <p role="alert">{answer.error}</p>}
            <MessageUsage message={answer as Message} />
          </article>
        )}
      </div>
      {run && connection.unsaved(run.chatId) && (
        <button
          className="du-btn du-btn-primary du-btn-sm"
          onClick={() =>
            void connection
              .retrySave(run.chatId)
              .then(refresh)
              .catch((e) => setError(e.message))
          }
        >
          <I.save size={14} /> 重试保存对比回答
        </button>
      )}
      {job && (
        <button
          className="du-btn du-btn-sm comparison-stop"
          onClick={() =>
            void (async () => {
              if (!connection.stop(snapshot!.chat.id))
                await api("/chats/" + snapshot!.chat.id + "/stop", "POST", {});
              await refresh();
            })().catch((e) => setError(e.message))
          }
        >
          <I.cancel size={14} />
          停止对比
        </button>
      )}
    </section>
  );
}
