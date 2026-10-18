import { ActionIcons as I } from "./action-icons";
import { recordCacheRequest } from "./cache-usage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { deviceMode, setDeviceMode } from "./device-mode";
import { useDialogFocus } from "./controls";
import type { DirectTask, DirectTitleTask } from "../shared/direct";
import {
  type CompletionOutput,
  readCompletion,
  readResponseText,
  redactUpstreamError,
} from "../shared/completion";
import { extractTitle } from "../shared/title-template";
import type { Chat } from "../shared/chat";
import type { PluginJobView, PluginState } from "../shared/plugins";

type ProviderIdentity = {
  providerId: string;
  baseUrl: string;
  hasKey: boolean;
};
type Active = {
  task: DirectTask;
  output: CompletionOutput;
  controller: AbortController;
  status: "running" | "complete" | "error" | "stopped";
  save?: () => Promise<void>;
};
type Connection = {
  startPlugin: (
    task: PluginJobView,
    update: (output: CompletionOutput) => void,
    finished: (error?: string) => void,
  ) => void;
  stopPlugin: (id: string) => boolean;
  retryPluginSave: (id: string) => Promise<void>;
  pluginOverlay: (state: PluginState) => PluginState;
  pluginUnsaved: (id: string) => boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  lock: () => void;
  key: (provider: ProviderIdentity) => Promise<string>;
  remember: (providerId: string, baseUrl: string, key: string) => void;
  output: (jobId: string) => CompletionOutput | undefined;
  overlay: (chat: Chat) => Chat;
  unsaved: (chatId: string) => boolean;
  retrySave: (chatId: string) => Promise<void>;
  stop: (chatId: string) => boolean;
  start: (
    task: DirectTask,
    update: (task: DirectTask, output: CompletionOutput) => void,
    finish: (error?: string) => void,
  ) => void;
  title: (id: string, finish: (error?: string) => void) => void;
};
const Context = createContext<Connection | null>(null);
export const useDeviceConnection = () => useContext(Context)!;

export async function directFetch(
  baseUrl: string,
  path: string,
  key: string,
  body: unknown,
  signal: AbortSignal,
) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("设备直连必须使用 HTTPS");
  try {
    return await fetch(baseUrl.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw Error(
      "设备直连失败：请检查网络与上游 CORS 跨域许可。不会自动切换服务端或重复发送。",
    );
  }
}
export async function directModels(baseUrl: string, key: string) {
  const signal = AbortSignal.timeout(20000);
  const response = await directFetch(
    baseUrl,
    "/models",
    key,
    undefined,
    signal,
  );
  const text = await readResponseText(response, signal, 2 * 1024 * 1024);
  if (!response.ok)
    throw Error(
      `获取模型失败 HTTP ${response.status}：${redactUpstreamError(text, key)}`,
    );
  let data: unknown;
  try {
    data = JSON.parse(text).data;
  } catch {
    throw Error("上游模型列表不是有效 JSON");
  }
  if (
    !Array.isArray(data) ||
    data.length > 10000 ||
    data.some((item) => typeof item?.id !== "string")
  )
    throw Error("上游模型列表格式无效");
  return data.map((item) => ({ id: item.id as string }));
}

