import { useState, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RotateCcw, Pencil, Plus, Trash2, Check, X } from "lucide-react";
import {
  analysisSections,
  questionView,
  type AnalysisType,
  type AnalysisSection,
} from "../shared/plugin-sections";
import type { PluginRun, PluginState } from "../shared/plugins";
import { Loading } from "./controls";
import { MessageUsage } from "./chat-controls";
import { ActionIcons as I } from "./action-icons";
import { FallbackButton } from "./fallback-ui";

export type PluginInputRequest = {
  runId: string;
  pluginName: string;
  label: string;
  body: { targetId: string | null };
  draft: string;
};
type Command = (
  action: string,
  body?: Record<string, unknown>,
) => Promise<void>;
const Text = ({ text }: { text: string }) => (
  <div className="markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml>
      {text === "none" ? "暂无有依据的记录" : text}
    </Markdown>
  </div>
);
export function QuestionSections({
  run,
  selections,
  select,
  enabled,
}: {
  run: PluginRun;
  selections: Record<string, string[]>;
  select: (id: string, values: string[]) => void;
  enabled: boolean;
}) {
  const questions = useMemo(() => questionView(run.output), [run.output]);
  if (questions === null) return <Text text={run.output || "正在生成…"} />;
  if (!questions.length)
    return (
      <p className="du-alert" role="status">
        没有需要继续澄清的问题，确认后继续。
      </p>
    );
  return (
    <div className="question-sections">
      {questions.map((q, index) => (
        <section className="du-card question-section" key={q.id}>
          <div className="question-title">
            <Text text={`${index + 1}. ${q.question}`} />
          </div>
          <small className="muted">
            可任选一项或多项，也可在输入框自由回答
          </small>
          <div className="question-options">
            {q.options.map((o) => {
              const values = Object.hasOwn(selections, q.id)
                ? selections[q.id]!
                : [];
              const selected = values.includes(o.id);
              return (
                <button
                  key={o.id}
                  className={
                    "du-btn du-btn-sm " + (selected ? "du-btn-primary" : "")
                  }
                  aria-pressed={selected}
                  disabled={!enabled}
                  onClick={() =>
                    select(
                      q.id,
                      selected
                        ? values.filter((v) => v !== o.id)
                        : [...values, o.id],
                    )
                  }
                >
                  <b>{o.id}</b>
                  {selected && <I.confirm size={13} />}
                  <span>{o.text}</span>
                </button>
              );
            })}
            <button
              className={
                "du-btn du-btn-sm " +
                (Object.hasOwn(selections, q.id) &&
                selections[q.id]!.length === 0
                  ? "du-btn-primary"
                  : "")
              }
              aria-pressed={
                Object.hasOwn(selections, q.id) &&
                selections[q.id]!.length === 0
              }
              disabled={!enabled}
              onClick={() => select(q.id, [])}
            >
              <I.cancel size={13} />
              跳过本题
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
function OperationUsage({ run }: { run: PluginRun }) {
  return (
    <MessageUsage
      message={{
        id: run.id,
        parentId: null,
        role: "assistant",
        content: "",
        createdAt: run.createdAt,
        model: run.model ?? undefined,
        usage: run.usage,
        elapsedMs: run.elapsedMs,
      }}
    />
  );
}
export function AnalysisSections({
  run,
  state,
  command,
  busy,
  enabled,
  input,
  templates,
}: {
  run: PluginRun;
  state: PluginState;
  command: Command;
  busy: boolean;
  enabled: boolean;
  input: (v: PluginInputRequest) => void;
  templates: AnalysisType[];
}) {
  const sections = useMemo(() => analysisSections(run.output), [run.output]),
    [editing, setEditing] = useState<string | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const locked = busy || pending;
  const [saveTemplate, setSaveTemplate] = useState(false),
    [scope, setScope] = useState("chat"),
    [templateName, setTemplateName] = useState(""),
    [instruction, setInstruction] = useState("");
  const candidates = state.runs.filter(
    (r) =>
      r.sectionEdit?.sourceId === run.id &&
      !r.dismissed &&
      ["running", "candidate", "error", "cancelled"].includes(r.status),
  );
  const act = async (action: string, body: Record<string, unknown>) => {
    setError("");
    setPending(true);
    try {
      await command(action, body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  };
  const start = (section: AnalysisSection | null) =>
    input({
      runId: run.id,
      pluginName: run.plugin.name,
      label: section
        ? `修改「${section.type}${section.character ? "｜" + section.character : ""}」的要求`
        : `为「${run.plugin.name}」新增类型及生成方向`,
      body: { targetId: section?.id ?? null },
      draft: "",
    });
  const preview = (candidate: PluginRun) => {
    let value: AnalysisSection | null = null;
    try {
      value = JSON.parse(candidate.output);
    } catch {}
    const old = sections.find((s) => s.id === candidate.sectionEdit?.targetId);
    return (
      <section
        className="du-card section-candidate"
        key={candidate.id}
        aria-label="分块结果对比"
      >
        <h4>
          {candidate.sectionEdit?.targetId ? "修改结果对比" : "新增类型预览"}
        </h4>
        {candidate.status === "running" ? (
          <p>
            <Loading small /> 正在生成
          </p>
        ) : candidate.status === "error" ? (
          <p className="du-alert du-alert-error" role="alert">
            {candidate.error}
          </p>
        ) : candidate.status === "cancelled" ? (
          <p>已停止，原内容保留。</p>
        ) : (
          value && (
            <>
              <div className="section-compare">
                <div>
                  <strong>原内容</strong>
                  <Text text={old?.content ?? "本轮尚无此类型"} />
                </div>
                <div>
                  <strong>{value.type}</strong>
                  <Text text={value.content} />
                </div>
              </div>
              {!candidate.sectionEdit?.targetId && (
                <>
                  <label className="section-save-choice">
                    <input
                      className="du-checkbox du-checkbox-sm"
                      type="checkbox"
                      checked={saveTemplate}
                      onChange={(e) => {
                        setSaveTemplate(e.target.checked);
                        setTemplateName(value!.type);
                        setInstruction(value!.instruction ?? "");
                      }}
                    />
                    后续每轮自动生成此类型
                  </label>
                  {saveTemplate && (
                    <div className="type-template-fields">
                      <label>
                        类型名称
                        <input
                          className="du-input du-input-sm"
                          aria-label="保存类型名称"
                          value={templateName}
                          onChange={(e) => setTemplateName(e.target.value)}
                        />
                      </label>
                      <label>
                        通用生成规则
                        <textarea
                          className="du-textarea"
                          aria-label="保存类型通用规则"
                          value={instruction}
                          onChange={(e) => setInstruction(e.target.value)}
                        />
                      </label>
                      <label>
                        保存范围
                        <select
                          className="du-select du-select-sm"
                          aria-label="保存类型范围"
                          value={scope}
                          onChange={(e) => setScope(e.target.value)}
                        >
                          <option value="chat">当前对话</option>
                          <option value="global">全局插件</option>
                        </select>
                      </label>
                      <small>
                        仅保存名称和通用规则，请移除本轮具体剧情要求。
                      </small>
                    </div>
                  )}
                </>
              )}
              <button
                className="du-btn du-btn-primary du-btn-sm"
                disabled={locked || !enabled}
                onClick={() =>
                  void act("section-apply", {
                    runId: candidate.id,
                    saveType: saveTemplate,
                    scope,
                    type: templateName,
                    instruction,
                  })
                }
              >
                <Check size={14} />
                确认替换{old ? "此块" : "并添加"}
              </button>
            </>
          )
        )}
        <div className="plugin-card-actions">
          {candidate.status === "error" && (
            <FallbackButton
              disabled={locked || !enabled}
              retry={(model) =>
                command("fallback", { runId: candidate.id, model })
              }
            />
          )}
          <button
            className="du-btn du-btn-sm"
            disabled={locked || candidate.status === "running" || !enabled}
            onClick={() =>
              void command("section-generate", {
                runId: run.id,
                targetId: candidate.sectionEdit?.targetId ?? null,
                content: candidate.sectionEdit?.instruction ?? "",
              })
                .then(() => command("dismiss", { runId: candidate.id }))
                .catch((e) => setError(e.message))
            }
          >
            <I.regenerateSection size={14} />
            重新生成结果
          </button>
          <button
            className="du-btn du-btn-ghost du-btn-sm"
            disabled={candidate.status === "running"}
            onClick={() =>
              void act("discard-sections", { runIds: [candidate.id] })
            }
          >
            <I.cancel size={14} />
            取消
          </button>
        </div>
        <OperationUsage run={candidate} />
      </section>
    );
  };
  return (
    <div className="analysis-sections">
      {!sections.length ? (
        <Text text={run.output || "正在生成…"} />
      ) : (
        sections.map((section) => {
          const usage = state.runs.findLast(
            (r) =>
              r.sectionEdit?.sourceId === run.id &&
              (r.sectionEdit.targetId === section.id ||
                r.sectionResultId === section.id) &&
              r.status === "complete",
          );
          const custom = section.id.startsWith("extra:");
          return (
            <section
              className="du-card analysis-section"
              key={section.id}
              aria-label={
                section.type +
                (section.character ? "｜" + section.character : "")
              }
            >
              <h4>
                {section.type}
                {section.character && <span>｜{section.character}</span>}
              </h4>
              {editing === section.id ? (
                <>
                  <textarea
                    className="du-textarea"
                    aria-label="编辑分块正文"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <div className="plugin-card-actions">
                    <button
                      className="du-btn du-btn-sm du-btn-primary"
                      disabled={locked}
                      onClick={async () => {
                        if (
                          await act("section-edit", {
                            runId: run.id,
                            targetId: section.id,
                            content: text,
                          })
                        )
                          setEditing(null);
                      }}
                    >
                      <I.save size={13} />
                      保存此块
                    </button>
                    <button
                      className="du-btn du-btn-sm"
                      onClick={() => setEditing(null)}
                    >
                      <I.cancel size={13} />
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <Text text={section.content} />
              )}
              {enabled && (
                <div className="plugin-card-actions">
                  <button
                    className="du-btn du-btn-xs"
                    disabled={locked}
                    onClick={() =>
                      void act("section-generate", {
                        runId: run.id,
                        targetId: section.id,
                        content: "",
                      })
                    }
                  >
                    <I.regenerateSection size={13} />
                    重新生成此块
                  </button>
                  <button
                    className="du-btn du-btn-xs"
                    disabled={locked}
                    onClick={() => start(section)}
                  >
                    <I.instruct size={13} />
                    附要求修改
                  </button>
                  <button
                    className="du-btn du-btn-ghost du-btn-xs"
                    disabled={locked}
                    onClick={() => {
                      setEditing(section.id);
                      setText(section.content);
                    }}
                  >
                    <Pencil size={13} />
                    编辑
                  </button>
                  <button
                    className="du-btn du-btn-ghost du-btn-xs"
                    disabled={locked}
                    onClick={() =>
                      void act("section-remove", {
                        runId: run.id,
                        targetId: section.id,
                      })
                    }
                  >
                    <Trash2 size={13} />
                    {custom ? "仅本轮移除" : "设为 none"}
                  </button>
                </div>
              )}
              {templates.some((t) => t.id === section.id) && (
                <button
                  className="du-btn du-btn-ghost du-btn-xs"
                  disabled={locked}
                  onClick={() =>
                    void act("type-remove", {
                      runId: run.id,
                      targetId: section.id,
                    })
                  }
                >
                  <I.delete size={13} />
                  删除类型（后续停用）
                </button>
              )}
              {usage && <OperationUsage run={usage} />}
            </section>
          );
        })
      )}
      {enabled && (
        <div className="plugin-card-actions">
          <button
            className="du-btn du-btn-sm"
            disabled={locked}
            onClick={() => start(null)}
          >
            <Plus size={14} />
            新增类型
          </button>
        </div>
      )}
      {candidates.map(preview)}
      {!!run.sectionHistory?.length && (
        <details>
          <summary>局部操作记录（{run.sectionHistory.length}）</summary>
          {run.sectionHistory.map((id) => {
            const r = state.runs.find((r) => r.id === id);
            return r ? (
              <div key={id}>
                <small>
                  {r.sectionEdit?.instruction || "无附加要求的重新生成"}
                </small>
                <OperationUsage run={r} />
              </div>
            ) : null;
          })}
        </details>
      )}
      <details>
        <summary>原始 JSON</summary>
        <pre className="plugin-output">{run.output}</pre>
      </details>
      {error && (
        <p className="du-alert du-alert-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
