import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  Settings2,
  PanelLeft,
  SlidersHorizontal,
  ArrowUp,
  Square,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Copy,
  Check,
  X,
  Expand,
  GitBranch,
  ArrowDown,
  RotateCcw,
  Archive,
  Trash2,
  Folder,
  Download,
  Upload,
  Eye,
  LogOut,
  LoaderCircle,
  Pencil,
  Sun,
  Moon,
  Search,
  CircleAlert,
  FileText,
  Info,
  ArrowRight,
  MessageSquareOff,
  MessageSquarePlus,
  Palette,
  UserRound,
  Pin,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type Chat,
  type Message,
  type Provider,
  type Settings,
  type ModelRef,
  route,
  indexChildren,
  contextTurns,
  markdownExport,
  estimateTokens,
  contextMessages,
  defaultSettings,
} from "../shared/chat";
import { api, download } from "./api";
import "./style.css";
import { IconButton, ParameterControl, useDialogFocus } from "./controls";
import { ModelControls, TemplatePicker, MessageUsage } from "./chat-controls";
import { SettingsTools, KeyReveal } from "./settings-tools";
import { ImportDialog } from "./import-dialog";
import {
  DeviceConnectionProvider,
  useDeviceConnection,
  directModels,
} from "./device-connection";
import type { GenerationStart } from "../shared/direct";
import type { CompletionOutput } from "../shared/completion";
import type { DirectTask } from "../shared/direct";
import { ChatListMenu } from "./chat-list-menu";
import { ContextUsage, EffortControl, AccountMenu } from "./composer-widgets";
const BranchOverview = lazy(() => import("./branch-overview"));
type Brief = Pick<
  Chat,
  | "id"
  | "title"
  | "pinned"
  | "groupId"
  | "archived"
  | "deleted"
  | "unread"
  | "updatedAt"
