// Offline request-layout audit. No credentials, model calls, or application writes.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(),
  args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const baseline = option("--baseline") ?? "HEAD";
async function moduleAt(ref) {
  const bundled = await build({
    stdin: {
      resolveDir: root,
      contents: `export {newChat,addMessage,contextMessages,defaultSettings,estimateTokens} from './src/shared/chat.ts'; export {pluginDefaults,preparePlugin,emptyPluginState,injectPlugins} from './src/shared/plugins.ts'; export {prepareSummary,summarySourceKey,defaultSummaryConfig} from './src/shared/summaries.ts';`,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: ref
      ? [
          {
            name: "git-baseline",
            setup(b) {
              b.onLoad({ filter: /\.ts$/ }, ({ path }) => {
                const relative = path
                  .replaceAll("\\", "/")
                  .slice(root.replaceAll("\\", "/").length + 1);
                if (!relative.startsWith("src/")) return;
                return {
                  contents: execFileSync(
                    "git",
                    ["show", `${ref}:${relative}`],
                    { cwd: root, encoding: "utf8" },
                  ),
                  loader: "ts",
                };
              });
            },
          },
        ]
      : [],
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(bundled.outputFiles[0].text).toString("base64")
  );
}
const messageShape = (m) =>
  JSON.stringify([m.role, m.name, m.tool_call_id, m.tool_calls]);
function prefix(a, b, estimate) {
  let count = 0,
    text = "";
  while (count < Math.min(a.messages.length, b.messages.length)) {
    const x = a.messages[count],
      y = b.messages[count];
    if (messageShape(x) !== messageShape(y)) break;
    if (x.content !== y.content) {
      let n = 0;
      const u = x.content ?? "",
        v = y.content ?? "";
      while (n < Math.min(u.length, v.length) && u[n] === v[n]) n++;
      text += u.slice(0, n);
      break;
    }
    text += x.content ?? "";
    count++;
  }
  return {
    commonCompleteMessages: count,
    commonTextChars: Array.from(text).length,
    commonTextTokenEstimate: estimate(text),
  };
}
function fixtures(m, salt) {
  const provider = {
    id: "fixture",
    name: "fixture",
    prefix: "",
    baseUrl: "https://fixture.invalid/v1",
    models: [{ id: "model", enabled: true, capacity: 1048576, parameters: {} }],
  };
  const chat = m.newChat({ providerId: provider.id, modelId: "model" }),
    settings = m.defaultSettings(),
    state = m.emptyPluginState(),
    summaries = { runs: [] };
  const main = [];
  for (let round = 1; round <= 6; round++) {
    const u = m.addMessage(
      chat,
      "user",
      `${salt}｜第${round}轮：我是访客林，我检查柜台上的钥匙，先问清店内规则再作选择。`,
    );
    const injection = [
      {
        pluginId: "analysis",
        name: "写前分析",
        template: "辅助记录：{{RESULT}}",
        content: "掌柜知道钥匙来历，伙计尚未得知。".repeat(30),
        runId: "run-" + round,
      },
    ];
    main.push({
      messages: m.injectPlugins(m.contextMessages(chat), injection),
    });
    const body = Array.from(
      { length: 85 },
      (_, i) =>
        `茶室记录${round}-${i + 1}：掌柜陆核对柜台清单，伙计周整理茶杯；钥匙一直留在柜台，没有人拿走，也没有人告诉周它的来历。`,
    ).join("\n");
    const a = m.addMessage(chat, "assistant", body);
    a.toolContext = {
      parentId: u.id,
      messages: m
        .injectPlugins([{ role: "user", content: u.content }], injection)
        .slice(1),
    };
    summaries.runs.push({
      id: "summary-" + round,
      messageId: a.id,
      sourceKey: m.summarySourceKey(chat, a.id),
      status: "complete",
      summary: `第${round}轮：掌柜核对清单，伙计整理茶杯。钥匙始终在柜台，周仍不知道钥匙来历，访客尚未取走钥匙。`,
      output: "",
      createdAt: round,
      config: m.defaultSummaryConfig(),
      inputTokens: 1,
    });
    for (const kind of ["clarify", "analysis"])
      state.runs.push({
        id: `${kind}-${round}`,
        plugin: m.pluginDefaults(kind),
        anchorId: u.id,
        contextAnchorId: u.parentId,
        input: u.content,
        output:
          kind === "analysis"
            ? JSON.stringify({
                character_thoughts: "none",
                scene_state: "钥匙在柜台。".repeat(30),
                action_state: "伙计整理茶杯。".repeat(30),
                knowledge_boundaries: "周不知道钥匙来历。".repeat(15),
              })
            : JSON.stringify({
                questions: [
                  {
                    id: "q1",
                    question: "访客先做什么？",
                    multiple: false,
                    options: [
                      { id: "A", text: "核对清单" },
                      { id: "B", text: "询问规则" },
                      { id: "C", text: "先等待" },
                    ],
                  },
                ],
              }),
        answer: "B. 询问规则",
        status: kind === "analysis" ? "complete" : "answered",
        createdAt: round,
        metrics: {
          total: 0,
          capacity: 1048576,
          missingSummaries: 0,
          referenceTokens: 0,
          shortened: 0,
          sections: [],
        },
      });
  }
  const plugin = (
    kind,
    input = "我想先了解钥匙的来历，再决定是否开门；请先提出必要的选择题。",
  ) =>
    m.preparePlugin(
      chat,
      m.pluginDefaults(kind),
      settings,
      [provider],
      state,
      input,
      chat.currentId,
      [],
      summaries,
    ).request;
  const summary = m.prepareSummary(chat, chat.currentId, summaries, settings, [
    provider,
  ]).request;
  const messages = Object.values(chat.messages),
    copy = structuredClone(chat),
    remap = new Map(messages.map((v, i) => [v.id, "copied-" + i]));
  copy.messages = Object.fromEntries(
    messages.map((v) => {
      const c = {
        ...v,
        id: remap.get(v.id),
        parentId: remap.get(v.parentId) ?? null,
      };
      return [c.id, c];
    }),
  );
  copy.currentId = remap.get(chat.currentId);
  const copiedSummaries = {
    runs: summaries.runs.map((v) => ({
      ...v,
      messageId: remap.get(v.messageId),
      sourceKey: m.summarySourceKey(copy, remap.get(v.messageId)),
    })),
  };
  return {
    main: [main[4], main[5]],
    front: [plugin("clarify"), plugin("analysis")],
    candidates: [
      plugin("suggest", ""),
      plugin("rewrite", "我先问问钥匙是谁的。"),
    ],
    rewrite: [
      plugin("rewrite", "我先看钥匙。"),
      plugin("rewrite", "我先问店内规则。"),
    ],
    summaryCopy: [
      summary,
      m.prepareSummary(copy, copy.currentId, copiedSummaries, settings, [
        provider,
      ]).request,
    ],
  };
}
try {
  const old = await moduleAt(baseline),
    current = await moduleAt(),
    token = option("--salt") ?? "offline-cache-audit";
  const before = fixtures(old, token + "|A"),
    after = fixtures(current, token + "|B"),
    cases = [];
  for (const name of Object.keys(before))
    cases.push({
      case: name,
      before: prefix(...before[name], old.estimateTokens),
      after: prefix(...after[name], current.estimateTokens),
    });
  console.log(
    JSON.stringify(
      {
        baseline,
        note: "Only request-text prefix estimates; these are not observed cache hit rates.",
        cases,
      },
      null,
      2,
    ),
  );
  const output = option("--requests-file");
  if (output)
    await writeFile(resolve(output), JSON.stringify({ before, after }));
} catch (e) {
  console.error(String(e.message).slice(0, 300));
  process.exitCode = 1;
}
