import type { PluginInputRequest } from "./plugin-sections-ui";
import type { PluginRun } from "../shared/plugins";
import { AccountUsageSidebar, AccountUsageSettings } from "./account-usage";
import type { AccountUsage } from "../shared/account-usage";
import {
  AppearanceSettings,
  readAppearance,
  applyAppearance,
  type Appearance,
} from "./appearance";
import { MessageTokenBar } from "./usage-bar";
import {
  ReplySummaryCard,
  SummaryTools,
  ConfirmPostSend,
} from "./summaries-ui";
import {
  summarySourceKeys,
  type SummaryState,
  type SummaryRun,
  type PostJobView,
} from "../shared/summaries";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  Gauge,
  Cable,
  Server,
  Boxes,
  Database,
  FolderMinus,
  Shield,
  HardDriveDownload,
  ToggleLeft,
  ToggleRight,
  ListChecks,
  Sparkles,
  Pin,
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
  LogOut,
  Pencil,
  Search,
  CircleAlert,
  FileText,
  Info,
  CirclePlay,
  Palette,
  UserRound,
  Blocks,
  WandSparkles,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type Chat,
  type Message,
  type Provider,
  type Settings,
  route,
  indexChildren,
  markdownExport,
  estimateTokens,
  contextMessages,
  defaultSettings,
} from "../shared/chat";
import { api, download, ApiError } from "./api";
import { type LoginNotice, PASSWORD_MIN_LENGTH } from "../shared/auth";
import {
  LoginNoticeBanner,
  readLoginNotice,
  saveLoginNotice,
} from "./login-notice";
import { observeJob } from "./job-events";
import "./style.css";
import {
  IconButton,
  ParameterControl,
  useDialogFocus,
  Loading,
} from "./controls";
import { ModelControls, SystemPrompts, MessageUsage } from "./chat-controls";
import { SettingsTools } from "./settings-tools";
import { ProvidersPanel } from "./providers-panel";
import { NameDialog } from "./name-dialog";
import { ConversationTimeline } from "./conversation-timeline";
import { MessageEditor } from "./message-editor";
import { ImportDialog } from "./import-dialog";
import {
  DeviceConnectionProvider,
  useDeviceConnection,
} from "./device-connection";
import type { GenerationStart } from "../shared/direct";
import type { CompletionOutput } from "../shared/completion";
import type { DirectTask } from "../shared/direct";
import { ChatListMenu } from "./chat-list-menu";
import { ContextUsage, EffortControl, AccountMenu } from "./composer-widgets";
import {
  PluginBar,
  GlobalPlugins,
  PluginTurnCards,
  Suggestions,
  RewriteReview,
  DraftReplacement,
  GroupPicker,
  MessageDeleteDialog,
} from "./plugins-ui";
import {
  emptyPluginState,
  enabledPlugins,
  type PluginState,
  type PluginJobView,
  type PluginBinding,
} from "../shared/plugins";
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
  const [loginNotice, setLoginNotice] = useState<LoginNotice | null>(
    readLoginNotice,
  );
  const [summaryState, setSummaryState] = useState<SummaryState>({ runs: [] });
  // Replacement candidates belong to this page visit. Accepted summaries remain durable.
  const ownedSummaryCandidates = useRef(new Set<string>()),
    pendingSummaryReviews = useRef(new Set<string>()),
    discardedSummaryCandidates = useRef(new Set<string>());
  const adoptSummaries = useCallback(
    (chatId: string, incoming: SummaryState) => {
      for (const r of incoming.runs)
        if (
          r.status === "candidate" &&
          pendingSummaryReviews.current.has(r.messageId)
        )
          ownedSummaryCandidates.current.add(r.id);
      const abandoned = incoming.runs.filter(
        (r) =>
          r.status === "candidate" && !ownedSummaryCandidates.current.has(r.id),
      );
      setSummaryState(
        abandoned.length
          ? {
              runs: incoming.runs.filter(
                (r) =>
                  r.status !== "candidate" ||
                  ownedSummaryCandidates.current.has(r.id),
              ),
            }
          : incoming,
      );
      const ids = abandoned
        .map((r) => r.id)
        .filter((id) => !discardedSummaryCandidates.current.has(id));
      if (ids.length) {
        for (const id of ids) discardedSummaryCandidates.current.add(id);
        for (let start = 0; start < ids.length; start += 256)
          void api(`/chats/${chatId}/summaries`, "POST", {
            action: "discard-candidates",
            runIds: ids.slice(start, start + 256),
          }).catch(() => {
            /* Hidden locally; a new page visit will retry cleanup. */
          });
      }
    },
    [],
  );
  const [postJobs, setPostJobs] = useState<PostJobView[]>([]);
  const [confirmPostSend, setConfirmPostSend] = useState(false);
  const [pluginEntry, setPluginEntry] = useState<HTMLDivElement | null>(null);
  const [startingRewrite, setStartingRewrite] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    chatId: string;
    messageId: string;
  } | null>(null);
  const pluginPreviewState = useRef<PluginState>(emptyPluginState());
  const [pluginState, setPluginState] = useState<PluginState>(emptyPluginState),
    [pluginJob, setPluginJob] = useState<PluginJobView | null>(null),
    [debugPlugins, setDebugPlugins] = useState(false),
    [suggestionDraft, setSuggestionDraft] = useState<string | null>(null),
    [moveChat, setMoveChat] = useState<Brief | null>(null);
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
  useEffect(() => setConfirmPostSend(false), [chat?.id]);
  const [draft, setDraft] = useState(""),
    [sidebar, setSidebar] = useState(innerWidth > 760),
    [panel, setPanel] = useState(false),
    [panelTab, setPanelTab] = useState("settings"),
    [modal, setModal] = useState(""),
    [modelMenu, setModelMenu] = useState(false),
    [search, setSearch] = useState(""),
    [view, setView] = useState("active");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [groupNameDialog, setGroupNameDialog] = useState<{
    id?: string;
    initial: string;
  } | null>(null);
  const [menu, setMenu] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false),
    [editSaving, setEditSaving] = useState(false),
    [editing, setEditing] = useState<{
      id: string;
      content: string;
      expanded: boolean;
      offset: number;
    } | null>(null),
    [groupMenu, setGroupMenu] = useState<string | null>(null),
    [scrollBottom, setScrollBottom] = useState(false);
  const [pluginInput, setPluginInput] = useState<PluginInputRequest | null>(
    null,
  );
  const inputDrafts = useRef(new Map<string, string>());
  const [clarifyDrafts, setClarifyDrafts] = useState<Record<string, string>>(
    {},
  );
  const [clarifySelections, setClarifySelections] = useState<
    Record<string, Record<string, string[]>>
  >({});
  const ownedSectionCandidates = useRef(new Set<string>()),
    discardedSectionCandidates = useRef(new Set<string>());
  function cleanPluginState(incoming: PluginState, id: string): PluginState {
    const abandoned = incoming.runs.filter(
      (r) =>
        r.sectionEdit &&
        !ownedSectionCandidates.current.has(r.id) &&
        ["candidate", "error", "cancelled"].includes(r.status),
    );
    const ids = abandoned
      .map((r) => r.id)
      .filter((id) => !discardedSectionCandidates.current.has(id));
    if (ids.length) {
      ids.forEach((id) => discardedSectionCandidates.current.add(id));
      void api("/chats/" + id + "/plugins", "POST", {
        action: "discard-sections",
        runIds: ids,
      }).catch(() => {});
    }
    return {
      ...incoming,
      runs: incoming.runs.filter(
        (r) =>
          !r.sectionEdit ||
          r.status === "complete" ||
          ownedSectionCandidates.current.has(r.id),
      ),
    };
  }
  useEffect(() => {
    setPluginInput(null);
    setClarifyDrafts({});
    setClarifySelections({});
    inputDrafts.current.clear();
  }, [chat?.id]);
  function requestPluginInput(value: PluginInputRequest) {
    if (pluginInput)
      inputDrafts.current.set(
        pluginInput.runId + ":" + (pluginInput.body.targetId ?? "add"),
        pluginInput.draft,
      );
    setPluginInput({
      ...value,
      draft:
        inputDrafts.current.get(
          value.runId + ":" + (value.body.targetId ?? "add"),
        ) ?? value.draft,
    });
    textarea.current?.focus({ preventScroll: true });
  }
  const [settingsTab, setSettingsTab] = useState("providers");
  const [quota, updateQuota] = useState<AccountUsage | null>(null);
  const setQuota = (value: AccountUsage | null) =>
    updateQuota((previous) =>
      previous &&
      value &&
      (previous.day > value.day ||
        (previous.day === value.day &&
          (previous.fetchedAt ?? 0) > (value.fetchedAt ?? 0)))
        ? previous
        : value,
    );
  const refreshQuota = async () => {
    if (quota && Date.now() < quota.nextRefreshAt) return;
    setQuota(await api<AccountUsage>("/account-usage?refresh=1"));
  };
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
    scrollGesture = useRef({
      upward: 0,
      time: 0,
      downward: false,
      touchY: 0,
      lastTop: 0,
    }),
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
  const navigationRequest = useRef<Promise<{
    chats: Brief[];
    groups: Group[];
    accountUsage?: AccountUsage;
  }> | null>(null);
  const loadNavigation = useCallback(async () => {
    const pending = (navigationRequest.current ??= api<{
      chats: Brief[];
      groups: Group[];
      accountUsage?: AccountUsage;
    }>("/navigation"));
    let data;
    try {
      data = await pending;
    } finally {
      if (navigationRequest.current === pending)
        navigationRequest.current = null;
    }
    const { chats: c, groups: g } = data;
    setChats(c);
    if (data.accountUsage) setQuota(data.accountUsage);
    setChat((previous) => {
      const current = c.find((item) => item.id === previous?.id);
      return previous && current
        ? { ...previous, title: current.title }
        : previous;
    });
    setGroups(g);
  }, []);
  const loadConfig = useCallback(async () => {
    const { providers: p, settings: s } = await api<{
      providers: ProviderView[];
      settings: Settings;
    }>("/config");
    setProviders(p);
    setSettings(s);
  }, []);
  const snapshotRequests = useRef(new Map<string, Promise<ChatSnapshot>>());
  const snapshotRevisions = useRef(new Map<string, number>());
  const refresh = useCallback(async (id = idRef.current, fresh = false) => {
    if (!id) return;
    // A completion must not reuse a snapshot started before the final save.
    if (fresh) await snapshotRequests.current.get(id)?.catch(() => {});
    const pending =
      snapshotRequests.current.get(id) ?? api<ChatSnapshot>("/chats/" + id);
    snapshotRequests.current.set(id, pending);
    let result;
    try {
      result = await pending;
    } finally {
      if (snapshotRequests.current.get(id) === pending)
        snapshotRequests.current.delete(id);
    }
    if (idRef.current !== id) return;
    if (result.revision < (snapshotRevisions.current.get(id) ?? 0)) return;
    snapshotRevisions.current.set(id, result.revision);
    setChat(connection.overlay(result.chat));
    setJob(result.job);
    setTitleJob(result.titleJob ?? null);
    setPluginState(
      connection.pluginOverlay(
        cleanPluginState(
          result.pluginState ?? emptyPluginState(),
          result.chat.id,
        ),
      ),
    );
    pluginPreviewState.current = cleanPluginState(
      result.pluginState ?? emptyPluginState(),
      result.chat.id,
    );
    setPluginJob(result.pluginJob ?? null);
    adoptSummaries(id, result.summaryState ?? { runs: [] });
    setPostJobs(result.postJobs ?? []);
    if (result.generation) acceptGeneration(result.generation);
    if (
      !result.job &&
      result.chat.unread &&
      document.visibilityState === "visible"
    ) {
      await api("/chats/" + id + "/seen", "POST", {});
      setChat((previous) =>
        previous?.id === id ? { ...previous, unread: false } : previous,
      );
      setChats((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, unread: false } : item,
        ),
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
  async function open(id: string, snapshot?: ChatSnapshot) {
    const sequence = ++navigationSeq.current;
    setOpening(true);
    try {
      await activeSend.current?.catch(() => {});
      await creating.current?.catch(() => {});
      if (sequence !== navigationSeq.current) return;
      await flushDraft();
      let result = snapshot ?? (await api<ChatSnapshot>("/chats/" + id));
      if (result.revision < (snapshotRevisions.current.get(id) ?? 0))
        result = await api<ChatSnapshot>("/chats/" + id);
      if (sequence !== navigationSeq.current) return;
      idRef.current = id;
      scrollIntent.current = {};
      localStorage.setItem("lastChat", id);
      snapshotRevisions.current.set(
        id,
        Math.max(result.revision, snapshotRevisions.current.get(id) ?? 0),
      );
      setChat(connection.overlay(result.chat));
      setJob(result.job);
      setTitleJob(result.titleJob ?? null);
      setPluginState(
        connection.pluginOverlay(
          cleanPluginState(
            result.pluginState ?? emptyPluginState(),
            result.chat.id,
          ),
        ),
      );
      pluginPreviewState.current = cleanPluginState(
        result.pluginState ?? emptyPluginState(),
        result.chat.id,
      );
      setPluginJob(result.pluginJob ?? null);
      adoptSummaries(id, result.summaryState ?? { runs: [] });
      setPostJobs(result.postJobs ?? []);
      setDebugPlugins(false);
      if (result.generation) acceptGeneration(result.generation);
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
        setChat((previous) =>
          previous?.id === id ? { ...previous, unread: false } : previous,
        );
        setChats((previous) =>
          previous.map((item) =>
            item.id === id ? { ...item, unread: false } : item,
          ),
        );
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
  type ChatSnapshot = {
    revision: number;
    chat: Chat;
    job: typeof job;
    titleJob: typeof titleJob;
    summaryState?: SummaryState;
    postJobs?: PostJobView[];
    pluginState?: PluginState;
    pluginJob?: PluginJobView | null;
    generation?: GenerationStart;
  };
  type Bootstrap = {
    requestedChatId?: string | null;
    accountUsage?: AccountUsage;
    authenticated: boolean;
    chats: Brief[];
    groups: Group[];
    providers: ProviderView[];
    settings: Settings;
    current: ChatSnapshot | null;
  };
  const boot = useRef<Bootstrap | null>(null);
  const bootRequest = useRef<Promise<Bootstrap> | null>(null);
  const bootstrap = () => {
    if (!bootRequest.current) {
      const requestedChatId = localStorage.getItem("lastChat");
      bootRequest.current = api<Bootstrap>(
        "/bootstrap" +
          (requestedChatId
            ? "?chatId=" + encodeURIComponent(requestedChatId)
            : ""),
      )
        .then((data) => ({ ...data, requestedChatId }))
        .finally(() => {
          bootRequest.current = null;
        });
    }
    return bootRequest.current;
  };
  useEffect(() => {
    void run(async () => {
      const data = await bootstrap();
      boot.current = data.authenticated ? data : null;
      setAuth(data.authenticated);
    });
  }, [run]);
  useEffect(() => {
    if (!auth) return;
    setInitializing(true);
    void run(async () => {
      try {
        const data = boot.current ?? (await bootstrap());
        boot.current = null;
        if (!data.authenticated) {
          setAuth(false);
          return;
        }
        setChats(data.chats);
        setQuota(data.accountUsage ?? null);
        setGroups(data.groups);
        setProviders(data.providers);
        setSettings(data.settings);
        if (data.current) await open(data.current.chat.id, data.current);
        else if (localStorage.getItem("lastChat") === data.requestedChatId)
          localStorage.removeItem("lastChat");
      } finally {
        setInitializing(false);
      }
    });
  }, [auth]);
  useEffect(() => {
    if (auth === false) {
      connection.lock();
      setLoginNotice(null);
      saveLoginNotice(null);
    }
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
    const apply = () => applyAppearance(appearance, media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    if (!dirty.current) return;
    const timeout = setTimeout(() => void run(flushDraft), 700);
    return () => clearTimeout(timeout);
  }, [draft]);
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  const [pushUnavailable, setPushUnavailable] = useState(false);
  const [manualTitle, setManualTitle] = useState<{
    id: string;
    chatId: string;
  } | null>(null);
  const latestSync = useRef({ refresh, loadNavigation, run });
  latestSync.current = { refresh, loadNavigation, run };
  useEffect(() => {
    if (!auth || !visible) return;
    const running =
      !!job ||
      !!pluginJob ||
      postJobs.length > 0 ||
      ["pending", "running"].includes(titleJob?.status ?? "");
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      const latest = latestSync.current;
      await latest.run(async () => {
        if (running) await latest.refresh();
        await latest.loadNavigation();
      }, false);
      if (!cancelled)
        timer = setTimeout(tick, running && pushUnavailable ? 5000 : 60000);
    };
    timer = setTimeout(tick, running && pushUnavailable ? 5000 : 60000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    auth,
    visible,
    job?.id,
    pluginJob?.id,
    titleJob?.id,
    titleJob?.status,
    pushUnavailable,
    postJobs.length,
  ]);
  useEffect(() => {
    if (!auth) return;
    const id = chat?.id;
    const cleanups: (() => void)[] = [];
    for (const task of postJobs) {
      const update = (content: string) => {
        if (idRef.current !== id) return;
        if (task.kind === "summary")
          setSummaryState((prev) => ({
            ...prev,
            runs: prev.runs.map((r) =>
              r.id === task.runId ? { ...r, output: content } : r,
            ),
          }));
        else
          setPluginState((prev) => ({
            ...prev,
            runs: prev.runs.map((r) =>
              r.id === task.runId ? { ...r, output: content } : r,
            ),
          }));
      };
      const done = (failure?: string) => {
        if (failure && idRef.current === id) setError(failure);
        const latest = latestSync.current;
        void latest.run(() => latest.refresh(id, true), false);
      };
      if (task.transport === "device")
        connection.startPlugin(task, (output) => update(output.content), done);
      else if (visible)
        cleanups.push(
          observeJob(
            task.id,
            false,
            update,
            () => done(),
            () => setPushUnavailable(true),
          ),
        );
    }
    return () => cleanups.forEach((fn) => fn());
  }, [auth, visible, chat?.id, postJobs.map((j) => j.id).join(",")]);
  async function summaryCommand(
    action: string,
    body: Record<string, unknown> = {},
  ) {
    const id = idRef.current;
    if (!id) return;
    const reviewMessage =
      action === "regenerate" && typeof body.messageId === "string"
        ? body.messageId
        : undefined;
    if (reviewMessage) pendingSummaryReviews.current.add(reviewMessage);
    try {
      const result = await api<{ jobId?: string }>(
        "/chats/" + id + "/summaries",
        "POST",
        { action, ...body },
      );
      if (reviewMessage && result.jobId)
        ownedSummaryCandidates.current.add(result.jobId);
    } finally {
      if (reviewMessage) pendingSummaryReviews.current.delete(reviewMessage);
    }
    await refresh(id, true);
  }
  useEffect(() => {
    if (!auth || !pluginJob) return;
    const task = pluginJob,
      id = chat?.id;
    const update = (content: string) => {
      if (idRef.current === id)
        setPluginState((previous) => ({
          ...previous,
          runs: previous.runs.map((r) =>
            r.id === task.runId ? { ...r, output: content } : r,
          ),
        }));
    };
    const done = (failure?: string) => {
      if (failure) setError(failure);
      const latest = latestSync.current;
      void latest.run(async () => {
        await latest.refresh(id, true);
        await latest.loadNavigation();
      }, false);
    };
    if (task.transport === "device") {
      connection.startPlugin(task, (output) => update(output.content), done);
      return;
    }
    if (!visible) return;
    return observeJob(
      task.id,
      false,
      (content) => update(content),
      () => done(),
      () => setPushUnavailable(true),
    );
  }, [auth, visible, pluginJob?.id]);
  useEffect(() => {
    setPushUnavailable(false);
    if (!auth || !visible || !job || job.transport === "device") return;
    const id = chat?.id,
      messageId = Object.values(chat?.messages ?? {}).find(
        (m) => m.status === "running",
      )?.id;
    return observeJob(
      job.id,
      false,
      (content, reasoning) => {
        if (!messageId) return;
        setChat((previous) =>
          !previous || previous.id !== id || !previous.messages[messageId]
            ? previous
            : {
                ...previous,
                messages: {
                  ...previous.messages,
                  [messageId]: {
                    ...previous.messages[messageId]!,
                    content,
                    reasoning,
                    status: "running",
                  },
                },
              },
        );
      },
      () => {
        const latest = latestSync.current;
        void latest.run(async () => {
          await latest.refresh(id, true);
          await latest.loadNavigation();
        }, false);
      },
      () => setPushUnavailable(true),
    );
  }, [auth, visible, job?.id]);
  useEffect(() => {
    if (
      !auth ||
      !visible ||
      !titleJob ||
      titleJob.transport === "device" ||
      !["pending", "running"].includes(titleJob.status)
    )
      return;
    const id = chat?.id;
    return observeJob(
      titleJob.id,
      true,
      () => {},
      () => {
        const latest = latestSync.current;
        void latest.run(async () => {
          await latest.refresh(id, true);
          await latest.loadNavigation();
        }, false);
      },
      () => setPushUnavailable(true),
    );
  }, [auth, visible, titleJob?.id, titleJob?.status]);
  useEffect(() => {
    if (!auth || !visible || !manualTitle || manualTitle.id === titleJob?.id)
      return;
    return observeJob(
      manualTitle.id,
      true,
      () => {},
      () => {
        setManualTitle(null);
        const latest = latestSync.current;
        void latest.run(latest.loadNavigation, false);
      },
      () => setManualTitle(null),
    );
  }, [auth, visible, manualTitle?.id, titleJob?.id]);
  useEffect(() => {
    if (!auth) return;
    let last = 0;
    const activate = () => {
      const active = document.visibilityState === "visible";
      setVisible(active);
      if (!active || Date.now() - last < 5000) return;
      last = Date.now();
      const latest = latestSync.current;
      void latest.run(async () => {
        await latest.refresh();
        await latest.loadNavigation();
      }, false);
    };
    document.addEventListener("visibilitychange", activate);
    return () => document.removeEventListener("visibilitychange", activate);
  }, [auth]);
  const scrollIntent = useRef<{ id?: string; offset?: number } | null>(null);
  function noteScrollGesture(delta: number) {
    const gesture = scrollGesture.current,
      now = Date.now();
    if (now - gesture.time > 700) gesture.upward = 0;
    gesture.time = now;
    gesture.downward = delta > 0;
    if (delta >= 0) {
      gesture.upward = 0;
      return;
    }
    gesture.upward += -delta;
    if (gesture.upward >= 48) {
      stick.current = false;
      if (!scrollIntent.current?.id) scrollIntent.current = null;
      setScrollBottom(true);
    }
  }
  function messageElement(id: string) {
    return scrollRef.current?.querySelector<HTMLElement>(
      '[data-message-id="' + CSS.escape(id) + '"]',
    );
  }
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const intent = scrollIntent.current;
    if (intent?.id) {
      const element = messageElement(intent.id);
      if (element) {
        container.scrollTop +=
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          (intent.offset ?? 18);
        scrollIntent.current = null;
        stick.current = false;
      }
    } else if (intent || (stick.current && !editing)) {
      container.scrollTop = container.scrollHeight;
      scrollIntent.current = null;
      stick.current = true;
    }
  }, [
    chat?.messages,
    chat?.id,
    pluginState,
    draft,
    editing?.id,
    editing?.expanded,
  ]);
  function beginEdit(message: Message) {
    setError("");
    const offset = Math.max(
      18,
      Math.min(
        messageElement(message.id)!.getBoundingClientRect().top -
          scrollRef.current!.getBoundingClientRect().top,
        scrollRef.current!.clientHeight - 140,
      ),
    );
    stick.current = false;
    scrollIntent.current = { id: message.id, offset };
    setEditing({
      id: message.id,
      content: message.content,
      expanded: false,
      offset,
    });
  }
  function finishEdit() {
    if (editing)
      scrollIntent.current = { id: editing.id, offset: editing.offset };
    setEditing(null);
  }
  async function patch(
    value: Partial<Omit<Chat, "rounds">> & { rounds?: number | null },
  ) {
    if (!chat) return;
    await flushDraft();
    const updated = await api<Chat>("/chats/" + chat.id, "PATCH", value);
    setChat((previous) =>
      previous?.id === updated.id
        ? { ...updated, messages: previous.messages }
        : previous,
    );
    if (
      ["title", "pinned", "archived", "deleted", "groupId"].some(
        (key) => key in value,
      )
    )
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
          await refresh(task.chatId, true);
          await loadNavigation();
        }, false);
      },
    );
  }
  async function action(
    name: string,
    body: Record<string, unknown> = {},
    revealMessage?: string,
  ) {
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
    if (
      ["select", "fork", "regenerate", "retry", "continue"].includes(name) ||
      (name === "edit" &&
        chat.messages[String(body.messageId)]?.role === "user")
    ) {
      stick.current = !revealMessage;
      scrollIntent.current = revealMessage ? { id: revealMessage } : {};
    }
    if (name === "fork") {
      await loadNavigation();
      await open(result.id);
    } else {
      await refresh();
      await loadNavigation();
    }
  }
  async function send(confirmedPost = false) {
    if (pluginInput) {
      if (
        submitting.current ||
        busy ||
        job ||
        pluginJob ||
        !pluginInput.draft.trim()
      )
        return;
      submitting.current = true;
      setBusy(true);
      try {
        await pluginCommand("section-generate", {
          runId: pluginInput.runId,
          ...pluginInput.body,
          content: pluginInput.draft,
        });
        inputDrafts.current.delete(
          pluginInput.runId + ":" + (pluginInput.body.targetId ?? "add"),
        );
        setPluginInput(null);
      } finally {
        submitting.current = false;
        setBusy(false);
      }
      return;
    }
    if (waitingPlugin) {
      await answerClarification(waitingPlugin, false);
      return;
    }
    if (
      !selectedModel ||
      submitting.current ||
      job ||
      pluginJob ||
      (pluginFlow && !waitingPlugin) ||
      opening ||
      initializing ||
      !draftRef.current.trim()
    )
      return;
    if (!waitingPlugin && postJobs.length && !confirmedPost) {
      setConfirmPostSend(true);
      return;
    }
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
        { content: sent, debugPlugins, confirmPost: confirmedPost },
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
    } catch (e) {
      if (e instanceof Error && e.message.includes("请确认后继续发送"))
        setConfirmPostSend(true);
      else throw e;
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
  const path = useMemo(
    () => (chat ? route(chat) : []),
    [chat?.messages, chat?.currentId],
  );
  const summaryKeys = useMemo(() => summarySourceKeys(path), [path]);
  const summaryRuns = useMemo(() => {
    const grouped = new Map<string, SummaryRun[]>();
    for (const run of summaryState.runs) {
      const rows = grouped.get(run.messageId);
      if (rows) rows.push(run);
      else grouped.set(run.messageId, [run]);
    }
    return grouped;
  }, [summaryState.runs]);
  const byParent = useMemo(
    () => (chat ? indexChildren(chat) : new Map<string | null, Message[]>()),
    [chat?.messages],
  );
  const pathIds = new Set(path.map((m) => m.id)),
    lastAssistant = path.findLast((m) => m.role === "assistant")?.id;
  const estimate = estimateTokens(
      chat
        ? contextMessages(chat, draft)
            .map((m) => m.content)
            .join("\n")
        : draft,
    ),
    capacity = selectedModel?.capacity ?? 1048576;
  const filteredChats = chats.filter((c) =>
    view === "trash" ? c.deleted : !c.archived && !c.deleted,
  );
  const sorted = (items: Brief[]) =>
    [...items].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
  function updateDraft(value: string) {
    if (pluginInput) {
      setPluginInput({ ...pluginInput, draft: value });
      return;
    }
    if (waitingPlugin) {
      setClarifyDrafts((v) => ({ ...v, [waitingPlugin.id]: value }));
      return;
    }
    draftVersion.current++;
    setDraft(value);
    draftRef.current = value;
    dirty.current = true;
  }
  const pluginFlow = pluginState.flows.findLast(
    (f) =>
      pathIds.has(f.userId) &&
      ["running", "waiting", "error", "debug"].includes(f.status),
  );
  const waitingPlugin = pluginState.runs.findLast(
    (r) =>
      r.flowId === pluginFlow?.id &&
      r.id === pluginFlow?.results.at(-1) &&
      r.plugin.kind === "clarify" &&
      r.status === "waiting" &&
      !r.dismissed,
  );
  const composerValue =
    pluginInput?.draft ??
    (waitingPlugin ? (clarifyDrafts[waitingPlugin.id] ?? "") : draft);
  const hasClarifySelection =
    !!waitingPlugin &&
    Object.values(clarifySelections[waitingPlugin.id] ?? {}).some(
      (values) => values.length > 0,
    );
  function pluginDisplayName(id: string, fallback: string) {
    return chat
      ? (enabledPlugins(chat, settings).find((p) => p.id === id)?.name ??
          fallback)
      : fallback;
  }
  async function answerClarification(value: PluginRun, finish: boolean) {
    if (submitting.current || busy || job || pluginJob) return;
    submitting.current = true;
    setBusy(true);
    try {
      await pluginCommand(finish ? "finish-clarify" : "answer", {
        runId: value.id,
        content: clarifyDrafts[value.id] ?? "",
        selections: clarifySelections[value.id] ?? {},
      });
      setClarifyDrafts((d) => {
        const next = { ...d };
        delete next[value.id];
        return next;
      });
      setClarifySelections((d) => {
        const next = { ...d };
        delete next[value.id];
        return next;
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const rewriteResult = pluginState.runs.findLast(
    (r) =>
      r.plugin.kind === "rewrite" &&
      (r.rewriteMessageId
        ? r.rewriteMessageId === editing?.id
        : !editing && r.anchorId === chat?.currentId) &&
      r.status === "complete" &&
      !r.dismissed,
  );
  const rewriteError = pluginState.runs.findLast(
    (r) =>
      r.plugin.kind === "rewrite" &&
      (r.rewriteMessageId
        ? r.rewriteMessageId === editing?.id
        : !editing && r.anchorId === chat?.currentId) &&
      r.status === "error" &&
      !r.dismissed,
  );
  async function pluginCommand(
    action: string,
    body: Record<string, unknown> = {},
  ) {
    const id = idRef.current;
    if (!id) return;
    try {
      setError("");
      const response = await api<{ jobId?: string }>(
        "/chats/" + id + "/plugins",
        "POST",
        { action, ...body },
      );
      if (response.jobId && ["section-generate", "retry"].includes(action))
        ownedSectionCandidates.current.add(response.jobId);
      await refresh(id);
      await loadNavigation();
    } catch (error) {
      setError(error instanceof Error ? error.message : "插件操作失败");
      throw error;
    }
  }
  async function configurePlugins(plugins: PluginBinding[]) {
    await ensureComposerChat();
    await pluginCommand("configure", { plugins });
  }
  function rewriteButtons(
    content: string,
    messageId?: string,
    iconOnly = false,
  ) {
    if (!chat) return null;
    return enabledPlugins(chat, settings)
      .filter((p) => p.kind === "rewrite")
      .map((p) => (
        <button
          key={p.id}
          className={
            "du-btn du-btn-ghost du-btn-sm " +
            (iconOnly ? "du-btn-square icon-button" : "")
          }
          aria-label={p.name}
          title={p.name}
          disabled={
            !!job ||
            !!pluginJob ||
            busy ||
            startingRewrite !== null ||
            !content.trim()
          }
          onClick={() => {
            setStartingRewrite(p.id);
            void run(async () => {
              try {
                await pluginCommand("rewrite", {
                  pluginId: p.id,
                  content,
                  ...(messageId ? { messageId } : {}),
                });
              } finally {
                setStartingRewrite(null);
              }
            });
          }}
        >
          {startingRewrite === p.id ||
          pluginState.runs.some(
            (r) =>
              r.plugin.id === p.id &&
              r.status === "running" &&
              r.rewriteMessageId === messageId,
          ) ? (
            <Loading small />
          ) : (
            <WandSparkles size={16} />
          )}
          {!iconOnly && p.name}
        </button>
      ));
  }
  async function stopGeneration() {
    if (pluginJob) {
      if (connection.stopPlugin(pluginJob.id)) return;
      await pluginCommand("cancel");
    } else await action("stop");
  }
  function chooseSuggestion(text: string) {
    if (draftRef.current.trim()) setSuggestionDraft(text);
    else updateDraft(text);
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
    if (name === "group") {
      if (c.groupId) {
        await api("/chats/" + c.id, "PATCH", { groupId: null });
        await loadNavigation();
        if (idRef.current === c.id) await refresh();
      } else setMoveChat(c);
      return;
    }
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
      if (!connection.enabled)
        setManualTitle({ id: result.jobId, chatId: c.id });
    } else if (name === "duplicate") {
      const copy = await api<Chat>("/chats/" + c.id + "/duplicate", "POST", {});
      await loadNavigation();
      await open(copy.id);
      return;
    } else if (name === "restore") {
      await api("/chats/" + c.id, "PATCH", { deleted: false });
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
          <Loading small />
        ) : c.status === "error" ? (
          <CircleAlert size={13} className="danger-text" />
        ) : c.unread ? (
          <span className="unread" />
        ) : c.pinned ? (
          <Pin size={13} className="muted" />
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
        <Loading />
      </div>
    );
  if (!auth)
    return (
      <Login
        onLogin={(notice) => {
          setLoginNotice(notice ?? null);
          saveLoginNotice(notice ?? null);
          setAuth(true);
        }}
        error={error}
        run={run}
      />
    );
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
          <Sparkles className="brand-mark" size={25} aria-hidden="true" />
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
          新聊天
          <Plus className="new-chat-plus" size={14} aria-hidden="true" />
        </button>
        <div className="nav-list">
          <section className="archive-folder" aria-label="归档文件夹">
            <button
              aria-expanded={archiveOpen}
              onClick={() => setArchiveOpen(!archiveOpen)}
            >
              {archiveOpen ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              <Archive size={16} />
              <span>归档</span>
              <small>
                {chats.filter((c) => c.archived && !c.deleted).length}
              </small>
            </button>
            {archiveOpen && (
              <div className="archive-contents">
                {sorted(chats.filter((c) => c.archived && !c.deleted)).map(
                  chatRow,
                )}
                {!chats.some((c) => c.archived && !c.deleted) && (
                  <p className="nav-empty">还没有归档聊天</p>
                )}
              </div>
            )}
          </section>
          <div className="section-label">
            分组
            <IconButton
              label="新建分组"
              onClick={() => setGroupNameDialog({ initial: "" })}
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
                        title="重命名分组"
                        onClick={() => {
                          setGroupMenu(null);
                          setGroupNameDialog({ id: g.id, initial: g.name });
                        }}
                      >
                        <Pencil size={16} />
                        重命名
                      </button>
                      <button
                        className="danger-text"
                        title="移除分组，聊天回到主列表"
                        onClick={() =>
                          void run(async () => {
                            await api("/groups/" + g.id, "DELETE", {});
                            setGroupMenu(null);
                            await loadNavigation();
                            await refresh();
                          })
                        }
                      >
                        <FolderMinus size={16} />
                        解散分组
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
            {view === "trash" ? "回收站" : "聊天"}
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
          <AccountUsageSidebar
            usage={quota}
            open={() => showSettings("usage")}
          />
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
                label: view === "trash" ? "返回聊天" : "回收站",
                icon: <Trash2 size={19} />,
                onClick: () => setView(view === "trash" ? "active" : "trash"),
              },
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
                <Loading small />
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
        {loginNotice && (
          <LoginNoticeBanner
            notice={loginNotice}
            close={() => {
              setLoginNotice(null);
              saveLoginNotice(null);
            }}
          />
        )}
        {error && (
          <div className="error-banner du-alert du-alert-error" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            {chat && connection.unsaved(chat.id) && (
              <button
                onClick={() =>
                  void run(async () => {
                    await connection.retrySave(chat.id);
                    setError("");
                    await refresh(chat.id, true);
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
          onWheel={(e) => noteScrollGesture(e.deltaY)}
          onTouchStart={(e) => {
            scrollGesture.current.touchY = e.touches[0]?.clientY ?? 0;
          }}
          onTouchMove={(e) => {
            const y = e.touches[0]?.clientY;
            if (y === undefined) return;
            noteScrollGesture(scrollGesture.current.touchY - y);
            scrollGesture.current.touchY = y;
          }}
          onKeyDown={(e) => {
            if (["ArrowUp", "PageUp", "Home"].includes(e.key))
              noteScrollGesture(-60);
            if (["ArrowDown", "PageDown", "End"].includes(e.key))
              noteScrollGesture(60);
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget)
              scrollGesture.current.downward = true;
          }}
          onScroll={() => {
            const el = scrollRef.current!;
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            const upward = scrollGesture.current.lastTop - el.scrollTop;
            scrollGesture.current.lastTop = el.scrollTop;
            if (upward > 0) noteScrollGesture(-upward);
            // A small layout shift must never re-arm follow after an upward gesture.
            if (distance > 100) stick.current = false;
            else if (distance <= 4 && scrollGesture.current.downward) {
              stick.current = true;
              scrollGesture.current.downward = false;
              scrollGesture.current.upward = 0;
            }
            setScrollBottom(!stick.current);
          }}
        >
          {!path.length ? (
            <div className="welcome">
              <Sparkles
                className="welcome-symbol"
                size={44}
                aria-hidden="true"
              />
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
              {path.map((m) => {
                const siblings = chat
                    ? (byParent.get(m.parentId) ?? []).filter(
                        (s) => s.role === m.role,
                      )
                    : [],
                  version = siblings.findIndex((s) => s.id === m.id);
                return (
                  <article
                    key={m.id}
                    className={"message " + m.role}
                    data-message-id={m.id}
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
                      <MessageEditor
                        value={editing.content}
                        expanded={editing.expanded}
                        saving={editSaving}
                        busy={busy || !!job || !!pluginJob}
                        error={error}
                        user={m.role === "user"}
                        rewriteActions={rewriteButtons(editing.content, m.id)}
                        onChange={(content) =>
                          setEditing({ ...editing, content })
                        }
                        onExpand={(expanded) => {
                          scrollIntent.current = {
                            id: m.id,
                            offset: editing.offset,
                          };
                          setEditing({ ...editing, expanded });
                        }}
                        onCancel={finishEdit}
                        onSave={() => {
                          setEditSaving(true);
                          void run(async () => {
                            await action("edit", {
                              messageId: m.id,
                              content: editing.content,
                            });
                            if (m.role === "assistant")
                              scrollIntent.current = {
                                id: m.id,
                                offset: editing.offset,
                              };
                            else {
                              scrollIntent.current = {};
                              stick.current = true;
                            }
                            setEditing(null);
                          }).finally(() => setEditSaving(false));
                        }}
                      />
                    ) : (
                      <div className="message-body">
                        {m.reasoning && (
                          <details
                            className="reasoning-collapse du-collapse du-collapse-arrow"
                            open={m.status === "running"}
                          >
                            <summary className="du-collapse-title">
                              思考过程
                            </summary>
                            <div className="reasoning du-collapse-content">
                              {m.reasoning}
                            </div>
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
                            disabled={!!job || !!pluginJob}
                            onClick={() => beginEdit(m)}
                          >
                            <Pencil size={14} />
                          </IconButton>
                          {m.role === "assistant" && (
                            <IconButton
                              label="重新生成"
                              disabled={!!job || !!pluginJob}
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
                            disabled={!!job || !!pluginJob}
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
                              disabled={!!job || !!pluginJob}
                              onClick={() =>
                                void run(() =>
                                  action("continue", { messageId: m.id }),
                                )
                              }
                            >
                              <CirclePlay size={15} />
                            </IconButton>
                          )}
                          {m.role === "assistant" && m.status === "error" && (
                            <IconButton
                              label="重试为新版本"
                              disabled={!!job || !!pluginJob}
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
                          <IconButton
                            label="删除消息"
                            disabled={!!job || !!pluginJob || busy}
                            onClick={() =>
                              chat &&
                              setDeleteTarget({
                                chatId: chat.id,
                                messageId: m.id,
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </IconButton>
                          <MessageTokenBar message={m} />
                          {siblings.length > 1 && (
                            <div className="versions">
                              <IconButton
                                label="上个版本"
                                disabled={!!job || !!pluginJob || version === 0}
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
                                  !!job ||
                                  !!pluginJob ||
                                  version === siblings.length - 1
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
                        {m.role === "assistant" && (
                          <ReplySummaryCard
                            chat={chat!}
                            messageId={m.id}
                            sourceKey={summaryKeys.get(m.id) ?? ""}
                            runs={summaryRuns.get(m.id) ?? []}
                            latest={m.id === lastAssistant}
                            command={summaryCommand}
                          />
                        )}
                        {m.role === "user" && (
                          <PluginTurnCards
                            chatId={chat!.id}
                            userId={m.id}
                            state={pluginState}
                            activeUserId={pluginFlow?.userId}
                            selections={clarifySelections}
                            select={(runId, id, values) =>
                              setClarifySelections((current) => ({
                                ...current,
                                [runId]: { ...current[runId], [id]: values },
                              }))
                            }
                            input={requestPluginInput}
                            answer={(value, finish) =>
                              void run(() => answerClarification(value, finish))
                            }
                            templates={(id) =>
                              chat
                                ? (
                                    enabledPlugins(chat, settings).find(
                                      (p) => p.id === id,
                                    )?.analysisTypes ?? []
                                  ).map((t) => ({
                                    ...t,
                                    scope: chat.plugins
                                      ?.find((b) => b.id === id)
                                      ?.overrides?.analysisTypes?.some(
                                        (v) => v.id === t.id,
                                      )
                                      ? ("chat" as const)
                                      : ("global" as const),
                                  }))
                                : []
                            }
                            command={pluginCommand}
                            busy={busy || !!job || !!pluginJob}
                          />
                        )}
                        {m.role === "assistant" && (
                          <Suggestions
                            state={pluginState}
                            messageId={m.id}
                            onChoose={chooseSuggestion}
                            command={pluginCommand}
                            busy={busy || !!job || !!pluginJob}
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
                const container = scrollRef.current;
                if (container) container.scrollTop = container.scrollHeight;
                scrollGesture.current.upward = 0;
                setScrollBottom(false);
              }}
            >
              <ArrowDown size={17} />
            </IconButton>
          )}
          {pluginFlow && (
            <div className="plugin-flow-controls">
              <span>
                {waitingPlugin
                  ? `正在回答 ${waitingPlugin.plugin.name}`
                  : pluginFlow.status === "debug"
                    ? "调试完成，尚未生成正文"
                    : pluginFlow.status === "waiting"
                      ? "请确认写前分析结果"
                      : pluginFlow.status === "error"
                        ? "插件流程已暂停"
                        : "插件正在运行"}
              </span>
              {pluginFlow.status === "debug" && (
                <>
                  <button
                    className="du-btn du-btn-xs"
                    onClick={() => void run(() => pluginCommand("use"))}
                  >
                    <CirclePlay size={14} />
                    使用结果生成正文
                  </button>
                  <button
                    className="du-btn du-btn-xs"
                    onClick={() => void run(() => pluginCommand("debug-rerun"))}
                  >
                    <RotateCcw size={14} />
                    重新调试
                  </button>
                </>
              )}
              {pluginFlow.status === "error" &&
                !pluginState.runs.some(
                  (r) => r.flowId === pluginFlow.id && r.status === "error",
                ) && (
                  <>
                    <span role="alert">{pluginFlow.error}</span>
                    <button
                      className="du-btn du-btn-xs"
                      onClick={() => void run(() => pluginCommand("retry"))}
                    >
                      <RotateCcw size={14} />
                      重试流程
                    </button>
                  </>
                )}
              <button
                className="du-btn du-btn-ghost du-btn-xs"
                onClick={() =>
                  void run(() =>
                    pluginJob ? stopGeneration() : pluginCommand("cancel"),
                  )
                }
              >
                <X size={14} />
                取消本轮
              </button>
            </div>
          )}
          <PluginBar
            entryTarget={pluginEntry}
            chat={chat}
            settings={settings}
            providers={providers}
            state={pluginPreviewState.current}
            summaries={summaryState}
            summaryCommand={summaryCommand}
            draft={draft}
            debug={debugPlugins}
            setDebug={setDebugPlugins}
            configure={configurePlugins}
            command={pluginCommand}
            busy={busy || !!job || !!pluginJob}
          />
          <div
            className={
              "composer " +
              (expanded ? "expanded " : "") +
              (waitingPlugin || pluginInput ? "plugin-reply" : "")
            }
          >
            {pluginInput && (
              <div className="composer-operation">
                <span>{pluginInput.label}</span>
                <button
                  className="du-btn du-btn-ghost du-btn-xs"
                  onClick={() => {
                    inputDrafts.current.set(
                      pluginInput.runId +
                        ":" +
                        (pluginInput.body.targetId ?? "add"),
                      pluginInput.draft,
                    );
                    setPluginInput(null);
                  }}
                >
                  取消操作
                </button>
              </div>
            )}
            {!selectedModel && (
              <p className="muted" role="status">
                没有可用的当前模型或默认模型，请在设置中添加服务商并选择有效的默认模型。
              </p>
            )}
            <div className="composer-input">
              <textarea
                className="du-textarea"
                ref={textarea}
                disabled={opening || initializing}
                aria-label="消息"
                placeholder={
                  pluginInput
                    ? `请输入${pluginInput.label}…`
                    : waitingPlugin
                      ? `你现在正在回复「${pluginDisplayName(waitingPlugin.plugin.id, waitingPlugin.plugin.name)}」插件…`
                      : "发送消息…"
                }
                value={composerValue}
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
              <div className="composer-plugin-entry" ref={setPluginEntry} />
              <div className="composer-rewrite-entry">
                {rewriteButtons(draft, undefined, true)}
              </div>
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
                          className="du-input du-input-sm"
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
                  key={chat?.id ?? "new-chat"}
                  value={chat?.effort ?? "inherit"}
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
              {job || pluginJob ? (
                <IconButton
                  label="停止生成"
                  className="send-button"
                  onClick={() => void run(stopGeneration)}
                >
                  <Square size={15} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton
                  label="发送"
                  className="send-button"
                  disabled={
                    (!composerValue.trim() && !hasClarifySelection) ||
                    busy ||
                    !!chat?.deleted ||
                    (!selectedModel && !waitingPlugin && !pluginInput) ||
                    (!!pluginFlow && !waitingPlugin && !pluginInput)
                  }
                  onClick={() => void run(send)}
                >
                  {busy ? <Loading /> : <ArrowUp size={21} />}
                </IconButton>
              )}
            </div>
          </div>

          {pluginJob && connection.pluginUnsaved(pluginJob.id) && (
            <button
              className="du-btn du-btn-xs"
              onClick={() =>
                void run(async () => {
                  await connection.retryPluginSave(pluginJob.id);
                  await refresh();
                  await loadNavigation();
                })
              }
            >
              重试保存插件结果
            </button>
          )}
          {rewriteError && (
            <div className="plugin-flow-controls" role="alert">
              <span>
                {rewriteError.plugin.name}：{rewriteError.error}
              </span>
              <button
                className="du-btn du-btn-xs"
                disabled={!!pluginJob || !!job}
                onClick={() =>
                  void run(async () => {
                    await pluginCommand("dismiss", { runId: rewriteError.id });
                    await pluginCommand("rewrite", {
                      pluginId: rewriteError.plugin.id,
                      content: rewriteError.input,
                      ...(rewriteError.rewriteMessageId
                        ? { messageId: rewriteError.rewriteMessageId }
                        : {}),
                    });
                  })
                }
              >
                <RotateCcw size={14} />
                重试
              </button>
              <button
                className="du-btn du-btn-xs"
                onClick={() =>
                  void run(() =>
                    pluginCommand("dismiss", { runId: rewriteError.id }),
                  )
                }
              >
                关闭
              </button>
            </div>
          )}
          {estimate > capacity && (
            <p className="context-warning">超出所设上下文预算，仍可发送。</p>
          )}
        </div>
        {chat && (
          <ConversationTimeline
            key={chat.id}
            messages={path}
            scrollRef={scrollRef}
            onJump={(id) => {
              const container = scrollRef.current,
                element = messageElement(id);
              if (container && element) {
                stick.current = false;
                scrollIntent.current = null;
                container.scrollTop +=
                  element.getBoundingClientRect().top -
                  container.getBoundingClientRect().top -
                  20;
              }
            }}
          />
        )}
      </main>
      {panel && chat && (
        <aside className="parameters">
          <div className="panel-heading">
            <div
              className="panel-tabs du-tabs du-tabs-box"
              role="tablist"
              aria-label="聊天面板"
            >
              <button
                role="tab"
                aria-selected={panelTab === "settings"}
                className={
                  "du-tab " +
                  (panelTab === "settings" ? "selected du-tab-active" : "")
                }
                onClick={() => setPanelTab("settings")}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                当前聊天设置
              </button>
              <button
                aria-label="分支总览"
                role="tab"
                aria-selected={panelTab === "overview"}
                className={
                  "du-tab " +
                  (panelTab === "overview" ? "selected du-tab-active" : "")
                }
                onClick={() => setPanelTab("overview")}
              >
                <GitBranch size={14} aria-hidden="true" />
                概述
              </button>
            </div>
            <IconButton label="返回聊天" onClick={() => setPanel(false)}>
              <X size={18} />
            </IconButton>
          </div>
          {panelTab === "settings" ? (
            <div className="panel-content">
              <h3>系统提示词</h3>
              <SystemPrompts
                key={chat.id}
                templates={settings.templates}
                value={chat.system}
                onChange={(system) => run(() => patch({ system }))}
              />

              <label className="toggle">
                流式回答
                <input
                  className="du-toggle du-toggle-primary du-toggle-sm"
                  type="checkbox"
                  checked={chat.stream}
                  onChange={(e) =>
                    void run(() => patch({ stream: e.target.checked }))
                  }
                />
              </label>
              <h3>回复摘要</h3>
              <SummaryTools
                chat={chat}
                settings={settings}
                providers={providers}
                command={summaryCommand}
              />
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
                发送的对话轮数
                <input
                  className="du-input du-input-sm"
                  type="number"
                  min="1"
                  placeholder="全部历史"
                  aria-describedby="context-rounds-help"
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
                <small id="context-rounds-help">
                  一轮是一次提问及其回复。数量包含本次提问；留空则发送当前分支的全部历史。
                </small>
              </label>

              <h3>当前聊天导出</h3>
              <div className="chat-exports">
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
              </div>
            </div>
          ) : (
            <div className="overview-content">
              <Suspense fallback={<div className="center">加载分支…</div>}>
                <BranchOverview
                  chat={chat}
                  providers={providers}
                  onSelect={(id) => {
                    void run(async () => {
                      if (job) {
                        const element = messageElement(id),
                          container = scrollRef.current;
                        if (!element || !container)
                          throw Error("生成完成后可以切换其他分支");
                        stick.current = false;
                        container.scrollTop +=
                          element.getBoundingClientRect().top -
                          container.getBoundingClientRect().top -
                          18;
                      } else await action("select", { messageId: id }, id);
                      if (innerWidth <= 760) setPanel(false);
                    });
                  }}
                />
              </Suspense>
            </div>
          )}
        </aside>
      )}
      {confirmPostSend && (
        <ConfirmPostSend
          cancel={() => setConfirmPostSend(false)}
          confirm={() => {
            setConfirmPostSend(false);
            void run(() => send(true));
          }}
        />
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
                    : "消息详情"}
              </h2>
              <IconButton label="关闭" onClick={() => setModal("")}>
                <X size={20} />
              </IconButton>
            </div>
            {modal === "settings" ? (
              <SettingsPanel
                close={() => setModal("")}
                initialTab={settingsTab}
                usage={quota}
                refreshUsage={refreshQuota}
                providers={providers}
                settings={settings}
                appearance={appearance}
                setAppearance={setAppearance}
                run={run}
                refresh={loadConfig}
                onExportChats={() =>
                  void run(() =>
                    downloadChats(
                      chats.filter((c) => !c.deleted).map((c) => c.id),
                    ),
                  )
                }
                onExportTrash={() =>
                  void run(() =>
                    downloadChats(
                      chats.filter((c) => c.deleted).map((c) => c.id),
                    ),
                  )
                }
                onImportChats={() => {
                  setModal("");
                  fileRef.current?.click();
                }}
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
                      disabled={!!job || !!pluginJob}
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
      {groupNameDialog && (
        <NameDialog
          title={groupNameDialog.id ? "重命名分组" : "新建分组"}
          initial={groupNameDialog.initial}
          onClose={() => setGroupNameDialog(null)}
          onSave={async (name) => {
            if (groupNameDialog.id)
              await api("/groups/" + groupNameDialog.id, "PATCH", { name });
            else await api("/groups", "POST", { name });
            await loadNavigation();
          }}
        />
      )}
      {rewriteResult && (
        <RewriteReview
          key={rewriteResult.id}
          run={rewriteResult}
          current={
            rewriteResult.rewriteMessageId
              ? (editing?.content ?? rewriteResult.input)
              : draft
          }
          apply={
            rewriteResult.rewriteMessageId
              ? (value) =>
                  setEditing((previous) =>
                    previous && previous.id === rewriteResult.rewriteMessageId
                      ? { ...previous, content: value }
                      : previous,
                  )
              : updateDraft
          }
          command={pluginCommand}
          busy={busy || !!job || !!pluginJob}
          regenerating={
            !!pluginJob &&
            pluginState.runs.some(
              (r) => r.id === pluginJob.runId && r.plugin.kind === "rewrite",
            )
          }
          failure={
            rewriteError?.createdAt &&
            rewriteError.createdAt >= rewriteResult.createdAt
              ? rewriteError.error
              : undefined
          }
        />
      )}
      {deleteTarget &&
        chat?.id === deleteTarget.chatId &&
        chat.messages[deleteTarget.messageId] && (
          <MessageDeleteDialog
            message={chat.messages[deleteTarget.messageId]!}
            childCount={byParent.get(deleteTarget.messageId)?.length ?? 0}
            close={() => setDeleteTarget(null)}
            remove={() =>
              action("delete-message", { messageId: deleteTarget.messageId })
            }
          />
        )}
      {suggestionDraft !== null && (
        <DraftReplacement
          current={draft}
          candidate={suggestionDraft}
          close={() => setSuggestionDraft(null)}
          apply={() => {
            updateDraft(suggestionDraft);
            setSuggestionDraft(null);
          }}
        />
      )}
      {moveChat && (
        <GroupPicker
          groups={groups}
          close={() => setMoveChat(null)}
          choose={async (groupId) => {
            await api("/chats/" + moveChat.id, "PATCH", { groupId });
            if (idRef.current === moveChat.id) await refresh();
            await loadNavigation();
          }}
        />
      )}
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
        table: ({ children, ...props }) => (
          <table {...props} className="du-table du-table-sm">
            {children}
          </table>
        ),
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
  onLogin: (notice?: LoginNotice) => void;
  error: string;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [recovery, setRecovery] = useState(false),
    [next, setNext] = useState(""),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState(""),
    [recoveryCode, setRecoveryCode] = useState("");
  const [retryAt, setRetryAt] = useState(0),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
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
          if (loading || retryAt > Date.now()) return;
          setLoading(true);
          void run(async () => {
            try {
              const result = await api<{
                recoveryCode?: string;
                failedAttempts?: LoginNotice;
              }>("/auth/" + (recovery ? "recover" : "login"), "POST", {
                password,
                newPassword: next,
              });
              if (recovery) {
                setRecovery(false);
                setPassword("");
                setRecoveryCode(result.recoveryCode ?? "");
                setMessage("密码已重置。请使用新密码登录；原恢复码已失效。");
              } else onLogin(result.failedAttempts);
            } catch (e) {
              if (e instanceof ApiError && e.retryAt) {
                setRetryAt(e.retryAt);
                setNow(Date.now());
              }
              throw e;
            } finally {
              setPassword("");
              setNext("");
              setLoading(false);
            }
          });
        }}
      >
        <Sparkles className="welcome-symbol" size={44} aria-hidden="true" />
        <h1>在线AI</h1>
        <p className="muted">
          {recovery ? "使用离线恢复码重置访问密码" : "登录，继续你的思考。"}
        </p>
        <label>
          {recovery ? "离线恢复码" : "访问密码"}
          <input
            className="du-input du-input-sm"
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
              className="du-input du-input-sm"
              required
              type="password"
              minLength={PASSWORD_MIN_LENGTH}
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
        {remaining > 0 && (
          <p className="muted" role="status">
            此 IP 暂时无法登录，{Math.floor(remaining / 60)} 分 {remaining % 60}{" "}
            秒后重试。
          </p>
        )}
        <button
          className="primary"
          disabled={loading || remaining > 0}
          type="submit"
        >
          {loading
            ? "正在验证…"
            : remaining > 0
              ? "暂时封禁"
              : recovery
                ? "重置密码"
                : "登录"}
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
function SettingsPanel({
  close,
  initialTab,
  usage,
  refreshUsage,
  providers,
  settings,
  appearance,
  setAppearance,
  run,
  refresh,
  onLogout,
  onExportChats,
  onExportTrash,
  onImportChats,
}: {
  close: () => void;
  initialTab: string;
  usage: AccountUsage | null;
  refreshUsage: () => Promise<void>;
  providers: ProviderView[];
  settings: Settings;
  appearance: Appearance;
  setAppearance: (v: Appearance) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  onLogout: () => void;
  onExportChats: () => void;
  onExportTrash: () => void;
  onImportChats: () => void;
}) {
  const connection = useDeviceConnection();
  const [navSearch, setNavSearch] = useState("");
  const [tab, setTab] = useState(initialTab),
    [filter, setFilter] = useState(""),
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
      <nav className="du-menu settings-menu" aria-label="设置导航">
        <button className="du-btn du-btn-ghost settings-return" onClick={close}>
          <ChevronLeft size={17} />
          返回应用
        </button>
        <label className="du-input du-input-sm settings-search">
          <Search size={15} />
          <input
            className="du-input"
            aria-label="搜索设置"
            placeholder="搜索设置"
            value={navSearch}
            onChange={(e) => setNavSearch(e.target.value)}
          />
        </label>
        <small className="muted settings-nav-caption">设置</small>
        {(
          [
            ["connection", "连接", <Cable size={17} aria-hidden="true" />],
            ["providers", "服务商", <Server size={17} aria-hidden="true" />],
            ["models", "模型", <Boxes size={17} aria-hidden="true" />],
            ["plugins", "插件", <Blocks size={17} aria-hidden="true" />],
            [
              "templates",
              "提示词模板",
              <FileText size={17} aria-hidden="true" />,
            ],
            [
              "generation",
              "生成默认",
              <SlidersHorizontal size={17} aria-hidden="true" />,
            ],
            ["data", "聊天数据", <Database size={17} aria-hidden="true" />],
            [
              "backup",
              "设置备份",
              <HardDriveDownload size={17} aria-hidden="true" />,
            ],
            ["appearance", "外观", <Palette size={17} aria-hidden="true" />],
            ["usage", "账号额度", <Gauge size={17} aria-hidden="true" />],
            ["security", "账号与设备", <Shield size={17} aria-hidden="true" />],
            ["about", "关于", <Info size={17} aria-hidden="true" />],
          ] as const
        )
          .filter(([, title]) => title.includes(navSearch.trim()))
          .map(([key, title, icon]) => (
            <button
              className={
                "du-btn du-btn-ghost du-btn-sm " +
                (tab === key ? "selected" : "")
              }
              key={key}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => setTab(key!)}
            >
              {icon}
              {title}
            </button>
          ))}
      </nav>
      <div className="settings-content">
        {tab === "usage" && (
          <AccountUsageSettings usage={usage} refresh={refreshUsage} />
        )}
        {tab === "plugins" && (
          <GlobalPlugins
            settings={settings}
            providers={providers}
            save={saveSettings}
          />
        )}
        {tab === "connection" && (
          <>
            <h3>请求方式</h3>
            <label className="toggle">
              此设备直连
              <input
                className="du-toggle du-toggle-primary du-toggle-sm"
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
            <button onClick={connection.lock}>
              <LogOut size={16} />
              清除临时密钥
            </button>
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
        {tab === "data" && (
          <>
            <h3>聊天数据</h3>
            <p className="muted">
              JSON 保留全部消息分支，可与 OpenWebUI 导入导出。
            </p>
            <div className="settings-data-actions">
              <button onClick={onExportChats}>
                <Download size={17} />
                导出全部聊天（含归档）
              </button>
              <button onClick={onImportChats}>
                <Upload size={17} />
                导入 OpenWebUI JSON
              </button>
              <button onClick={onExportTrash}>
                <Download size={17} />
                单独导出回收站
              </button>
            </div>
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
          <ProvidersPanel
            providers={providers}
            refresh={refresh}
            run={run}
            onModels={(name) => {
              setFilter(name);
              setTab("models");
            }}
          />
        )}
        {tab === "models" && (
          <>
            <h3>模型</h3>
            <p className="muted">
              新发现的模型默认关闭。前缀只用于显示，发送时使用原始模型 ID。
            </p>
            <input
              className="du-input du-input-sm"
              aria-label="筛选设置模型"
              placeholder="搜索模型或服务商…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="inline-actions">
              {[
                ["全部开启", true, false],
                ["全部关闭", false, false],
                ["开启筛选", true, true],
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
                  {onlyResults ? (
                    <ListChecks size={15} />
                  ) : enabled ? (
                    <ToggleRight size={15} />
                  ) : (
                    <ToggleLeft size={15} />
                  )}
                  {label}
                </button>
              ))}
            </div>
            <label>
              默认聊天模型
              <select
                className="du-select du-select-sm"
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
            <div className="models-grid">
              {modelRows.map((m) => (
                <div className="model-entry du-card" key={m.p.id + "/" + m.id}>
                  <div className="model-card-heading">
                    <label>
                      <input
                        className="du-toggle du-toggle-primary du-toggle-sm"
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) =>
                          void run(async () => {
                            await api(
                              "/providers/" + m.p.id + "/models",
                              "PUT",
                              {
                                models: [
                                  { id: m.id, enabled: e.target.checked },
                                ],
                              },
                            );
                            await refresh();
                          })
                        }
                      />
                      <span>
                        {m.p.prefix + m.id}
                        <small>{m.p.name}</small>
                      </span>
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
            </div>
            {!modelRows.length && (
              <p className="muted">
                没有匹配的模型。可调整搜索词，或到服务商页获取模型列表。
              </p>
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
              <div className="template-card du-card" key={t.id}>
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
                  className="du-textarea"
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
                className="du-input du-input-sm"
                value={template.name}
                onChange={(e) =>
                  setTemplate({ ...template, name: e.target.value })
                }
              />
            </label>
            <label>
              提示词
              <textarea
                className="du-textarea"
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
          <AppearanceSettings value={appearance} onChange={setAppearance} />
        )}
        {tab === "security" && (
          <>
            <h3>登录设备</h3>
            {sessions.map((s) => (
              <div className="provider-card du-card" key={s.id}>
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
                className="du-input du-input-sm"
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
              新密码（至少 {PASSWORD_MIN_LENGTH} 字符）
              <input
                className="du-input du-input-sm"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <button
              disabled={newPassword.length < PASSWORD_MIN_LENGTH}
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