> & { status?: string };
type Group = { id: string; name: string; updatedAt: number };
type ProviderView = Provider & { hasKey: boolean };
// A phone remains a touch device after rotating past the layout breakpoint.
function desktopInput() {
  return (
    innerWidth > 760 && matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}
function App() {
  const connection = useDeviceConnection();
  const [auth, setAuth] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState(false),
    [initializing, setInitializing] = useState(true);
  const [chats, setChats] = useState<Brief[]>([]),
    [groups, setGroups] = useState<Group[]>([]),
    [chat, setChat] = useState<Chat | null>(null),
    [job, setJob] = useState<{
      id: string;
      status: string;
      transport?: "device";
    } | null>(null),
    [titleJob, setTitleJob] = useState<{
      id: string;
      status: string;
      error: string | null;
      transport?: "device";
    } | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]),
    [settings, setSettings] = useState<Settings>(defaultSettings());
  const [draft, setDraft] = useState(""),
    [sidebar, setSidebar] = useState(innerWidth > 760),
    [panel, setPanel] = useState(false),
    [panelTab, setPanelTab] = useState("settings"),
    [modal, setModal] = useState(""),
    [modelMenu, setModelMenu] = useState(false),
    [search, setSearch] = useState(""),
    [view, setView] = useState("active");
  const [menu, setMenu] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false),
    [editing, setEditing] = useState<{ id: string; content: string } | null>(
      null,
    ),
    [groupMenu, setGroupMenu] = useState<string | null>(null),
    [scrollBottom, setScrollBottom] = useState(false);
  const [settingsTab, setSettingsTab] = useState("providers");
  const [appearance, setAppearance] = useState(() => readAppearance());
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => setModal(""), !!modal);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.min(
      420,
      Math.max(190, Number(localStorage.getItem("sidebarWidth")) || 264),
    ),
  );
  useEffect(
    () => localStorage.setItem("sidebarWidth", String(sidebarWidth)),
    [sidebarWidth],
  );
  const longPress = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  useEffect(() => () => cancelLongPress(), []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".message")) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const navigationSeq = useRef(0);
  const draftQueue = useRef<Promise<void>>(Promise.resolve()),
    activeSend = useRef<Promise<void> | null>(null),
    creating = useRef<Promise<void> | null>(null),
    submitting = useRef(false),
    draftVersion = useRef(0);
  const idRef = useRef<string | null>(null),
    dirty = useRef(false),
    draftRef = useRef(""),
    scrollRef = useRef<HTMLDivElement>(null),
    stick = useRef(true),
    textarea = useRef<HTMLTextAreaElement>(null),
    fileRef = useRef<HTMLInputElement>(null),
    [pendingImport, setPendingImport] = useState<{
      data: unknown;
      preview: {
        count: number;
        branches: number;
        attachments: number;
        failures: { index: number; reason: string }[];
      };
    } | null>(null);
  const run = useCallback(
    async (fn: () => Promise<void>, clearError = true) => {
      try {
        if (clearError) setError("");
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败");
      }
    },
    [],
  );
  const loadNavigation = useCallback(async () => {
    const [c, g] = await Promise.all([
      api<Brief[]>("/chats"),
      api<Group[]>("/groups"),
    ]);
    setChats(c);
    setChat((previous) => {
      const current = c.find((item) => item.id === previous?.id);
      return previous && current
        ? { ...previous, title: current.title }
        : previous;
    });
    setGroups(g);
  }, []);
  const loadConfig = useCallback(async () => {
    const [p, s] = await Promise.all([
      api<ProviderView[]>("/providers"),
      api<Settings>("/settings"),
    ]);
    setProviders(p);
    setSettings(s);
  }, []);
  const refresh = useCallback(async (id = idRef.current) => {
    if (!id) return;
    const result = await api<{
      chat: Chat;
      job: typeof job;
      titleJob: typeof titleJob;
    }>("/chats/" + id);
    if (idRef.current !== id) return;
    setChat(connection.overlay(result.chat));
    setJob(result.job);
    setTitleJob(result.titleJob ?? null);
    if (
      !result.job &&
      result.chat.unread &&
      document.visibilityState === "visible"
    ) {
      await api("/chats/" + id + "/seen", "POST", {});
      setChat((previous) =>
        previous?.id === id ? { ...previous, unread: false } : previous,
      );
    }
  }, []);
  function saveDraft(id: string, value: string) {
    const write = draftQueue.current
      .catch(() => {})
      .then(async () => {
        await api("/chats/" + id + "/draft", "PUT", { draft: value });
      });
    draftQueue.current = write;
    return write;
  }
  async function flushDraft() {
    if (submitting.current) return;
    if (!idRef.current && dirty.current && draftRef.current.trim())
      await ensureComposerChat();
    const id = idRef.current;
    if (id && dirty.current) {
      const saved = draftRef.current,
        version = draftVersion.current;
      await saveDraft(id, saved);
      if (draftVersion.current === version && idRef.current === id)
        dirty.current = false;
    }
  }
  async function open(id: string) {
    const sequence = ++navigationSeq.current;
    setOpening(true);
    try {
      await activeSend.current?.catch(() => {});
      await creating.current?.catch(() => {});
      if (sequence !== navigationSeq.current) return;
      await flushDraft();
      const result = await api<{
        chat: Chat;
        job: typeof job;
        titleJob: typeof titleJob;
      }>("/chats/" + id);
      if (sequence !== navigationSeq.current) return;
      idRef.current = id;
      localStorage.setItem("lastChat", id);
      setChat(result.chat);
      setJob(result.job);
      setTitleJob(result.titleJob ?? null);
      setMenu(null);
      setEditing(null);
      setModelMenu(false);
      cancelLongPress();
      setDraft(result.chat.draft);
      draftRef.current = result.chat.draft;
      draftVersion.current++;
      dirty.current = false;
      stick.current = true;
      if (result.chat.unread && document.visibilityState === "visible") {
        await api("/chats/" + id + "/seen", "POST", {});
        await loadNavigation();
      }
      if (innerWidth <= 760) setSidebar(false);
    } finally {
      if (sequence === navigationSeq.current) setOpening(false);
    }
  }
  async function create(groupId: string | null = null) {
    const sequence = ++navigationSeq.current;
    setOpening(true);
    try {
      await activeSend.current?.catch(() => {});
      await creating.current?.catch(() => {});
      if (sequence !== navigationSeq.current) return;
      await flushDraft();
      const c = await api<Chat>("/chats", "POST", { groupId });
      await loadNavigation();
      if (sequence === navigationSeq.current) await open(c.id);
    } finally {
      if (sequence === navigationSeq.current) setOpening(false);
    }
  }
  async function ensureComposerChat() {
    if (idRef.current) return;
    if (creating.current) return creating.current;
    const task = (async () => {
      const created = await api<Chat>("/chats", "POST", {});
      idRef.current = created.id;
      setChat(created);
      localStorage.setItem("lastChat", created.id);
      if (draftRef.current) {
        const value = draftRef.current,
          version = draftVersion.current;
        await saveDraft(created.id, value);
        if (version === draftVersion.current && idRef.current === created.id)
          dirty.current = false;
      }
      await loadNavigation();
    })();
    creating.current = task;
    try {
      await task;
    } finally {
      if (creating.current === task) creating.current = null;
    }
  }
  useEffect(() => {
    void run(async () => {
      const s = await api<{ authenticated: boolean }>("/auth/status");
      setAuth(s.authenticated);
    });
  }, [run]);
  useEffect(() => {
    if (!auth) return;
    setInitializing(true);
    void run(async () => {
      try {
        await Promise.all([loadNavigation(), loadConfig()]);
        const id = localStorage.getItem("lastChat");
        if (id)
          try {
            await open(id);
          } catch {
            localStorage.removeItem("lastChat");
          }
      } finally {
        setInitializing(false);
      }
    });
  }, [auth]);
  useEffect(() => {
    if (auth === false) connection.lock();
  }, [auth]);
  useEffect(() => {
    if (
      auth &&
      titleJob?.transport === "device" &&
      titleJob.status === "pending"
    )
      connection.title(titleJob.id, (error) => {
        if (error) setError(error);
        void run(async () => {
          await refresh();
          await loadNavigation();
        }, false);
      });
  }, [auth, titleJob?.id, titleJob?.status]);
  useEffect(() => {
    localStorage.setItem("appearance", JSON.stringify(appearance));
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        appearance.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : appearance.theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    if (!dirty.current) return;
    const timeout = setTimeout(() => void run(flushDraft), 700);
    return () => clearTimeout(timeout);
  }, [draft]);
  useEffect(() => {
    if (!auth) return;
    const timer = setInterval(
      () =>
        void run(async () => {
          if (job || ["pending", "running"].includes(titleJob?.status ?? ""))
            await refresh();
          await loadNavigation();
        }, false),
      job || ["pending", "running"].includes(titleJob?.status ?? "")
        ? 1500
        : 6000,
    );
    return () => clearInterval(timer);
  }, [
    auth,
    job?.id,
    titleJob?.id,
    titleJob?.status,
    run,
    refresh,
    loadNavigation,
  ]);
  useEffect(() => {
    if (!auth) return;
    const activate = () => {
      if (document.visibilityState !== "visible") return;
      void run(async () => {
        await refresh();
        await loadNavigation();
      }, false);
    };
    document.addEventListener("visibilitychange", activate);
    return () => document.removeEventListener("visibilitychange", activate);
  }, [auth, run, refresh, loadNavigation]);
  useEffect(() => {
    if (stick.current)
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "instant",
      });
  }, [chat?.messages, draft, chat?.id]);
  async function patch(
    value: Partial<Omit<Chat, "rounds">> & { rounds?: number | null },
  ) {
    if (!chat) return;
    await flushDraft();
    await api("/chats/" + chat.id, "PATCH", value);
    await refresh();
    await loadNavigation();
  }
  function acceptGeneration(result: GenerationStart) {
    if (!result.direct) return;
    const task = result.direct;
    connection.start(
      task,
      (active: DirectTask, output: CompletionOutput) => {
        setChat((previous) =>
          !previous ||
          previous.id !== active.chatId ||
          !previous.messages[active.messageId]
            ? previous
            : {
                ...previous,
                messages: {
                  ...previous.messages,
                  [active.messageId]: {
                    ...previous.messages[active.messageId]!,
                    ...output,
                    status: "running",
                  },
                },
              },
        );
      },
      (error) => {
        if (error) setError(error);
        void run(async () => {
          await refresh(task.chatId);
          await loadNavigation();
        }, false);
      },
    );
  }
  async function action(name: string, body: Record<string, unknown> = {}) {
    if (!chat) return;
    if (name === "stop" && connection.stop(chat.id)) return;
    await flushDraft();
    const result = await api<Chat & GenerationStart>(
      "/chats/" + chat.id + "/" + name,
      "POST",
      body,
    );
    if (["regenerate", "retry", "continue", "edit"].includes(name))
      acceptGeneration(result);
    setMenu(null);
    if (name === "fork") {
      await loadNavigation();
      await open(result.id);
    } else {
      await refresh();
      await loadNavigation();
    }
  }
  async function send() {
    if (
      !selectedModel ||
      submitting.current ||
      job ||
      opening ||
      initializing ||
      !draftRef.current.trim()
    )
      return;
    submitting.current = true;
    const sent = draftRef.current,
      version = draftVersion.current;
    setBusy(true);
    const task = (async () => {
      await ensureComposerChat();
      const id = idRef.current!;
      // Drain older saves before the server atomically clears the sent draft.
      // Autosaves pause while submitting, then persist any newer input.
      await draftQueue.current.catch(() => {});
      const result = await api<GenerationStart>(
        "/chats/" + id + "/send",
        "POST",
        { content: sent },
      );
      acceptGeneration(result);
      if (draftVersion.current === version && idRef.current === id) {
        setDraft("");
        draftRef.current = "";
        draftVersion.current++;
        dirty.current = false;
      } else dirty.current = true;
      stick.current = true;
      await refresh(id);
      await loadNavigation();
    })();
    activeSend.current = task;
    try {
      await task;
    } finally {
      submitting.current = false;
      activeSend.current = null;
      setBusy(false);
      await flushDraft();
    }
  }
  const models = providers.flatMap((p) =>
    p.models.map((m) => ({
      ...m,
      provider: p,
      ref: { providerId: p.id, modelId: m.id },
    })),
  );
  const current = chat?.model ?? settings.defaultModel,
    selectedModel =
      models.find(
        (m) =>
          m.ref.providerId === current?.providerId && m.id === current.modelId,
      ) ??
      models.find(
        (m) =>
          m.provider.id === settings.defaultModel?.providerId &&
          m.id === settings.defaultModel.modelId,
      );
  const filteredModels = models.filter(
    (m) =>
      m.enabled &&
      `${m.id} ${m.provider.prefix} ${m.provider.name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const path = useMemo(() => (chat ? route(chat) : []), [chat]);
  const excludedIds = useMemo(
    () =>
      new Set(
        chat
          ? contextTurns(chat)
              .filter((turn) => turn.some((m) => m.excluded))
              .flat()
              .map((m) => m.id)
          : [],
      ),
    [chat],
  );
  const byParent = useMemo(
    () => (chat ? indexChildren(chat) : new Map<string | null, Message[]>()),
    [chat?.messages],
  );
  const depths = useMemo(() => {
    const result = new Map<string, number>(),
      pending = (byParent.get(null) ?? []).map((m) => ({ id: m.id, depth: 1 }));
    while (pending.length) {
      const next = pending.pop()!;
      if (result.has(next.id)) continue;
      result.set(next.id, next.depth);
      for (const child of byParent.get(next.id) ?? [])
        pending.push({ id: child.id, depth: next.depth + 1 });
    }
    return result;
  }, [byParent]);
  const pathIds = new Set(path.map((m) => m.id)),
    lastAssistant = path.filter((m) => m.role === "assistant").at(-1)?.id;
  const estimate = estimateTokens(
      chat
        ? contextMessages(chat, draft)
            .map((m) => m.content)
            .join("\n")
        : draft,
    ),
    capacity = selectedModel?.capacity ?? 1048576;
  const filteredChats = chats.filter((c) =>
    view === "trash"
      ? c.deleted
      : view === "archive"
        ? c.archived && !c.deleted
        : !c.archived && !c.deleted,
  );
  const sorted = (items: Brief[]) =>
    [...items].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
  function updateDraft(value: string) {
    draftVersion.current++;
    setDraft(value);
    draftRef.current = value;
    dirty.current = true;
  }
  function showSettings(tab = "providers") {
    setSettingsTab(tab);
    setModal("settings");
  }
  function downloadChats(ids: string[]) {
    return run(async () => {
      const values = await Promise.all(
        ids.map((id) => api("/chats/" + id + "/export")),
      );
      download("在线AI-chats.json", JSON.stringify(values, null, 2));
    });
  }
  async function listAction(c: Brief, name: string) {
    if (name === "export") {
      await downloadChats([c.id]);
      return;
    }
    if (name === "rename") {
      const title = prompt("重命名聊天", c.title);
      if (!title) return;
      await api("/chats/" + c.id, "PATCH", { title });
    } else if (name === "title") {
      const result = await api<{ jobId: string }>(
        "/chats/" + c.id + "/title",
        "POST",
        {},
      );
      connection.title(result.jobId, (error) => {
        if (error) setError(error);
        void run(loadNavigation, false);
      });
    } else if (name === "duplicate") {
      const copy = await api<Chat>("/chats/" + c.id + "/duplicate", "POST", {});
      await loadNavigation();
      await open(copy.id);
      return;
    } else if (name === "delete" && c.deleted) {
      if (!confirm("永久删除这个聊天？无法恢复。")) return;
      await api("/chats/" + c.id + "/permanent", "DELETE", {});
      if (idRef.current === c.id) {
        idRef.current = null;
        setChat(null);
        localStorage.removeItem("lastChat");
      }
    } else
      await api(
        "/chats/" + c.id,
        "PATCH",
        name === "pin"
          ? { pinned: !c.pinned }
          : name === "archive"
            ? { archived: !c.archived }
            : { deleted: true },
      );
    if (idRef.current === c.id) await refresh();
    await loadNavigation();
  }
  const chatRow = (c: Brief) => (
    <div
      key={c.id}
      className={"chat-row " + (c.id === chat?.id ? "selected" : "")}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
    >
      <button className="chat-open" onClick={() => void run(() => open(c.id))}>
        <span className="chat-title">{c.title}</span>
        {c.status === "running" || c.status === "pending" ? (
          <LoaderCircle size={13} className="spin" />
        ) : c.status === "error" ? (
          <CircleAlert size={13} className="danger-text" />
        ) : c.unread ? (
          <span className="unread" />
        ) : c.pinned ? (
          <span className="muted">⌃</span>
        ) : null}
      </button>
      <ChatListMenu
        chat={c}
        onAction={(name) => void run(() => listAction(c, name))}
      />
    </div>
  );
  if (auth === null)
    return (
      <div className="center">
        <LoaderCircle className="spin" />
      </div>
    );
  if (!auth)
    return <Login onLogin={() => setAuth(true)} error={error} run={run} />;
  return (
    <div
      className="app"
      style={
        {
          "--font-size": appearance.font + "px",
          "--content-width": appearance.width + "px",
          "--line-height": appearance.line,
        } as React.CSSProperties
      }
    >
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={"sidebar " + (sidebar ? "open" : "")}
        style={
          { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties
        }
      >
        <div
          className="sidebar-resize"
          role="separator"
          aria-label="导航宽度"
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1)
              setSidebarWidth(Math.max(190, Math.min(420, e.clientX)));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setSidebarWidth((value) =>
                Math.max(
                  190,
                  Math.min(420, value + (e.key === "ArrowRight" ? 10 : -10)),
                ),
              );
            }
          }}
        />
        <div className="brand">
          <span className="brand-mark">✦</span>
          <strong>在线AI</strong>
          <IconButton label="收起导航" onClick={() => setSidebar(false)}>
            <PanelLeft size={18} />
          </IconButton>
        </div>
        <button
          className="new-chat"
          disabled={opening || initializing}
          onClick={() => void run(() => create())}
        >
          <Pencil size={17} />
          新聊天<span>＋</span>
        </button>
        <div className="nav-list">
          <div className="section-label">
            分组
            <IconButton
              label="新建分组"
              onClick={() => {
                const name = prompt("分组名称");
                if (name)
                  void run(async () => {
                    await api("/groups", "POST", { name });
                    await loadNavigation();
                  });
              }}
            >
              <Plus size={15} />
            </IconButton>
          </div>
          {groups
            .sort(
              (a, b) =>
                Math.max(
                  b.updatedAt,
                  ...filteredChats
                    .filter((c) => c.groupId === b.id)
                    .map((c) => c.updatedAt),
                ) -
                Math.max(
                  a.updatedAt,
                  ...filteredChats
                    .filter((c) => c.groupId === a.id)
                    .map((c) => c.updatedAt),
                ),
            )
            .map((g) => (
              <section
                key={g.id}
                className="group"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) =>
                  void run(async () => {
                    await api(
                      "/chats/" + e.dataTransfer.getData("text/plain"),
                      "PATCH",
                      { groupId: g.id },
                    );
                    await loadNavigation();
                  })
                }
              >
                <div className="group-title">
                  <Folder size={16} />
                  <span className="group-name">{g.name}</span>
                  <IconButton
                    label={"管理分组 " + g.name}
                    onClick={() =>
                      setGroupMenu(groupMenu === g.id ? null : g.id)
                    }
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                  {groupMenu === g.id && (
                    <div className="group-menu">
                      <button
                        onClick={() => {
                          const name = prompt("重命名分组", g.name);
                          if (name)
                            void run(async () => {
                              await api("/groups/" + g.id, "PATCH", { name });
                              setGroupMenu(null);
                              await loadNavigation();
                            });
                        }}
                      >
                        重命名分组
                      </button>
                      <button
                        className="danger-text"
                        onClick={() =>
                          void run(async () => {
                            await api("/groups/" + g.id, "DELETE", {});
                            setGroupMenu(null);
                            await loadNavigation();
                            await refresh();
                          })
                        }
                      >
                        移除分组，聊天回主列表
                      </button>
                    </div>
                  )}
                  <IconButton
                    label={"在 " + g.name + " 新建聊天"}
                    disabled={opening || initializing}
                    onClick={() => void run(() => create(g.id))}
                  >
                    <Plus size={15} />
                  </IconButton>
                </div>
                {sorted(filteredChats.filter((c) => c.groupId === g.id)).map(
                  chatRow,
                )}
              </section>
            ))}
          <div
            className="section-label main-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) =>
              void run(async () => {
                await api(
                  "/chats/" + e.dataTransfer.getData("text/plain"),
                  "PATCH",
                  { groupId: null },
                );
                await loadNavigation();
                await refresh();
              })
            }
          >
            {view === "trash"
              ? "回收站"
              : view === "archive"
                ? "已归档"
                : "聊天"}
          </div>
          {sorted(
            filteredChats.filter(
              (c) => !c.groupId || !groups.some((g) => g.id === c.groupId),
            ),
          ).map(chatRow)}
          {!filteredChats.length && (
            <p className="nav-empty">
              {view === "active" ? "从一个问题开始" : "这里还没有聊天"}
            </p>
          )}
        </div>
        <div className="nav-footer">
          <AccountMenu
            items={[
              {
                label: "设置",
                icon: <Settings2 size={19} />,
                onClick: () => showSettings(),
              },
              {
                label: "外观",
                icon: <Palette size={19} />,
                onClick: () => showSettings("appearance"),
              },
              {
                label: "账号与设备",
                icon: <UserRound size={19} />,
                onClick: () => showSettings("security"),
              },
              {
                label: "导入聊天",
                icon: <Upload size={19} />,
                onClick: () => fileRef.current?.click(),
              },
              {
                label: view === "archive" ? "返回聊天" : "归档",
                icon: <Archive size={19} />,
                onClick: () =>
                  setView(view === "archive" ? "active" : "archive"),
              },
              {
                label: view === "trash" ? "返回聊天" : "回收站",
                icon: <Trash2 size={19} />,
                onClick: () => setView(view === "trash" ? "active" : "trash"),
              },
              ...(view === "trash"
                ? [
                    {
                      label: "导出回收站",
                      icon: <Download size={19} />,
                      onClick: () =>
                        void downloadChats(
                          chats.filter((c) => c.deleted).map((c) => c.id),
                        ),
                    },
                  ]
                : []),
              {
                label: "退出登录",
                icon: <LogOut size={19} />,
                separator: true,
                onClick: () =>
                  void run(async () => {
                    await api("/auth/logout", "POST", {});
                    setAuth(false);
                    setChat(null);
                  }),
              },
            ]}
          />
        </div>
      </aside>
      <main>
        <header>
          {!sidebar && (
            <IconButton label="打开导航" onClick={() => setSidebar(true)}>
              <PanelLeft size={19} />
            </IconButton>
          )}
          <button
            className="header-title"
            onClick={() => {
              if (chat) {
                const title = prompt("重命名聊天", chat.title);
                if (title) void run(() => patch({ title }));
              }
            }}
          >
            {chat?.title ?? "在线AI"}
          </button>
          <div className="header-actions">
            {job && (
              <span className="status-label">
                <LoaderCircle size={13} className="spin" />
                正在生成
              </span>
            )}
            {chat && (
              <>
                <IconButton
                  label="当前聊天设置"
                  onClick={() => setPanel(!panel)}
                >
                  <SlidersHorizontal size={19} />
                </IconButton>
              </>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            {chat && connection.unsaved(chat.id) && (
              <button
                onClick={() =>
                  void run(async () => {
                    await connection.retrySave(chat.id);
                    setError("");
                    await refresh();
                  })
                }
              >
                重试保存回答
              </button>
            )}
            <IconButton label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        <div
          className="message-scroll"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current!;
            stick.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            setScrollBottom(!stick.current);
          }}
        >
          {!path.length ? (
            <div className="welcome">
              <span className="welcome-symbol">✦</span>
              <h1>有什么想聊的？</h1>
              <p>让想法从这里开始。</p>
              {!models.some((m) => m.enabled) && (
                <button
                  className="subtle-button"
                  onClick={() => showSettings()}
                >
                  配置服务商与模型 <ChevronRight size={14} />
                </button>
              )}
            </div>
          ) : (
            <div className="messages">
              {path.map((m, index) => {
                const siblings = chat
                    ? (byParent.get(m.parentId) ?? []).filter(
                        (s) => s.role === m.role,
                      )
                    : [],
                  version = siblings.findIndex((s) => s.id === m.id);
                return (
                  <article
                    key={m.id}
                    className={
                      "message " +
                      m.role +
                      (excludedIds.has(m.id) ? " excluded" : "")
                    }
                    onPointerDown={(e) => {
                      if (
                        e.pointerType !== "touch" ||
                        (e.target as HTMLElement).closest(
                          "button,a,input,textarea,select",
                        )
                      )
                        return;
                      cancelLongPress();
                      longPress.current = {
                        x: e.clientX,
                        y: e.clientY,
                        timer: setTimeout(() => {
                          setMenu(m.id);
                          longPress.current = null;
                        }, 500),
                      };
                    }}
                    onPointerMove={(e) => {
                      if (
                        longPress.current &&
                        Math.hypot(
                          e.clientX - longPress.current.x,
                          e.clientY - longPress.current.y,
                        ) > 10
                      )
                        cancelLongPress();
                    }}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu(m.id);
                    }}
                  >
                    {editing?.id === m.id ? (
                      <div className="edit-area">
                        <textarea
                          value={editing.content}
                          onChange={(e) =>
                            setEditing({ ...editing, content: e.target.value })
                          }
                        />
                        <div>
                          <button onClick={() => setEditing(null)}>取消</button>
                          <button
                            className="primary"
                            onClick={() =>
                              void run(async () => {
                                await action("edit", {
                                  messageId: m.id,
                                  content: editing.content,
                                });
                                setEditing(null);
                              })
                            }
                          >
                            保存{m.role === "user" ? "为新分支" : ""}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="message-body">
                        {m.reasoning && (
                          <details open={m.status === "running"}>
                            <summary>思考过程</summary>
                            <div className="reasoning">{m.reasoning}</div>
                          </details>
                        )}
                        <div
                          id={"text-" + m.id}
                          className={
                            "markdown " +
                            (appearance.collapse && m.content.length > 5000
                              ? "collapsible"
                              : "")
                          }
                        >
                          <MessageMarkdown
                            content={
                              m.content ||
                              (m.status === "running" ? "" : "（空消息）")
                            }
                          />
                        </div>
                        {appearance.collapse && m.content.length > 5000 && (
                          <button
                            className="text-button"
                            onClick={(e) => {
                              e.currentTarget.previousElementSibling?.classList.toggle(
                                "collapsible",
                              );
                              e.currentTarget.textContent =
                                e.currentTarget.textContent === "展开全文"
                                  ? "收起"
                                  : "展开全文";
                            }}
                          >
                            展开全文
                          </button>
                        )}
                        {m.status === "running" && !m.content && (
                          <span className="generating-dot" />
                        )}
                        {m.error && <p className="message-error">{m.error}</p>}
                        {m.status === "stopped" && (
                          <p className="muted">已停止 · 保留部分回答</p>
                        )}
                        <div
                          className={
                            "message-actions " +
                            (menu === m.id ? "visible" : "")
                          }
                        >
                          <IconButton
                            label="复制 Markdown"
                            onClick={() =>
                              void run(() =>
                                navigator.clipboard.writeText(m.content),
                              )
                            }
                          >
                            <Copy size={14} />
                          </IconButton>
                          <IconButton
                            label="编辑消息"
                            disabled={!!job}
                            onClick={() =>
                              setEditing({ id: m.id, content: m.content })
                            }
                          >
                            <Pencil size={14} />
                          </IconButton>
                          {m.role === "assistant" && (
                            <IconButton
                              label="重新生成"
                              disabled={!!job}
                              onClick={() =>
                                void run(() =>
                                  action("regenerate", { messageId: m.id }),
                                )
                              }
                            >
                              <RotateCcw size={14} />
                            </IconButton>
                          )}
                          <IconButton
                            label="从这里 Fork"
                            disabled={!!job}
                            onClick={() =>
                              void run(() =>
                                action("fork", { messageId: m.id }),
                              )
                            }
                          >
                            <GitBranch size={15} />
                          </IconButton>
                          {m.role === "assistant" && (
                            <IconButton
                              label="继续回答"
                              disabled={!!job}
                              onClick={() =>
                                void run(() =>
                                  action("continue", { messageId: m.id }),
                                )
                              }
                            >
                              <ArrowRight size={15} />
                            </IconButton>
                          )}
                          {m.role === "assistant" && m.status === "error" && (
                            <IconButton
                              label="重试为新版本"
                              disabled={!!job}
                              onClick={() =>
                                void run(() =>
                                  action("retry", { messageId: m.id }),
                                )
                              }
                            >
                              <RotateCcw size={15} />
                            </IconButton>
                          )}
                          <IconButton
                            label={
                              excludedIds.has(m.id)
                                ? "加入本轮上下文"
                                : "移除本轮上下文"
                            }
                            disabled={!!job}
                            onClick={() =>
                              void run(() =>
                                action("exclude", { messageId: m.id }),
                              )
                            }
                          >
                            {excludedIds.has(m.id) ? (
                              <MessageSquarePlus size={15} />
                            ) : (
                              <MessageSquareOff size={15} />
                            )}
                          </IconButton>
                          <IconButton
                            label="复制纯文字"
                            onClick={() =>
                              void run(() =>
                                navigator.clipboard.writeText(plainText(m.id)),
                              )
                            }
                          >
                            <FileText size={15} />
                          </IconButton>
                          <IconButton
                            label="消息详情"
                            onClick={() => setModal("request:" + m.id)}
                          >
                            <Info size={15} />
                          </IconButton>
                          {siblings.length > 1 && (
                            <div className="versions">
                              <IconButton
                                label="上个版本"
                                disabled={!!job || version === 0}
                                onClick={() =>
                                  void run(() =>
                                    action("select", {
                                      messageId: siblings[version - 1]?.id,
                                    }),
                                  )
                                }
                              >
                                <ChevronLeft size={14} />
                              </IconButton>
                              <button
                                aria-label="选择消息版本"
                                onClick={() => setModal("versions:" + m.id)}
                              >
                                {version + 1} / {siblings.length}
                              </button>
                              <IconButton
                                label="下个版本"
                                disabled={
                                  !!job || version === siblings.length - 1
                                }
                                onClick={() =>
                                  void run(() =>
                                    action("select", {
                                      messageId: siblings[version + 1]?.id,
                                    }),
                                  )
                                }
                              >
                                <ChevronRight size={14} />
                              </IconButton>
                            </div>
                          )}
                        </div>
                        {m.role === "assistant" && (
                          <MessageUsage
                            message={m}
                            historical={m.id !== lastAssistant && menu !== m.id}
                          />
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <div className="composer-area">
          {scrollBottom && (
            <IconButton
              label="回到底部"
              className="to-bottom"
              onClick={() => {
                stick.current = true;
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={17} />
            </IconButton>
          )}
          <div className={"composer " + (expanded ? "expanded" : "")}>
            {!selectedModel && (
              <p className="muted" role="status">
                没有可用的当前模型或默认模型，请在设置中添加服务商并选择有效的默认模型。
              </p>
            )}
            <div className="composer-input">
              <textarea
                ref={textarea}
                disabled={opening || initializing}
                aria-label="消息"
                placeholder="发送消息…"
                value={draft}
                rows={expanded ? 14 : 2}
                onChange={(e) => updateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    desktopInput() &&
                    appearance.enter
                  ) {
                    e.preventDefault();
                    void run(send);
                  }
                }}
              />
              <IconButton
                label={expanded ? "收起编辑区" : "展开编辑区"}
                className="composer-expand"
                onClick={() => setExpanded(!expanded)}
              >
                <Expand size={16} />
              </IconButton>
            </div>
            <div className="composer-controls">
              <button
                className="icon-button composer-plus"
                aria-label="更多功能（预留）"
                title="预留入口"
                disabled
              >
                <Plus size={24} strokeWidth={1.7} />
              </button>
              <div className="composer-spacer" />
              <div className="composer-model-settings">
                <ContextUsage used={estimate} capacity={capacity} />
                <div className="model-control">
                  <button
                    className="model-trigger"
                    aria-label="选择模型"
                    title={
                      selectedModel
                        ? selectedModel.provider.prefix + selectedModel.id
                        : "选择模型"
                    }
                    aria-expanded={modelMenu}
                    disabled={opening || initializing}
                    onClick={() => {
                      setModelMenu(!modelMenu);
                      setSearch("");
                    }}
                  >
                    <span>
                      {selectedModel
                        ? selectedModel.provider.prefix + selectedModel.id
                        : "选择模型"}
                    </span>
                  </button>
                  {modelMenu && (
                    <div className="model-popover">
                      <div className="search-box">
                        <Search size={15} />
                        <input
                          aria-label="搜索模型"
                          autoFocus={desktopInput()}
                          placeholder="搜索模型或服务商"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <div className="model-options">
                        {filteredModels.map((m) => (
                          <button
                            key={m.provider.id + "/" + m.id}
                            onClick={() =>
                              void run(async () => {
                                if (!chat) {
                                  await ensureComposerChat();
                                  await api(
                                    "/chats/" + idRef.current,
                                    "PATCH",
                                    {
                                      model: m.ref,
                                    },
                                  );
                                  await refresh();
                                } else await patch({ model: m.ref });
                                setModelMenu(false);
                              })
                            }
                          >
                            <span>
                              {m.provider.prefix + m.id}
                              <small>{m.provider.name}</small>
                            </span>
                            {m.id === current?.modelId &&
                              m.provider.id === current.providerId && (
                                <Check size={15} />
                              )}
                          </button>
                        ))}
                        {!filteredModels.length && (
                          <p className="muted">没有启用的匹配模型</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <EffortControl
                  value={chat?.effort ?? "max"}
                  model={
                    selectedModel
                      ? selectedModel.provider.prefix + selectedModel.id
                      : "选择模型"
                  }
                  onChooseModel={() => setModelMenu(true)}
                  onChange={(effort) =>
                    run(async () => {
                      if (!chat) {
                        await ensureComposerChat();
                        await api("/chats/" + idRef.current, "PATCH", {
                          effort,
                        });
                        await refresh();
                      } else await patch({ effort });
                    })
                  }
                />
              </div>
              {job ? (
                <IconButton
                  label="停止生成"
                  className="send-button"
                  onClick={() => void run(() => action("stop"))}
                >
                  <Square size={15} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton
                  label="发送"
                  className="send-button"
                  disabled={
                    !draft.trim() || busy || !!chat?.deleted || !selectedModel
                  }
                  onClick={() => void run(send)}
                >
                  {busy ? (
                    <LoaderCircle size={19} className="spin" />
                  ) : (
                    <ArrowUp size={21} />
                  )}
                </IconButton>
              )}
            </div>
          </div>
          {estimate > capacity && (
            <p className="context-warning">超出所设上下文预算，仍可发送。</p>
          )}
        </div>
      </main>
      {panel && chat && (
        <aside className="parameters">
          <div className="panel-heading">
            <div className="panel-tabs">
              <button
                className={panelTab === "settings" ? "selected" : ""}
                onClick={() => setPanelTab("settings")}
              >
                当前聊天设置
              </button>
              <button
                aria-label="分支总览"
                className={panelTab === "overview" ? "selected" : ""}
                onClick={() => setPanelTab("overview")}
              >
                概述
              </button>
            </div>
            <IconButton label="返回聊天" onClick={() => setPanel(false)}>
              <X size={18} />
            </IconButton>
          </div>
          {panelTab === "settings" ? (
            <div className="panel-content">
              <label className="toggle">
                流式回答
                <input
                  type="checkbox"
                  checked={chat.stream}
                  onChange={(e) =>
                    void run(() => patch({ stream: e.target.checked }))
                  }
                />
              </label>
              <h3>生成参数</h3>
              {(["temperature", "top_p", "top_k"] as const).map((key) => (
                <ParameterControl
                  key={key}
                  name={
                    key === "temperature"
                      ? "温度"
                      : key === "top_p"
                        ? "Top P"
                        : "Top K"
                  }
                  value={chat.parameters[key]}
                  max={key === "temperature" ? 2 : key === "top_p" ? 1 : 100000}
                  step={key === "top_k" ? 1 : 0.05}
                  onChange={(value) => {
                    const p = { ...chat.parameters };
                    if (value === undefined) delete p[key];
                    else p[key] = value;
                    void run(() => patch({ parameters: p }));
                  }}
                />
              ))}
              <label>
                最近上下文轮数
                <input
                  type="number"
                  min="1"
                  placeholder="全部"
                  defaultValue={chat.rounds ?? ""}
                  key={chat.id}
                  onBlur={(e) =>
                    void run(() =>
                      patch({
                        rounds: e.target.value ? Number(e.target.value) : null,
                      }),
                    )
                  }
                />
              </label>
              <label className="toggle">
                停止的部分纳入上下文
                <input
                  type="checkbox"
                  checked={chat.includeStopped}
                  onChange={(e) =>
                    void run(() => patch({ includeStopped: e.target.checked }))
                  }
                />
              </label>
              <h3>系统提示词</h3>
              <label>
                选择模板时
                <select
                  value={chat.templateMode}
                  onChange={(e) =>
                    void run(() =>
                      patch({
                        templateMode: e.target.value as Chat["templateMode"],
                      }),
                    )
                  }
                >
                  <option value="replace">替换</option>
                  <option value="append">追加</option>
                </select>
              </label>
              <TemplatePicker
                templates={settings.templates}
                onApply={(templates) =>
                  run(() =>
                    patch({
                      system:
                        chat.templateMode === "replace"
                          ? templates
                          : [...chat.system, ...templates],
                    }),
                  )
                }
              />
              {chat.system.map((t, i) => (
                <div className="template-card" key={t.id + "-" + i}>
                  <div>
                    {t.name}
                    <IconButton
                      label="上移模板"
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...chat.system];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        void run(() => patch({ system: next }));
                      }}
                    >
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton
                      label="删除模板卡片"
                      onClick={() =>
                        void run(() =>
                          patch({
                            system: chat.system.filter((_, j) => j !== i),
                          }),
                        )
                      }
                    >
                      <X size={13} />
                    </IconButton>
                  </div>
                  <textarea
                    aria-label={t.name}
                    defaultValue={t.content}
                    onBlur={(e) =>
                      void run(() =>
                        patch({
                          system: chat.system.map((v, j) =>
                            j === i ? { ...v, content: e.target.value } : v,
                          ),
                        }),
                      )
                    }
                  />
                </div>
              ))}
              <button
                onClick={() =>
                  void run(() =>
                    patch({
                      system: [
                        ...chat.system,
                        {
                          id: crypto.randomUUID(),
                          name: "自定义提示词",
                          content: "",
                        },
                      ],
                    }),
                  )
                }
              >
                ＋ 添加提示词卡片
              </button>
              <button onClick={() => setModal("preview")}>预览下次请求</button>

              <h3>聊天管理</h3>
              <div className="chat-management">
                <button
                  onClick={() => {
                    const title = prompt("重命名聊天", chat.title);
                    if (title) void run(() => patch({ title }));
                  }}
                >
                  <Pencil size={16} />
                  重命名聊天
                </button>
                <button
                  disabled={
                    !!job ||
                    ["pending", "running"].includes(titleJob?.status ?? "")
                  }
                  onClick={() => void run(() => action("title"))}
                >
                  <RotateCcw size={16} />
                  重新生成标题
                </button>
                {titleJob?.status === "error" && (
                  <p className="danger-text">标题生成失败：{titleJob.error}</p>
                )}

                <button
                  onClick={() =>
                    void run(() => patch({ pinned: !chat.pinned }))
                  }
                >
                  <Pin size={16} />
                  {chat.pinned ? "取消置顶" : "置顶聊天"}
                </button>
                <button
                  onClick={() =>
                    void run(() => patch({ archived: !chat.archived }))
                  }
                >
                  <Archive size={16} />
                  {chat.archived ? "取消归档" : "归档聊天"}
                </button>
                <select
                  aria-label="移动聊天"
                  value={chat.groupId ?? ""}
                  onChange={(e) =>
                    void run(() => patch({ groupId: e.target.value || null }))
                  }
                >
                  <option value="">主列表</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <button onClick={() => void downloadChats([chat.id])}>
                  <Download size={16} />
                  导出完整树 JSON
                </button>
                <button
                  onClick={() =>
                    download(
                      chat.title + ".md",
                      markdownExport(chat),
                      "text/markdown",
                    )
                  }
                >
                  <FileText size={16} />
                  导出当前路线 Markdown
                </button>
                <button
                  onClick={() =>
                    void downloadChats(
                      chats.filter((c) => !c.deleted).map((c) => c.id),
                    )
                  }
                >
                  <Download size={16} />
                  导出全部聊天（含归档）
                </button>
                <button onClick={() => fileRef.current?.click()}>
                  <Upload size={16} />
                  导入 OpenWebUI JSON
                </button>
                <button
                  className="danger-text"
                  onClick={() =>
                    void run(async () => {
                      await patch({ deleted: !chat.deleted });
                      setModal("");
                    })
                  }
                >
                  <Trash2 size={16} />
                  {chat.deleted ? "从回收站恢复" : "移入回收站"}
                </button>
                {chat.deleted && (
                  <button
                    className="danger-text"
                    onClick={() => {
                      if (confirm("永久删除这个聊天？无法恢复。"))
                        void run(async () => {
                          await api(
                            "/chats/" + chat.id + "/permanent",
                            "DELETE",
                            {},
                          );
                          idRef.current = null;
                          setChat(null);
                          setModal("");
                          await loadNavigation();
                        });
                    }}
                  >
                    永久删除聊天
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="overview-content">
              <Suspense fallback={<div className="center">加载分支…</div>}>
                <BranchOverview
                  chat={chat}
                  providers={providers}
                  onSelect={(id) => {
                    if (!job)
                      void run(() => action("select", { messageId: id }));
                  }}
                />
              </Suspense>
            </div>
          )}
        </aside>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal("")}>
          <section
            ref={dialogRef}
            className={
              "modal " + (modal === "settings" ? "settings-modal" : "")
            }
            role="dialog"
            aria-modal="true"
            aria-label={modal === "settings" ? "设置" : "聊天操作"}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>
                {modal === "settings"
                  ? "设置"
                  : modal.startsWith("versions:")
                    ? "消息版本"
                    : modal === "tree"
                      ? "分支总览"
                      : modal === "preview"
                        ? "请求预览"
                        : "消息详情"}
              </h2>
              <IconButton label="关闭" onClick={() => setModal("")}>
                <X size={20} />
              </IconButton>
            </div>
            {modal === "settings" ? (
              <SettingsPanel
                initialTab={settingsTab}
                providers={providers}
                settings={settings}
                appearance={appearance}
                setAppearance={setAppearance}
                run={run}
                refresh={loadConfig}
                onLogout={() => {
                  setAuth(false);
                  setChat(null);
                }}
              />
            ) : modal.startsWith("versions:") &&
              chat &&
              chat.messages[modal.slice(9)] ? (
              <div className="version-list">
                {(byParent.get(chat.messages[modal.slice(9)]!.parentId) ?? [])
                  .filter(
                    (item) => item.role === chat.messages[modal.slice(9)]!.role,
                  )
                  .map((item, index) => (
                    <button
                      key={item.id}
                      disabled={!!job}
                      onClick={() =>
                        void run(async () => {
                          await action("select", { messageId: item.id });
                          setModal("");
                        })
                      }
                    >
                      <strong>版本 {index + 1}</strong>
                      <span>{item.content.slice(0, 180) || "空回答"}</span>
                    </button>
                  ))}
              </div>
            ) : modal === "preview" && chat ? (
              <RequestPreview chat={chat} draft={draft} run={run} />
            ) : modal.startsWith("request:") &&
              chat?.messages[modal.slice(8)] ? (
              <div className="message-details">
                <p className="muted">
                  {new Date(
                    chat.messages[modal.slice(8)]!.createdAt,
                  ).toLocaleString()}
                </p>
                <pre className="request-meta">
                  {JSON.stringify(
                    {
                      model: chat.messages[modal.slice(8)]!.model,
                      request: chat.messages[modal.slice(8)]!.request,
                      usage: chat.messages[modal.slice(8)]!.usage,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            ) : null}
          </section>
        </div>
      )}
      <input
        ref={fileRef}
        aria-label="聊天导入文件"
        className="hidden"
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void run(async () => {
              const data = JSON.parse(await file.text()),
                preview = await api<{
                  count: number;
                  branches: number;
                  attachments: number;
                  failures: { index: number; reason: string }[];
                }>("/import/preview", "POST", { data });
              setPendingImport({ data, preview });
            });
          e.target.value = "";
        }}
      />
      {pendingImport && (
        <ImportDialog
          {...pendingImport}
          close={() => setPendingImport(null)}
          refresh={loadNavigation}
        />
      )}
    </div>
  );
}
const MessageMarkdown = React.memo(function MessageMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ alt, src }) => (
          <a
            href={
              typeof src === "string" && /^https:\/\//.test(src)
                ? src
                : undefined
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            [图片：{alt ?? "链接"}]
          </a>
        ),
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      }}
    >
      {content}
    </Markdown>
  );
});
function plainText(id: string) {
  const source = document.getElementById("text-" + id);
  if (!source) return "";
  const copy = source.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("button").forEach((el) => el.remove());
  copy
    .querySelectorAll("p,li,h1,h2,h3,pre,tr,blockquote")
    .forEach((el) => el.appendChild(document.createTextNode("\n")));
  return copy.textContent?.trim() ?? "";
}
function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null),
    [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(ref.current?.textContent ?? "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
        {copied ? "已复制" : "复制代码"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
function Login({
  onLogin,
  error,
  run,
}: {
  onLogin: () => void;
  error: string;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [recovery, setRecovery] = useState(false),
    [next, setNext] = useState(""),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState(""),
    [recoveryCode, setRecoveryCode] = useState("");
  if (recoveryCode)
    return (
      <div className="login-page">
        <section className="login-card">
          <h1>密码已重置</h1>
          <p>请离线保存新的恢复码，原恢复码已失效，所有设备已退出。</p>
          <code className="revealed-key">{recoveryCode}</code>
          <button
            className="primary"
            onClick={() =>
              download("在线AI-恢复码.txt", recoveryCode, "text/plain")
            }
          >
            下载恢复码
          </button>
          <button onClick={() => setRecoveryCode("")}>已保存，返回登录</button>
        </section>
      </div>
    );
  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          setLoading(true);
          void run(async () => {
            try {
              const result = await api<{ recoveryCode?: string }>(
                "/auth/" + (recovery ? "recover" : "login"),
                "POST",
                {
                  password,
                  newPassword: next,
                },
              );
              if (recovery) {
                setRecovery(false);
                setPassword("");
                setRecoveryCode(result.recoveryCode ?? "");
                setMessage("密码已重置。请使用新密码登录；原恢复码已失效。");
              } else onLogin();
            } finally {
              setPassword("");
              setNext("");
              setLoading(false);
            }
          });
        }}
      >
        <span className="welcome-symbol">✦</span>
        <h1>在线AI</h1>
        <p className="muted">
          {recovery ? "使用离线恢复码重置访问密码" : "登录，继续你的思考。"}
        </p>
        <label>
          {recovery ? "离线恢复码" : "访问密码"}
          <input
            autoFocus
            required
            autoComplete={recovery ? "off" : "current-password"}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {recovery && (
          <label>
            新密码
            <input
              required
              type="password"
              minLength={12}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="danger-text" role="alert">
            {error}
          </p>
        )}
        {message && <p>{message}</p>}
        <button className="primary" disabled={loading} type="submit">
          {loading ? "正在验证…" : recovery ? "重置密码" : "登录"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => setRecovery(!recovery)}
        >
          {recovery ? "返回登录" : "使用恢复码"}
        </button>
      </form>
    </div>
  );
}
function RequestPreview({
  chat,
  draft,
  run,
}: {
  chat: Chat;
  draft: string;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [data, setData] = useState("");
  useEffect(() => {
    void run(async () => {
      setData(
        JSON.stringify(
          await api("/chats/" + chat.id + "/preview", "POST", { draft }),
          null,
          2,
        ),
      );
    });
  }, [chat.id]);
  return (
    <>
      <p className="muted">
        下次请求的文字上下文和参数，不包含密钥。历史思考内容不发送。
      </p>
      <pre className="request-preview">{data}</pre>
    </>
  );
}
type Appearance = {
  theme: string;
  font: number;
  width: number;
  line: number;
  collapse: boolean;
  enter: boolean;
};
function readAppearance(): Appearance {
  const defaults: Appearance = {
    theme: "system",
    font: 16,
    width: 800,
    line: 1.8,
    collapse: true,
    enter: true,
  };
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem("appearance") ?? "null",
    );
    if (!raw || typeof raw !== "object") return defaults;
    const value = raw as Record<string, unknown>;
    return {
      theme:
        typeof value.theme === "string" &&
        ["system", "dark", "light"].includes(value.theme)
          ? value.theme
          : defaults.theme,
      font:
        typeof value.font === "number" && value.font >= 13 && value.font <= 24
          ? value.font
          : defaults.font,
      width:
        typeof value.width === "number" &&
        value.width >= 600 &&
        value.width <= 1200
          ? value.width
          : defaults.width,
      line:
        typeof value.line === "number" && value.line >= 1.3 && value.line <= 2.4
          ? value.line
          : defaults.line,
      collapse:
        typeof value.collapse === "boolean"
          ? value.collapse
          : defaults.collapse,
      enter: typeof value.enter === "boolean" ? value.enter : defaults.enter,
    };
  } catch {
    return defaults;
  }
}
function SettingsPanel({
  initialTab,
  providers,
  settings,
  appearance,
  setAppearance,
  run,
  refresh,
  onLogout,
}: {
  initialTab: string;
  providers: ProviderView[];
  settings: Settings;
  appearance: Appearance;
  setAppearance: (v: Appearance) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  onLogout: () => void;
}) {
  const connection = useDeviceConnection();
  const [tab, setTab] = useState(initialTab),
    [form, setForm] = useState({
      name: "",
      baseUrl: "https://",
      prefix: "",
      apiKey: "",
      id: "",
    }),
    [filter, setFilter] = useState(""),
    [saving, setSaving] = useState(false),
    [sessions, setSessions] = useState<
      { id: string; device: string; createdAt: number; current: boolean }[]
    >([]),
    [oldPassword, setOldPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [recovery, setRecovery] = useState(""),
    [recoveryRevoked, setRecoveryRevoked] = useState(false);
  const [template, setTemplate] = useState({ name: "", content: "" });
  async function saveSettings(next: Settings) {
    await api("/settings", "PUT", next);
    await refresh();
  }
  async function saveProvider(value: {
    id?: string;
    name: string;
    baseUrl: string;
    prefix: string;
    apiKey?: string;
  }) {
    let models: { id: string }[] | undefined;
    let key = value.apiKey;
    if (connection.enabled) {
      const existing = providers.find((p) => p.id === value.id);
      if (
        existing &&
        existing.baseUrl !== value.baseUrl.replace(/\/$/, "") &&
        !key
      )
        throw Error("修改地址时请重新输入密钥");
      key ??= existing
        ? await connection.key({
            providerId: existing.id,
            baseUrl: existing.baseUrl,
            hasKey: existing.hasKey,
          })
        : "";
      models = await directModels(value.baseUrl, key);
    }
    const saved = await api<ProviderView>("/providers", "POST", {
      ...value,
      models,
    });
    if (key !== undefined) connection.remember(saved.id, saved.baseUrl, key);
    return saved;
  }
  useEffect(() => {
    if (tab === "security")
      void run(async () => setSessions(await api("/auth/sessions")));
  }, [tab]);
  const modelRows = providers
    .flatMap((p) => p.models.map((m) => ({ ...m, p })))
    .filter((m) =>
      `${m.id} ${m.p.prefix} ${m.p.name}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    );
  return (
    <div className="settings-body">
      <nav>
        {[
          ["connection", "连接"],
          ["providers", "服务商"],
          ["models", "模型"],
          ["templates", "提示词模板"],
          ["generation", "生成默认"],
          ["backup", "设置备份"],
          ["appearance", "外观"],
          ["security", "账号与设备"],
          ["about", "关于"],
        ].map(([key, title]) => (
          <button
            className={tab === key ? "selected" : ""}
            key={key}
            onClick={() => setTab(key!)}
          >
            {title}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === "connection" && (
          <>
            <h3>请求方式</h3>
            <label className="toggle">
              此设备直连
              <input
                type="checkbox"
                aria-label="此设备直连"
                checked={connection.enabled}
                onChange={(event) =>
                  connection.setEnabled(event.target.checked)
                }
              />
            </label>
            <p className="muted">
              开启后，此设备直接通过 HTTPS
              请求服务商，流式内容即时显示。上游必须允许 CORS
              跨域；密钥经访问密码验证后只保留在页面内存。关闭页面会中断直连生成，后台持续生成请使用服务端模式。开关只在此设备保存。
            </p>
            <button onClick={connection.lock}>清除临时密钥</button>
          </>
        )}
        {tab === "about" && (
          <>
            <h3>关于在线AI</h3>
            <p>
              分支总览组件源自{" "}
              <a
                href="https://github.com/open-webui/open-webui/tree/v0.12.2/src/lib/components/chat/Overview"
                target="_blank"
                rel="noreferrer"
              >
                Open WebUI v0.12.2
              </a>
              ，使用 Svelte Flow，已适配本应用。
            </p>
            <p>
              <a
                href="/licenses/open-webui.txt"
                target="_blank"
                rel="noreferrer"
              >
                Open WebUI License
              </a>{" "}
              ·{" "}
              <a
                href="/licenses/open-webui-history.txt"
                target="_blank"
                rel="noreferrer"
              >
                许可历史
              </a>
            </p>
          </>
        )}
        <SettingsTools
          tab={tab}
          settings={settings}
          providers={providers}
          run={run}
          refresh={refresh}
        />
        {tab === "providers" && (
          <>
            <h3>服务商</h3>
            <p className="muted">
              连接你自己的 OpenAI
              兼容接口。密钥加密保存在服务端，设备直连时经验证临时解锁。
            </p>
            {providers.map((p) => (
              <div className="provider-card" key={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <small>{p.baseUrl}</small>
                  <span className="muted">
                    {p.models.length} 个模型 ·{" "}
                    {p.hasKey ? "已保存密钥" : "无密钥"}
                  </span>
                </div>
                <KeyReveal provider={p} run={run} />
                <IconButton
                  label={"编辑 " + p.name}
                  onClick={() =>
                    setForm({
                      id: p.id,
                      name: p.name,
                      baseUrl: p.baseUrl,
                      prefix: p.prefix,
                      apiKey: "",
                    })
                  }
                >
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label={"刷新 " + p.name + " 模型"}
                  onClick={() =>
                    void run(async () => {
                      await saveProvider({
                        id: p.id,
                        name: p.name,
                        baseUrl: p.baseUrl,
                        prefix: p.prefix,
                      });
                      await refresh();
                    })
                  }
                >
                  <RotateCcw size={15} />
                </IconButton>
                <IconButton
                  label={"删除 " + p.name}
                  onClick={() => {
                    if (confirm("删除此服务商？历史消息会保留。"))
                      void run(async () => {
                        await api("/providers/" + p.id, "DELETE", {});
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSaving(true);
                void run(async () => {
                  try {
                    await saveProvider({
                      ...form,
                      id: form.id || undefined,
                      apiKey: form.apiKey || undefined,
                    });
                    setForm({
                      name: "",
                      baseUrl: "https://",
                      prefix: "",
                      apiKey: "",
                      id: "",
                    });
                    await refresh();
                    setTab("models");
                  } finally {
                    setSaving(false);
                  }
                });
              }}
            >
              <h3>{form.id ? "编辑服务商" : "添加服务商"}</h3>
              <label>
                名称
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Base URL
                <input
                  required
                  type="url"
                  placeholder="https://example.com/v1"
                  value={form.baseUrl}
                  onChange={(e) =>
                    setForm({ ...form, baseUrl: e.target.value })
                  }
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    form.id ? "留空保留已有密钥" : "输入专用 API Key"
                  }
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </label>
              <label>
                显示前缀（可选）
                <input
                  placeholder="OR/"
                  value={form.prefix}
                  onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                />
              </label>
              <button className="primary" disabled={saving}>
                {saving ? "正在连接…" : "保存并获取模型"}
              </button>
            </form>
          </>
        )}
        {tab === "models" && (
          <>
            <h3>模型</h3>
            <p className="muted">
              新发现的模型默认关闭。前缀只用于显示，发送时使用原始模型 ID。
            </p>
            <input
              aria-label="筛选设置模型"
              placeholder="搜索模型或服务商…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="inline-actions">
              {[
                ["全部开启", true, false],
                ["全部关闭", false, false],
                ["开启搜索结果", true, true],
              ].map(([label, enabled, onlyResults]) => (
                <button
                  key={String(label)}
                  onClick={() =>
                    void run(async () => {
                      for (const p of providers) {
                        const ids = onlyResults
                          ? modelRows
                              .filter((m) => m.p.id === p.id)
                              .map((m) => m.id)
                          : p.models.map((m) => m.id);
                        await api("/providers/" + p.id + "/models", "PUT", {
                          models: ids.map((id) => ({ id, enabled })),
                        });
                      }
                      await refresh();
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              默认聊天模型
              <select
                value={
                  settings.defaultModel
                    ? JSON.stringify(settings.defaultModel)
                    : ""
                }
                onChange={(e) =>
                  void run(() =>
                    saveSettings({
                      ...settings,
                      defaultModel: e.target.value
                        ? JSON.parse(e.target.value)
                        : null,
                    }),
                  )
                }
              >
                <option value="">未设置</option>
                {providers.flatMap((p) =>
                  p.models.map((m) => (
                    <option
                      value={JSON.stringify({
                        providerId: p.id,
                        modelId: m.id,
                      })}
                      key={p.id + "/" + m.id}
                    >
                      {p.prefix + m.id} · {p.name}
                    </option>
                  )),
                )}
              </select>
            </label>
            {modelRows.map((m) => (
              <div className="model-entry" key={m.p.id + "/" + m.id}>
                <div className="model-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) =>
                        void run(async () => {
                          await api("/providers/" + m.p.id + "/models", "PUT", {
                            models: [{ id: m.id, enabled: e.target.checked }],
                          });
                          await refresh();
                        })
                      }
                    />
                    <span>
                      {m.p.prefix + m.id}
                      <small>{m.p.name}</small>
                    </span>
                  </label>
                  <label>
                    上下文预算
                    <input
                      aria-label={m.id + "上下文预算"}
                      type="number"
                      min="1"
                      defaultValue={m.capacity}
                      onBlur={(e) =>
                        void run(async () => {
                          await api("/providers/" + m.p.id + "/models", "PUT", {
                            models: [
                              { id: m.id, capacity: Number(e.target.value) },
                            ],
                          });
                          await refresh();
                        })
                      }
                    />
                  </label>
                </div>
                <ModelControls
                  provider={m.p}
                  model={m}
                  run={run}
                  refresh={refresh}
                />
              </div>
            ))}
            {!modelRows.length && (
              <p className="muted">先保存一个服务商来获取模型列表。</p>
            )}
          </>
        )}
        {tab === "templates" && (
          <>
            <h3>系统提示词模板</h3>
            <p className="muted">
              选择后复制到当前聊天；更改模板不会改变旧聊天。
            </p>
            {settings.templates.map((t) => (
              <div className="template-card" key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <IconButton
                    label={"删除 " + t.name}
                    onClick={() =>
                      void run(() =>
                        saveSettings({
                          ...settings,
                          templates: settings.templates.filter(
                            (v) => v.id !== t.id,
                          ),
                        }),
                      )
                    }
                  >
                    <X size={15} />
                  </IconButton>
                </div>
                <textarea
                  defaultValue={t.content}
                  onBlur={(e) =>
                    void run(() =>
                      saveSettings({
                        ...settings,
                        templates: settings.templates.map((v) =>
                          v.id === t.id ? { ...v, content: e.target.value } : v,
                        ),
                      }),
                    )
                  }
                />
              </div>
            ))}
            <label>
              模板名称
              <input
                value={template.name}
                onChange={(e) =>
                  setTemplate({ ...template, name: e.target.value })
                }
              />
            </label>
            <label>
              提示词
              <textarea
                rows={6}
                value={template.content}
                onChange={(e) =>
                  setTemplate({ ...template, content: e.target.value })
                }
              />
            </label>
            <button
              className="primary"
              disabled={!template.name.trim()}
              onClick={() =>
                void run(async () => {
                  await saveSettings({
                    ...settings,
                    templates: [
                      ...settings.templates,
                      { id: crypto.randomUUID(), ...template },
                    ],
                  });
                  setTemplate({ name: "", content: "" });
                })
              }
            >
              保存模板
            </button>
          </>
        )}
        {tab === "appearance" && (
          <>
            <h3>外观</h3>
            <p className="muted">仅保存在此设备。</p>
            <label>
              主题
              <select
                aria-label="主题"
                value={appearance.theme}
                onChange={(e) =>
                  setAppearance({ ...appearance, theme: e.target.value })
                }
              >
                <option value="system">跟随系统</option>
                <option value="dark">暗色</option>
                <option value="light">浅色</option>
              </select>
            </label>
            <label>
              字号 {appearance.font}px
              <input
                type="range"
                min={13}
                max={24}
                value={appearance.font}
                onChange={(e) =>
                  setAppearance({ ...appearance, font: Number(e.target.value) })
                }
              />
            </label>
            <label>
              内容宽度 {appearance.width}px
              <input
                type="range"
                min={600}
                max={1200}
                step={20}
                value={appearance.width}
                onChange={(e) =>
                  setAppearance({
                    ...appearance,
                    width: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              行间距 {appearance.line}
              <input
                type="range"
                min={1.3}
                max={2.4}
                step={0.1}
                value={appearance.line}
                onChange={(e) =>
                  setAppearance({ ...appearance, line: Number(e.target.value) })
                }
              />
            </label>
            <label className="toggle">
              折叠超长消息
              <input
                type="checkbox"
                checked={appearance.collapse}
                onChange={(e) =>
                  setAppearance({ ...appearance, collapse: e.target.checked })
                }
              />
            </label>
            <label className="toggle">
              电脑按 Enter 发送
              <input
                type="checkbox"
                checked={appearance.enter}
                onChange={(e) =>
                  setAppearance({ ...appearance, enter: e.target.checked })
                }
              />
            </label>
          </>
        )}
        {tab === "security" && (
          <>
            <h3>登录设备</h3>
            {sessions.map((s) => (
              <div className="provider-card" key={s.id}>
                <div>
                  {s.current ? "当前设备" : "其他设备"}
                  <small>{s.device}</small>
                  <small>{new Date(s.createdAt).toLocaleString()}</small>
                </div>
                <button
                  onClick={() =>
                    void run(async () => {
                      await api("/auth/revoke", "POST", { id: s.id });
                      if (s.current) onLogout();
                      else setSessions(await api("/auth/sessions"));
                    })
                  }
                >
                  退出
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                void run(async () => {
                  await api("/auth/revoke", "POST", { all: true });
                  onLogout();
                })
              }
            >
              退出全部设备
            </button>
            <h3>修改密码</h3>
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </label>
            <button
              disabled={!oldPassword}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ recoveryCode: string }>(
                    "/auth/recovery-code",
                    "POST",
                    { password: oldPassword },
                  );
                  setRecovery(result.recoveryCode);
                  setRecoveryRevoked(false);
                  setOldPassword("");
                })
              }
            >
              更新离线恢复码
            </button>
            <label>
              新密码（至少 12 字符）
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <button
              disabled={newPassword.length < 12}
              onClick={() => {
                void run(async () => {
                  const r = await api<{ recoveryCode: string }>(
                    "/auth/password",
                    "POST",
                    { password: oldPassword, newPassword },
                  );
                  setRecovery(r.recoveryCode);
                  setRecoveryRevoked(true);
                  setOldPassword("");
                  setNewPassword("");
                });
              }}
            >
              更改密码并退出全部设备
            </button>
            {recovery && (
              <div className="recovery-box">
                <strong>请立即离线保存新的恢复码</strong>
                <code>{recovery}</code>
                <p>
                  {recoveryRevoked
                    ? "所有会话已注销；关闭后请重新登录。"
                    : "旧恢复码已失效，登录会话保留。"}
                </p>
                <button
                  onClick={() =>
                    recoveryRevoked ? onLogout() : setRecovery("")
                  }
                >
                  已保存{recoveryRevoked ? "，返回登录" : ""}
                </button>
              </div>
            )}
            <hr />
            <button
              onClick={() =>
                void run(async () => {
                  await api("/auth/logout", "POST", {});
                  onLogout();
                })
              }
            >
              <LogOut size={16} />
              退出当前设备
            </button>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DeviceConnectionProvider>
      <App />
    </DeviceConnectionProvider>
  </React.StrictMode>,
);