export function DeviceConnectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [enabled, setEnabledState] = useState(deviceMode);
  const vault = useRef(new Map<string, string>()),
    active = useRef(new Map<string, Active>()),
    titles = useRef(new Set<string>()),
    titleControllers = useRef(new Map<string, AbortController>());
  const [, rerender] = useState(0),
    epoch = useRef(0);
  const pluginActive = useRef(
    new Map<
      string,
      {
        task: PluginJobView;
        output: CompletionOutput;
        controller: AbortController;
        save?: () => Promise<void>;
      }
    >(),
  );
  const [prompt, setPrompt] = useState<{
    identity: ProviderIdentity;
    resolve: (key: string) => void;
    reject: (error: Error) => void;
    token: number;
  } | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const serial = useRef(Promise.resolve()),
    token = useRef(0);
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const cancelPrompt = () => {
    const current = promptRef.current;
    promptRef.current = null;
    token.current++;
    setPrompt(null);
    setPassword("");
    current?.reject(Error("已取消设备直连密钥解锁"));
  };
  useDialogFocus(dialog, cancelPrompt, !!prompt);
  const identityKey = (identity: ProviderIdentity) =>
    identity.providerId + "@" + identity.baseUrl;
  const key = useCallback(async (identity: ProviderIdentity) => {
    const requestedEpoch = epoch.current;
    if (!identity.hasKey) return "";
    const cached = vault.current.get(identityKey(identity));
    if (cached !== undefined) return cached;
    let release!: () => void;
    const previous = serial.current;
    serial.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (requestedEpoch !== epoch.current) throw Error("设备密钥已锁定");
      const existing = vault.current.get(identityKey(identity));
      if (existing !== undefined) return existing;
      return await new Promise<string>((resolve, reject) => {
        setError("");
        setPassword("");
        setPrompt({ identity, resolve, reject, token: ++token.current });
      });
    } finally {
      release();
    }
  }, []);
  const lock = useCallback(() => {
    epoch.current++;
    const current = promptRef.current;
    promptRef.current = null;
    token.current++;
    setPrompt(null);
    setPassword("");
    current?.reject(Error("设备密钥已锁定"));
    vault.current.clear();
    for (const running of active.current.values()) running.controller.abort();
    for (const controller of titleControllers.current.values())
      controller.abort();
    for (const item of pluginActive.current.values()) item.controller.abort();
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", lock);
    return () => window.removeEventListener("pagehide", lock);
  }, [lock]);
  const start: Connection["start"] = (task, update, finished) => {
    if (active.current.has(task.jobId)) return;
    const entry: Active = {
      task,
      output: { content: task.seedContent, reasoning: "" },
      controller: new AbortController(),
      status: "running",
    };
    active.current.set(task.jobId, entry);
    void (async () => {
      let apiKey = "",
        sequence = 0,
        saving: Promise<void> | null = null,
        dirty = false,
        paint: ReturnType<typeof setTimeout> | undefined;
      const publish = () => {
        if (!paint)
          paint = setTimeout(() => {
            paint = undefined;
            update(task, { ...entry.output });
          }, 50);
      };
      const checkpoint = () => {
        dirty = true;
        if (saving) return saving;
        saving = (async () => {
          while (dirty) {
            dirty = false;
            await api(
              "/device/jobs/" + task.jobId + "/checkpoint",
              "POST",
              { ...entry.output, sequence: ++sequence },
              { signal: AbortSignal.timeout(15000) },
            );
          }
        })().finally(() => {
          saving = null;
        });
        return saving;
      };
      const pendingSave = () => saving ?? Promise.resolve();
      let failure: string | undefined,
        status: "complete" | "error" | "stopped" = "complete";
      const heartbeat = setInterval(() => {
        void checkpoint().catch((error) => {
          if (/任务已(结束|停止)/.test(error.message)) entry.controller.abort();
        });
      }, 10000);
      try {
        apiKey = await key(task);
        entry.controller.signal.throwIfAborted();
        const signal = AbortSignal.any([
          entry.controller.signal,
          AbortSignal.timeout(30 * 60 * 1000),
        ]);
        if (typeof task.request.model === "string")
          recordCacheRequest(
            task.messageId,
            { providerId: task.providerId, modelId: task.request.model },
            { ...task.request, model: task.request.model },
          );
        const response = await directFetch(
          task.baseUrl,
          "/chat/completions",
          apiKey,
          task.request,
          signal,
        );
        await readCompletion(
          response,
          task.request.stream === true,
          signal,
          entry.output,
          publish,
        );
      } catch (error) {
        status = entry.controller.signal.aborted ? "stopped" : "error";
        failure =
          status === "stopped"
            ? undefined
            : redactUpstreamError(
                error instanceof Error ? error.message : "设备直连失败",
                apiKey,
              );
      } finally {
        clearInterval(heartbeat);
        if (paint) clearTimeout(paint);
        update(task, { ...entry.output });
        await pendingSave().catch(() => {});
        entry.status = status;
        const finalError = failure;
        entry.save = async () => {
          const saved = await api<{ titleJobId?: string }>(
            "/device/jobs/" + task.jobId + "/finish",
            "POST",
            {
              ...entry.output,
              sequence: ++sequence,
              status,
              error: finalError,
            },
            { signal: AbortSignal.timeout(15000) },
          );
          active.current.delete(task.jobId);
          rerender((n) => n + 1);
          if (saved.titleJobId) title(saved.titleJobId, finished);
        };
        try {
          await entry.save();
        } catch (error) {
          if (error instanceof Error && /任务已/.test(error.message)) {
            active.current.delete(task.jobId);
          } else {
            failure = "回答云端保存失败，文字保留在当前页面，请重试保存。";
            rerender((n) => n + 1);
          }
        }
        finished(failure);
      }
    })();
  };
  const title: Connection["title"] = (id, finished) => {
    if (titles.current.has(id)) return;
    titles.current.add(id);
    const controller = new AbortController();
    titleControllers.current.set(id, controller);
    void (async () => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const task = await api<DirectTitleTask | null>(
          "/device/titles/" + id + "/claim",
          "POST",
          {},
        );
        if (!task) return;
        heartbeat = setInterval(() => {
          void api("/device/titles/" + id + "/finish", "POST", {
            heartbeat: true,
          }).catch(() => {});
        }, 30000);
        let result = "",
          error = "没有可用的标题模型";
        for (const candidate of task.candidates) {
          let apiKey = "";
          try {
            apiKey = await key(candidate);
            controller.signal.throwIfAborted();
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(120000),
            ]);
            const response = await directFetch(
              candidate.baseUrl,
              "/chat/completions",
              apiKey,
              candidate.request,
              signal,
            );
            const output: CompletionOutput = { content: "", reasoning: "" };
            await readCompletion(response, false, signal, output, () => {});
            extractTitle(output.content);
            result = output.content;
            break;
          } catch (failure) {
            error = redactUpstreamError(
              failure instanceof Error ? failure.message : "标题生成失败",
              apiKey,
            );
            if (controller.signal.aborted) break;
          }
        }
        await api(
          "/device/titles/" + id + "/finish",
          "POST",
          result ? { content: result } : { error },
        );
        finished();
      } catch (error) {
        finished(error instanceof Error ? error.message : "标题保存失败");
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        titleControllers.current.delete(id);
      }
    })();
  };
  const connection: Connection = {
    startPlugin: (task, update, finished) => {
      if (!task.direct || pluginActive.current.has(task.id)) return;
      const direct = task.direct,
        entry = {
          task,
          output: { content: "", reasoning: "" } as CompletionOutput,
          controller: new AbortController(),
          save: undefined as (() => Promise<void>) | undefined,
        };
      pluginActive.current.set(task.id, entry);
      void (async () => {
        let sequence = 0,
          apiKey = "",
          saving = Promise.resolve(),
          status: "complete" | "error" | "stopped" = "complete",
          failure: string | undefined;
        const checkpoint = () => {
          saving = saving
            .catch(() => {})
            .then(async () => {
              await api(
                "/plugins/jobs/" + task.id + "/checkpoint",
                "POST",
                { ...entry.output, sequence: ++sequence },
                { signal: AbortSignal.timeout(15000) },
              );
            });
          return saving;
        };
        const timer = setInterval(
          () => void checkpoint().catch(() => {}),
          10000,
        );
        try {
          apiKey = await key(direct);
          const signal = AbortSignal.any([
            entry.controller.signal,
            AbortSignal.timeout(30 * 60 * 1000),
          ]);
          recordCacheRequest(
            task.id,
            { providerId: direct.providerId, modelId: direct.request.model },
            direct.request,
          );
          const response = await directFetch(
            direct.baseUrl,
            "/chat/completions",
            apiKey,
            direct.request,
            signal,
          );
          let last = 0;
          await readCompletion(
            response,
            direct.request.stream,
            signal,
            entry.output,
            () => {
              if (Date.now() - last > 60) {
                last = Date.now();
                update({ ...entry.output });
              }
            },
          );
        } catch (error) {
          status = entry.controller.signal.aborted ? "stopped" : "error";
          failure = redactUpstreamError(
            error instanceof Error ? error.message : "插件直连失败",
            apiKey,
          );
        } finally {
          clearInterval(timer);
          update({ ...entry.output });
          await saving.catch(() => {});
          entry.save = async () => {
            await api(
              "/plugins/jobs/" + task.id + "/finish",
              "POST",
              { ...entry.output, sequence: ++sequence, status, error: failure },
              { signal: AbortSignal.timeout(15000) },
            );
            pluginActive.current.delete(task.id);
            rerender((n) => n + 1);
          };
          try {
            await entry.save();
            finished();
          } catch {
            rerender((n) => n + 1);
            finished("插件结果保存失败，保留在此页面，可重试保存。");
          }
        }
      })();
    },
    stopPlugin: (id) => {
      const active = pluginActive.current.get(id);
      if (!active) return false;
      active.controller.abort();
      return true;
    },
    retryPluginSave: async (id) => {
      const entry = pluginActive.current.get(id);
      if (entry?.save) await entry.save();
    },
    pluginUnsaved: (id) => !!pluginActive.current.get(id)?.save,
    pluginOverlay: (state) => ({
      ...state,
      runs: state.runs.map((run) => {
        const active = pluginActive.current.get(run.id);
        return active ? { ...run, output: active.output.content } : run;
      }),
    }),
    enabled,
    setEnabled: (value) => {
      setEnabledState(value);
      setDeviceMode(value);
      if (!value) vault.current.clear();
    },
    lock,
    key,
    remember: (providerId, baseUrl, value) =>
      vault.current.set(
        identityKey({ providerId, baseUrl, hasKey: true }),
        value,
      ),
    output: (id) => active.current.get(id)?.output,
    overlay: (chat) => {
      for (const item of active.current.values())
        if (item.task.chatId === chat.id && chat.messages[item.task.messageId])
          Object.assign(chat.messages[item.task.messageId]!, item.output, {
            status: item.status,
          });
      return chat;
    },
    unsaved: (chatId) =>
      [...active.current.values()].some(
        (item) => item.task.chatId === chatId && item.status !== "running",
      ),
    retrySave: async (chatId) => {
      for (const item of active.current.values())
        if (item.task.chatId === chatId && item.save) await item.save();
    },
    stop: (chatId) => {
      let found = false;
      for (const item of active.current.values())
        if (item.task.chatId === chatId && item.status === "running") {
          found = true;
          item.controller.abort();
          const current = promptRef.current;
          if (current?.identity.providerId === item.task.providerId)
            cancelPrompt();
        }
      return found;
    },
    start,
    title,
  };
  return (
    <Context.Provider value={connection}>
      {children}
      {prompt && (
        <div className="modal-backdrop" onClick={cancelPrompt}>
          <section
            className="modal key-modal"
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="解锁设备直连"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>解锁设备直连</h2>
            <p className="muted">
              验证访问密码后，此页面可直接请求所选服务商。API Key
              只临时保留在页面内存。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const current = prompt;
                const value = password;
                setPassword("");
                setChecking(true);
                void api<{ apiKey: string }>(
                  "/providers/" + current.identity.providerId + "/key",
                  "POST",
                  { password: value },
                )
                  .then((response) => {
                    if (current.token !== token.current) return;
                    vault.current.set(
                      identityKey(current.identity),
                      response.apiKey,
                    );
                    current.resolve(response.apiKey);
                    setPrompt(null);
                  })
                  .catch((error) => {
                    if (current.token === token.current)
                      setError(error.message);
                  })
                  .finally(() => setChecking(false));
              }}
            >
              <label>
                访问密码
                <input
                  className="du-input du-input-sm"
                  aria-label="直连验证密码"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="danger-text">
                  {error}
                </p>
              )}
              <button type="button" onClick={cancelPrompt}>
                <I.cancel size={15} />
                取消
              </button>
              <button className="primary" disabled={checking || !password}>
                <I.connect size={15} />
                {checking ? "验证中…" : "验证并连接"}
              </button>
            </form>
          </section>
        </div>
      )}
    </Context.Provider>
  );
}
