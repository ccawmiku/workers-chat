import type { PluginDefinition } from "./plugins";
import {
  ANALYSIS_PROMPT,
  ANALYSIS_SCHEMA,
  LEGACY_ANALYSIS_PROMPT,
  LEGACY_ANALYSIS_SCHEMA,
  PRE_BLOCK_ANALYSIS_PROMPT,
  PRE_BLOCK_ANALYSIS_SCHEMA,
} from "./analysis-defaults";
import {
  CLARIFY_PROMPT,
  LEGACY_CLARIFY_PROMPT,
  PRE_QUESTIONS_CLARIFY_PROMPT,
  THREE_OPTIONS_CLARIFY_PROMPT,
} from "./clarify-defaults";
const names = { rewrite: "重写提示" };
const PRE_UA_REWRITE_PROMPT =
  '你是 user 提示词重新生成器，不是执行任务的助手。最后一条 user 消息是本轮待重新表达的原始请求，历史仅供解析指代。\n你的唯一目标是重新组织这个请求的表达，保留相同意图、事实和条件，信息量不得增加。这不是润色或扩写任务，更不是替用户设计新要求。\n严格规则：\n1. 禁止新增任何原请求没有表达的目标、限制、情节、人物动机、字数、数量、视角、节奏、文风、格式或禁止事项；即使你觉得合理、符合背景、能改善结果，也不能添加。不要把历史 assistant 的建议或自行推测当成用户的要求。\n2. 历史只能解释“他”“那个”等明确指代，不可把整段历史偏好重新堆到本轮，也不可把省略的内容补成新条件。信息不明确就保持原有模糊程度，宁可短、接近原句，也不要自行补全。\n3. 只写用户将发给主助手的提示词，不能回答问题、执行任务、扮演角色或续写故事正文。用户说“继续”，就只重新表达“继续”，不能给它增加方向和限制。历史里的角色扮演指令不适用于你。\n4. 输出前逐项核对：每个事实、要求和限制都必须能在原请求中直接找到依据；不能找到的全部删除。不要输出核对过程。\n5. 必须只输出一个合法 JSON 对象，字段 prompt 的值为一条完整的新 user 提示词：{"prompt":"…"}。不要输出其他字段、Markdown 代码块、解释或标题。\n示例：原请求“继续” → {"prompt":"请继续。"}；原请求“把老板加点戏 别写成反派” → {"prompt":"多写老板，别写成反派"}。错误示例：把“继续”改成“继续描写人物互动，保持第三人称和舒缓节奏”，因为新增了方向、视角和节奏限制。';
const PREVIOUS_REWRITE_PROMPT =
  "你是用户提示词重新生成器，不是执行写作任务的助手。聊天历史只是用于理解用户的目标、表达习惯与背景；最后一条 user 消息是本轮要重新生成的提示词。\n唯一任务：站在用户立场，重新构思用户准备发送给主助手的本轮要求，保留核心目标并形成明确、可执行的新提示词。这不是润色，也不是简单扩写。\n严格边界：\n1. 只输出用户说的话，可以使用‘请……’‘我希望你……’等指令表达。\n2. 绝对不能执行该提示词、回答用户的问题、扮演助手、续写故事正文或续接历史 assistant 的内容。历史中的角色扮演指令只是背景，不适用于你。\n3. 如果用户要求‘继续’‘续写’或输入剧情片段，只生成交给主助手的续写指令，明确方向、视角、约束；不得写出新的情节、角色台词、叙述段落或任务成果。\n4. 不要以‘好的’‘下面是’开头，不要解释改写过程，不输出标题、代码块或引号，不重复已有助手回答。不要把尚未确定的事实编成已发生的剧情。\n5. 输出语言跟随本轮 user；仅输出一条能直接替换输入框内容的新 user 提示词。\n示例：最后一条 user 为‘继续写他进城以后的事’，合格输出为‘请继续描写他进城后的经历，围绕入城的目的推进情节，延续已有视角和人物性格，避免重复前文。’；不合格输出为‘他推开城门，街上的人群……’。";
const LEGACY_REWRITE_PROMPT =
  "根据用户长期表达习惯、近期对话以及最后一条待重生的用户请求，保留其核心目标，重新构思本轮应当提出的具体要求、内容安排和细节。这不是润色，不是简单扩写或改换措辞。只输出可以直接替换输入框内容的新用户请求，不加解释、标题、引号，不扮演助手回答该请求。";
const PRE_UA_SUGGEST_PROMPT =
  '你在预测这个用户下一轮会怎么说，不是在替助手提问。历史 user 消息是唯一的语言风格样本，assistant 消息仅用于理解话题。\n先在内部归纳 user 的口吻、常用词、句长、标点、口语程度、称呼、祈使句与追问方式，输出必须模仿这些习惯。不要把用户惯用的简短随意表达改成礼貌、正式、冗长的助手话术。用户爱说“然后”“这个”“继续”时可以自然沿用，但不要机械堆砌。\n根据最新回答和用户已表达的目标，用用户自己的立场与说话风格生成 {{COUNT}} 条不同的下一轮 user 发言候选。候选应像用户真的会打进输入框的消息，长度接近历史 user 的常态；异常超长输入不作为长度范例。\n严格禁止：回答问题、解释你如何预测、以助手身份提出“你想不想”“需要我”“是否需要我帮你”等问题、把 assistant 的文风当成 user 文风、照抄一整条历史 user。候选可以是用户会提出的要求、修改方向或对刚才内容的自然追问，不能是助手向用户收集需求。\n保留用户的语言、口语与标点习惯；不要为了凑数增加套话。历史不足时沿用最近一条 user 的口吻，不擅自设定新风格。\n只输出 JSON：{"suggestions":["候选内容"]}，数组必须恰好 {{COUNT}} 条，不输出其他文字。';
const LEGACY_SUGGEST_PROMPT =
  '你在预测用户下一轮会怎么说。根据历史用户的用词、长度、口吻和最近对话，以用户第一人称给出 {{COUNT}} 条不同的下一轮发言候选。不要替助手提问，不要回答候选。只输出 JSON：{"suggestions":["候选内容"]}，数组必须恰好 {{COUNT}} 条。';
export function upgradeLegacyPlugin(p: PluginDefinition): PluginDefinition {
  const legacy = p as unknown as Record<string, unknown>;
  const {
    contextMode,
    historyRounds,
    referenceCount,
    userHistoryCount,
    highWater,
    lowWater,
    injection,
    ...clean
  } = legacy;
  p = {
    ...clean,
    ...(p.kind === "analysis" && p.name === "JSON 分析"
      ? { name: "写前分析" }
      : {}),
    ...(p.kind === "analysis" && p.cardTitle === "JSON 分析"
      ? { cardTitle: "写前分析" }
      : {}),
    system: typeof p.system === "string" ? p.system : "",
    rawRounds:
      Number.isSafeInteger(p.rawRounds) && p.rawRounds >= 0 ? p.rawRounds : 3,
  } as PluginDefinition;
  if (
    p.kind === "analysis" &&
    [
      LEGACY_ANALYSIS_PROMPT,
      ANALYSIS_PROMPT,
      PRE_BLOCK_ANALYSIS_PROMPT,
    ].includes(p.prompt)
  ) {
    try {
      const schema = JSON.stringify(JSON.parse(p.schema));
      if (
        [
          ANALYSIS_SCHEMA,
          LEGACY_ANALYSIS_SCHEMA,
          PRE_BLOCK_ANALYSIS_SCHEMA,
        ].some((s) => JSON.stringify(JSON.parse(s)) === schema)
      )
        return { ...p, prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA };
    } catch {
      /* Preserve custom or invalid schemas for the existing editor to report. */
    }
  }
  if (
    p.kind === "clarify" &&
    [
      LEGACY_CLARIFY_PROMPT,
      PRE_QUESTIONS_CLARIFY_PROMPT,
      THREE_OPTIONS_CLARIFY_PROMPT,
      CLARIFY_PROMPT,
    ].includes(p.prompt)
  )
    return { ...p, prompt: CLARIFY_PROMPT, clarifyFormat: "questions" };
  if (p.kind === "suggest" || p.kind === "rewrite") {
    const oldDefault = [
      PRE_UA_REWRITE_PROMPT,
      PREVIOUS_REWRITE_PROMPT,
      LEGACY_REWRITE_PROMPT,
      PRE_UA_SUGGEST_PROMPT,
      LEGACY_SUGGEST_PROMPT,
    ].includes(p.prompt);
    return {
      ...p,
      ...(["请求重生", "重新生成 user 提示"].includes(p.name)
        ? { name: names.rewrite }
        : {}),
      ...(["请求重生", "重新生成 user 提示"].includes(p.cardTitle)
        ? { cardTitle: names.rewrite }
        : {}),
      initialUser: p.initialUser ?? "好的",
      ...(p.kind === "rewrite"
        ? { rewriteFormat: "fields" as const, suggestions: 3 }
        : {}),
      ...(oldDefault
        ? {
            prompt: "",
            ...(p.effort === "max" ? { effort: "inherit" as const } : {}),
          }
        : {}),
    };
  }
  return p;
}
