# 插件工作原理与默认提示词

这份文档面向调整提示词的人，也可整份交给其他 AI 阅读。四个插件都是独立的模型调用，共用聊天窗口展示；它们的结果和用户对插件的回答存放在独立插件记录中，不会变成聊天正文里的 assistant 消息。聊天 JSON/Markdown 导出不包含这些运行记录。

下列 Mermaid 图由 GitHub 直接渲染，是可编辑的文字流程图。代码中的默认值是最终依据；本文对应本次更新后的默认值。

## 1. 四个插件分别做什么

| 插件               | 触发时机                         | 输出                                     | 后续行为                                 |
| ------------------ | -------------------------------- | ---------------------------------------- | ---------------------------------------- |
| JSON 分析          | 本轮提问回答完成后、主回答前     | 可自定义 Schema 的 JSON                  | 等待通过、重新生成或跳过后再继续         |
| 提问澄清           | 发送 user 后、主回答前           | 一批自然语言问题                         | 等待用户回答，再将问题和回答交给主模型   |
| 追问建议           | 主回答完成后，也可手动运行       | 模仿 user 口吻的 3 条候选                | 点选后填入输入框，不自动发送             |
| 重新生成 user 提示 | 插件图标右侧或 user 编辑框的按钮 | `{"rewrites":["候选1","候选2","候选3"]}` | 单选一个候选、对比确认后替换，不自动发送 |

发送框左下角的插件图标用于开关和配置；启用 user 重写后，在其右侧显示重写图标。四个上下文组件放在输入框上方，Token 用量不足 1k 显示整数（如 `424`），达到 1k 显示一位小数 k（如 `12.1k`），不加“预计”。插件列表没有排序操作；前置流程固定为提问澄清 → JSON 分析 → 主回复，也可仅启用其中一项。追问与 user 重写独立触发，新聊天默认关闭所有插件。

四个内置插件可以关闭、配置和复制，但不能删除；自建或复制的配置可以删除。插件设置使用 daisyUI 的 List、Fieldset、Collapse、Stats、Progress、Menu、Badge、Modal 和 Loading 组件。提问与用户对插件的回答按 Markdown 渲染。

```mermaid
flowchart TD
    Draft[草稿或历史 user 编辑文本] --> Rewrite{手动点击重写图标?}
    Rewrite -->|是| Rewriter[完整 UA 对调历史；无轮数上限、无水位裁剪]
    Rewriter --> Compare[rewrites 三候选 → 单选 → 对比确认 → 只替换文本]
    Rewrite -->|否，点击发送| User[保存本轮 user]
    User --> Ask{启用提问澄清?}
    Ask -->|是| Q[澄清档案 500.0k → 按完整问答配对裁到 200.0k]
    Q --> Wait[生成问题并等待用户回答]
    Wait --> Pair[保存完整问题与回答]
    Ask -->|否或跳过| Analyze{启用 JSON 分析?}
    Pair --> Analyze
    Analyze -->|是| Input[本轮问答按 Tool Call 或 user 注入分析请求]
    Input --> JSON[叙事状态 JSON；默认参考 1 组，Token 水位关闭]
    JSON --> Gate{用户确认分析结果}
    Gate -->|重新生成，仅重跑分析| Input
    Gate -->|通过| Inject[注入本轮澄清及已通过 JSON]
    Gate -->|跳过，不注入 JSON| Inject
    Analyze -->|否| Inject
    Inject --> Debug{仅调试?}
    Debug -->|是| Review[手动确认使用结果]
    Review --> Main[主模型回复]
    Debug -->|否| Main
    Main --> Suggest[完整 UA 对调历史 → 追问候选；无水位裁剪]
    Suggest --> Choices[候选 → 确认填入草稿，不发送]
    Choices --> Draft
```

前置插件固定先提问、再分析。JSON 分析收到同一流程中已经回答的完整问题/回答；尚未回答、跳过、候选问题及其他分支不会混入。插件记录仍独立保存，不变成聊天正文中的 assistant。关闭某类插件时直接跳过，不会为补齐流程额外调用模型。

## 2. 共有设置、请求与缓存

- **模型**：默认跟随主聊天模型，也可为每个插件选不同模型。主对话和所有插件的新建默认思考强度为“跟随接口”（`inherit`），请求省略 `reasoning_effort`；已有显式选择仍保留，可手动改成其他级别。插件请求参数优先级为：全局参数 → 模型参数 → 插件参数。
- **作用域**：设置中的插件配置是全局定义；当前聊天可以覆盖配置。每次运行保存当时的配置快照，后来改提示词不会改写旧结果。
- **两个前置插件的历史模式**：完全同步主聊天上下文；或最近 N 轮完整问答，默认 N=5。它们复用主聊天的上下文组装规则。
- **模型预算与水位线不同**：模型容量是整个请求的参考预算；水位线只裁相应插件的历史档案，不能保证整个请求一定不超模型窗口。超出预算时界面提示，仍允许发送，不会悄悄换模型。
- **上下文 Token**：发送框上方的插件进度条由前端本地计算，输入时更新，无需发请求，界面不加“预计”。详情可看各段组成；运行后可按需查看该次请求快照。该数值是本地预算参考，上游返回的实际用量单独展示。
- **水位单位**：设置输入与水位展示统一为 `k Token`，例如 `500` 表示 500,000 Token；数据库与 API 仍保存整数 Token。消息列表按 system 紫色、user 蓝色、assistant 绿色、tool 橙色区分，同时保留类型文字。
- **缓存显示**：主回答、JSON 结果、澄清问题、追问建议、重写对比与各自上下文详情，只在上游返回合法 `cache_hit_rate` 时显示缓存率百分比；不显示缓存 Token 数，不从 Token 数推算命中率。`"22%"`、`22`、`"22"`、`0.22` 均显示为 `22%`，显式带 `%` 的精度保留。
- **传输**：可使用 Worker 调用上游，也可使用访问设备直接跨域请求上游。直连要求 HTTPS 和上游 CORS 许可；失败不会自动切换线路或重复调用模型。

```mermaid
flowchart LR
    Global[全局插件定义] --> Merge[合并当前聊天覆盖]
    Override[聊天覆盖] --> Merge
    Merge --> Prepare[preparePlugin 组装 messages]
    History[当前分支历史 + 独立插件记录] --> Prepare
    Prepare --> Preview[本地上下文预览与水位线]
    Prepare --> Request[独立模型请求]
    Request --> Server[Worker → 上游流式]
    Request --> Device[设备 → 上游流式]
    Server --> Save[保存运行结果与当时配置]
    Device --> Save
    Save --> UI[同一聊天窗口展示]
```

前置插件的请求形如 `共同历史前缀 + 最后一条插件 user 指令`。使用同一上游、同一模型、相同前缀，可能获得较好的前缀缓存匹配；更换模型、上游、system 内容或裁剪历史会改变匹配条件。实际是否命中、缓存粒度由上游决定，不能保证。追问与重写都交换历史 user/assistant 角色，因此不能视为与主回答相同的前缀；它们各自重复调用时的共同部分可能复用。可选独立 system 默认空白，不继承主聊天 system，不承诺 100% 缓存命中。

## 3. JSON 分析：叙事状态辅助

默认用途是为主模型写作提供一份显式的角色状态辅助记录，不再生成泛泛的目标、约束和执行计划。Schema 和任务提示词仍可自定义；自定义的旧用途不会被自动改写。

| 字段                   | 内容                                                                                                      | 有资料时的长度目标  | 无依据时                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------- |
| `character_thoughts`   | 所有主要角色各自的 `{character, thought}`；thought 为该角色此刻的第一人称内心文字，仅基于其已知事实与立场 | 每位角色 150–200 字 | 整项 `"none"`，或某角色的 thought 为 `"none"` |
| `scene_state`          | 历史末尾已明确的场景、时间、环境、物件状态                                                                | 150–200 字          | `"none"`                                      |
| `action_state`         | 已发生的人物交互与当前动作状态，区分意图与已完成动作                                                      | 150–200 字          | `"none"`                                      |
| `knowledge_boundaries` | 谁知道什么、谁尚不知道、信息来源和既有误解；叙述者知道不等于角色知道                                      | 50–200 字           | `"none"`                                      |

角色内心是虚构角色的文本，不是模型自己的推理过程，也不是已经发生的未来剧情。场景、动作和认知边界只记录已有状态；本轮对未来的写作要求不能被写成历史事实。缺资料时直接 `"none"`，不为字数编造。JSON 结构、字段及非空文本严格校验；字数写入提示词和 Schema 描述，作为生成目标，不因模型少几个字丢弃完整记录，也不自动补写、截断或重试。

```mermaid
flowchart TD
    H[共同历史前缀] --> Request[独立 JSON 分析请求]
    U[本轮原始 user] --> Context[本轮输入]
    Q[同一流程中已回答的完整澄清问答] --> Mode{澄清注入方式}
    Mode -->|默认 tool| Tool[assistant tool_calls 占位 + tool 结果]
    Mode -->|user| Append[附加到本轮 user]
    Tool --> Context
    Append --> Context
    Context --> Request
    Old[过去完整 提示词 / user / JSON 配对] --> Limit[默认仅留最近 1 组；Token 水位 0.0k 即关闭]
    Limit --> Tail[最后一条 HARD INTERRUPT user 指令]
    Prompt[当前任务 + Schema + 可选固定示例] --> Tail
    Tail --> Request
    Request --> Result[角色内心 / 已有场景 / 已有动作 / 认知边界]
    Result --> Validate{JSON Schema 校验}
    Validate -->|通过| Store[独立保存，等待确认；此时没有主回复请求]
    Store --> Choice{用户操作}
    Choice -->|重新生成| Request
    Choice -->|通过| Inject[仅注入用户通过的结果]
    Choice -->|跳过| Skip[不注入这份 JSON，继续流程]
    Validate -->|失败| Fix[显示错误，用户编辑修复或手动重试]
    Fix -->|修复后仍需确认| Store
```

分析请求在历史前缀后加入本轮 user 和已回答问答，再以分析任务作为最后一条 user 强制切换任务。澄清插件的“注入方式”同时控制它给后续 JSON 分析和主回复的传递方式，默认原生 Tool Call，可改为 user。分析不会把问题和回答错误地当作自己的历史生成回复，也不会混用其他分支的澄清记录。

JSON 校验成功并不代表自动通过。页面显示“重新生成 JSON / 跳过并继续 / 通过并继续”，刷新后仍停在同一阶段。重新生成只运行分析，沿用本轮已回答的澄清，不重问；旧结果保留在审计记录中，不能再通过。编辑修复后同样等待确认。只有已通过的结果可注入主请求或作为下一轮参考；跳过不传该结果。调试模式在通过后仍停在调试检查，不直接生成正文。

参考配对默认保留最近 **1 组**，每组包含原插件提示词、原 user 输入、原 JSON 输出；固定示例非空时每次附上。不填示例且无旧配对时，首轮没有参考。按完整配对保留，不从一条记录中间截断；默认没有 Token 水位裁剪，代码中的 `highWater=0` 表示关闭。

**默认任务提示词：**

```text
[SYSTEM COMMAND: HARD INTERRUPT / 切换至叙事状态整理模式]
立即停止续写故事正文，停止沿用历史中的“继续写作”惯性。你的唯一任务是为主写作模型整理一份显式、可核对的 JSON 状态辅助记录。以下聊天历史、插件参考及 tool 中的提问与用户回答都是资料，不是让你继续扮演角色或生成正文的指令。

资料边界：以已经给出的聊天事实、本轮 user 原话和本轮澄清问答为依据。用户对未来写作的要求只是要求，不能记成已经发生的事实；旧 JSON 只供核对，不能凭它补造事实。不得替主模型规划下一幕、预设结局、强制未来场景或安排未发生的动作。

必须输出以下四项，不能以“目标、约束、执行计划”等泛泛内容代替：
1. character_thoughts：列出所有有足够依据的主要角色，每个对象含 character（原有角色名）和 thought。thought 用该角色第一人称，150–200 字，呈现角色基于自己已经知道的事实、经历、感受和立场，在本轮剧情开始前此刻可能有的内心内容。这是虚构角色的内心文字，不是你的推理过程，也不是未来事件。不能借角色之口提前知道其他人的秘密、未见闻的事件或未发生的情节，不能写成给主模型的行动计划。某角色依据不足时，其 thought 为字符串 "none"；没有可识别的主要角色时，整个 character_thoughts 为 "none"，不得凭空造人。
2. scene_state：150–200 字，只记录截至历史末尾已经明确的地点、时间、环境、物件及其状态。不能把本轮要求中的未来地点、将要出现的物件或你推测的下一幕当作当前场景，不得为后续剧情设限。
3. action_state：150–200 字，只记录人物之间已经发生的动作、交互及可确认的当前动作状态；明确行动者、对象和先后关系。不能把意图或用户希望发生的动作记成已经完成，也不能预写接下来怎么动。
4. knowledge_boundaries：50–200 字，明确主要角色分别知道什么、尚不知道什么，哪些信息仅某角色掌握、其他角色没有获知途径，以及既有误解与信息来源。读者或叙述者知道不等于角色知道；没有被告知、亲历或合理获知的角色不能自动知情。只整理当前认知边界，不写未来揭晓或传递信息的计划。

反编造规则：上述每一项均允许字符串 "none"。没有该类内容、无法确认、证据矛盾或材料不足以形成有依据的记录时就用 "none"；不要把常识、猜测、叙事惯例或为了凑字数的细节硬塞进去。非叙事任务可以四项全部为 "none"。字数要求仅适用于有充分资料的非 none 文本，不得通过编造满足字数。
长度检查：按实际 Unicode 字符计数，标点与空格也计入。要求 150–200 字的非 none 文本，资料充足时尽量写在 175–185 字，不要卡在上下边界；knowledge_boundaries 可写在 80–120 字。输出前逐字段检查长度并只用已有依据调整，不展示计数过程，不用套话或重复内容凑字数。
只输出符合给定 JSON Schema 的 JSON，不输出 Markdown 围栏、说明、正文或额外字段。各字段缺乏依据时的合法输出为：{"character_thoughts":"none","scene_state":"none","action_state":"none","knowledge_boundaries":"none"}。

本轮原始 user 要求：
{{USER_INPUT}}
```

**默认 JSON Schema：**

```json
{
  "type": "object",
  "properties": {
    "character_thoughts": {
      "anyOf": [
        {
          "type": "string",
          "const": "none"
        },
        {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "character": {
                "type": "string",
                "minLength": 1
              },
              "thought": {
                "anyOf": [
                  {
                    "type": "string",
                    "const": "none"
                  },
                  {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S",
                    "description": "资料充足时 150–200 字；仅写已有依据，不为凑字数编造。字数为生成目标，不机械截断或补写。"
                  }
                ]
              }
            },
            "required": ["character", "thought"],
            "additionalProperties": false
          }
        }
      ]
    },
    "scene_state": {
      "anyOf": [
        {
          "type": "string",
          "const": "none"
        },
        {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S",
          "description": "资料充足时 150–200 字；仅写已有依据，不为凑字数编造。字数为生成目标，不机械截断或补写。"
        }
      ]
    },
    "action_state": {
      "anyOf": [
        {
          "type": "string",
          "const": "none"
        },
        {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S",
          "description": "资料充足时 150–200 字；仅写已有依据，不为凑字数编造。字数为生成目标，不机械截断或补写。"
        }
      ]
    },
    "knowledge_boundaries": {
      "anyOf": [
        {
          "type": "string",
          "const": "none"
        },
        {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S",
          "description": "资料充足时 50–200 字；仅写已有依据，不为凑字数编造。字数为生成目标，不机械截断或补写。"
        }
      ]
    }
  },
  "required": [
    "character_thoughts",
    "scene_state",
    "action_state",
    "knowledge_boundaries"
  ],
  "additionalProperties": false
}
```

## 4. 提问澄清

适合写作前收集风格、情节、视角等选择。问题卡片与输入框使用不同样式，表示用户正在回答插件。最新问题展开，旧问题及其回答自动折叠。

```mermaid
flowchart TD
    History[主聊天共同历史] --> Ask[请求澄清插件]
    Tail[本次任务 + 最新 user + 可选示例] --> Ask
    Archive[历史完整配对：500.0k 时整组裁到 200.0k] --> Ask
    Ask --> Question[展示最新问题]
    Question --> Choice{用户操作}
    Choice -->|回答| Answer[保存问题与用户回答]
    Answer --> Inject[本轮问答以 Tool Call 或 user 交给 JSON 分析和主模型]
    Choice -->|重新生成| Candidate[生成候选问题]
    Candidate --> Confirm{确认替换原问题?}
    Confirm -->|是| Question
    Confirm -->|否| Question
    Choice -->|跳过| Next[继续后面的插件或主回答]
```

历史档案默认达到 **500k Token** 时，从最早记录开始按完整“问题 + 用户回答”配对删除，裁到 **200k Token** 以下。每组还带原提示词和原 user 输入；不会把 `AAA` 与 `BBB` 裁成 `ABBB`，不会从某次回答中间截断。裁剪只影响发送视图，原始运行记录保留；同一分支后续运行延续已记录的裁剪位置。

**默认任务提示词：**

```text
结合历史和最新用户的写作要求，提出一批具体、必要的澄清问题。使用自然语言编号提问，便于用户一次回答。参考历史用户选择，避免反复询问已经明确的偏好。不生成正文，不自行回答问题。
本次写作要求：
{{USER_INPUT}}
```

## 5. 追问建议：UA 对调

目标是产生用户下一句指令。模型看到的历史 `assistant` 内容全部来自原用户，原助手的正文则变成 `user`，借此模仿用户口吻。最新主回答完成后生成，也可手动“换一组”；结果与缓存率放在最新回答末尾的独立追问区域，选择只填草稿，不自动发送；已有草稿时先确认是否替换。

```mermaid
flowchart TD
    Branch[当前分支完整 user / assistant 历史] --> Swap[原 user → assistant；原 assistant → user]
    U0[固定开头 user：默认“好的”，可编辑、不能为空] --> Prefix[组装对调历史]
    System[独立可选 system：默认空白；不继承主聊天 system] --> Prefix
    Swap --> Prefix
    Prefix --> Tail[最后一个 user：最新正文 + 简短追问任务]
    Tail --> Model[所选模型，默认跟随接口强度；json_object]
    Model --> Check[校验 suggestions 数组，默认 3 条、非空且不同]
    Check --> Cards[追问候选 + 上游缓存率]
    Cards --> Draft[选择填入草稿，不自动发送]
    Water[无轮数、水位、单条截断；超模型预算只提示，仍可发送] -.-> Prefix
```

正常两轮的实际请求形状：

```text
（请模仿历史 assistant 消息中原用户的口吻，输出用户接下来会发给写作助手的 3 条不同指令。只写用户的要求，不写故事正文。输出 JSON: {"suggestions": ["..."]}，数组恰好 3 条。）
```

完整保留当前分支所有 user/assistant 文字，不再使用“旧 user 档案 + 最近 N 对”拼法；主聊天的轮数设置也不裁剪这两个插件的历史。删除消息导致相邻同角色时，仅在请求中用空行合并，原消息不变。主聊天 system 和历史 system 消息不作为插件 system 继承。没有填写独立 system 时，整个请求没有 system 消息。

**可选 system 默认值：空白。** 开头 U0 默认 `好的`，始终保留，无关闭开关。以下为默认 3 条时内置追加到最后 user 的任务：

```text
（请模仿以上 assistant 发言的口吻，给出 3 条不同的下一步用户指令，输出 JSON: {"suggestions": ["..."]}，数组恰好 3 条。）
```

输出格式：`{"suggestions":["候选1","候选2","候选3"]}`。结构、数量、非空和去重会校验，用户口吻与语义效果仍取决于上游模型。每次换一组只有一次模型请求，不自动重试或添加裁剪。

## 6. 重新生成 user 提示：UA 对调 + 单选候选

与追问共用 UA 对调构造，但最后的任务是改述指定草稿，保留原意、参照原句长度，生成三个不同说法，不替用户续写正文。两者可分别选择模型、参数、独立 system 和 U0；新建默认温度 0.7，可调整。

```mermaid
flowchart TD
    Click[插件图标右侧或历史 user 编辑框点击重写] --> History[读取目标之前的完整分支历史]
    History --> Swap[UA 对调；固定 U0，独立 system 默认空白]
    Draft[当前草稿或历史 user 编辑文本] --> Tail[最后 user：最新原助手回答 + 原草稿 + 简短重写任务]
    Swap --> Tail
    Tail --> Model[所选模型；默认跟随接口；json_object]
    Model --> Validate[校验 rewrites 数组：默认 3 条、非空、不重复]
    Validate --> Review[原文 + 三个单选候选 + 所选文本对比 + 缓存率]
    Review -->|重新生成结果| Tail
    Review -->|单选一个并确认| Replace[仅替换对应输入框；不发送、不保存分支]
    Review -->|取消| Keep[保留原文本]
    Water[完整历史；无水位、无轮数截断、无原句字符硬上限] -.-> History
```

草稿不放进 `assistant` 历史样本中。最新原助手回答标为“前文正文，仅供背景，不是待重写对象”；草稿标为“唯一待重写的用户指令”，避免模型误把正文当成改写目标。若对调历史最后是 `user`，就在该条末尾附加草稿与重写要求；若最后是 `assistant`，追加一条 `user`；首次重写没有历史时，U0 与任务组成唯一的 user。正常对话因此仍严格从 user 开始、以 user 任务结尾。

**可选 system 默认值：空白。** 默认三候选，内置尾部任务示例：

```text
【唯一待重写的用户指令】
"老板加点戏，别写成反派"

只改写上面引号内这一句用户指令，保留原意、参照这句话差不多的字数，换 3 种说法。只换措辞，不新增或细化原句未表达的条件；否定限制不能改成新的肯定设定。不要改写背景正文，不要执行指令或续写故事。
输出 JSON: {"rewrites": ["版本1", "版本2", "版本3"]}，数组恰好 3 条。
```

请求带 `response_format: {"type":"json_object"}`；候选数量可在各自设置修改。提示词中的相近长度是模型生成目标，不按原句字符数拦截，不自动截断或补写。输出必须为 `{"rewrites":["版本1","版本2","版本3"]}`；旧记录的单 `prompt` 结果仍可查看，新请求不再接受旧格式。

三个候选用同一组 Radio 单选，初始未选，确认按钮禁用；只能选其中一个，不合并、不同时应用多个。选中后显示只读的新旧文本对比，确认才替换。生成期间旋转加载，新一组成功后清空旧选择；失败保留旧结果，不自动请求更多次。

历史 user 编辑时，以该消息的父节点截止，原 user、原回复和之后的对话不发给插件；待改述的是编辑框当前文本。确认只替换该编辑框，还需手动保存为新分支，不影响发送框草稿。完整历史超过模型预算时只提示，不自动截断或换模型。

## 7. 前置结果怎样注入主请求

两种方式都只改变本次发给模型的消息，不往保存的主 assistant 正文里塞插件 JSON。

```mermaid
flowchart LR
    Result[前置插件结果] --> Template[渲染注入模板]
    Template --> Mode{注入方式}
    Mode -->|user| Append[附加到本轮 user 的末尾]
    Mode -->|tool| Call[增加 assistant tool_calls 占位]
    Call --> Tool[紧接 role=tool 的结果消息]
    Append --> Main[主模型 Chat Completions 请求]
    Tool --> Main
```

Tool 模式使用成对的原生 `assistant.tool_calls` / `tool` 消息，调用名称和 ID 由程序生成；不要求插件模型自己输出 tool-call JSON。上游需要支持此消息格式，不支持时可在插件配置切换为 user 注入。澄清插件注入的是 `questions` 和 `answer`；JSON 插件注入的是其 JSON 输出。

**默认注入模板：**

```text
以下为{{PLUGIN_NAME}}的辅助结果，请结合用户原始要求使用：
{{RESULT}}
```

## 8. 调整提示词时应保留的接口

| 位置           | 可用占位符                                        | 注意事项                                                                                                  |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 插件任务提示词 | `{{USER_INPUT}}`、`{{COUNT}}`                     | 前置插件可引用最新 user；追问数量用 COUNT。追问/重写在此填写独立可选 system；草稿由尾部任务追加，无需重复 |
| 前置注入模板   | `{{RESULT}}`、`{{PLUGIN_NAME}}`、`{{USER_INPUT}}` | RESULT 是 JSON 结果或问题/回答结构的文本；USER_INPUT 是本轮主 user                                        |
| 固定示例       | 自己填写的文本                                    | JSON/澄清插件每次都会附上非空示例，不会只在首轮使用                                                       |

不存在自动识别的 `{{HISTORY}}`、`{{ASSISTANT}}`、`{{SYSTEM}}` 等占位符。历史由程序作为 messages 组装，不需要让模型再去“获取历史”。前置提示词省略 USER_INPUT 时，程序自动在任务末尾补最新 user；任务提示词还兼容旧写法 `{user_input}`。

可复制给其他 AI 的需求：

```text
请先阅读这份插件说明。我只想修改【插件名称】的任务提示词。
目标行为：【描述目标】
当前出现的问题：【粘贴不符合预期的输出及脱敏样例】
请保留该插件的输入消息组成、输出格式和可用占位符。
JSON 分析需要同时给出匹配的 Schema；追问建议必须输出 suggestions JSON，数量为 {{COUNT}}；
重新生成 user 提示必须输出 {"rewrites":["候选1","候选2","候选3"]}；保持原意、相近长度，不执行它或续写正文。
追问与重写的可选 system 默认空白，内置简短任务位于最后 user；不要改变 UA 对调或误把它还原为真实角色。
请给我可直接粘贴的完整任务提示词，并说明需要同步改哪些示例或注入模板。
```

## 9. 对应源码

- [默认值、提示词、上下文组装、裁剪、校验和注入](../src/shared/plugins.ts)：`pluginDefaults`、`upgradeLegacyPlugin`、`preparePlugin`、`normalizePluginOutput`、`injectPlugins`。
- [服务器编排与状态机](../src/server/plugins.ts)：前置流程、提问/回答、候选替换、独立运行、重试、运行记录保存。
- [插件界面](../src/client/plugins-ui.tsx)：开关、配置、上下文详情、问题卡片、建议、草稿对比；不提供排序。
- [UA 对调与简短候选任务](../src/shared/candidate-requests.ts)：`swappedHistory`、`candidateTask`；完整历史、U0 与最后 user 任务。
- [叙事状态默认提示词与 Schema](../src/shared/analysis-defaults.ts)：人物内心、场景、动作、认知边界、`none` 与长度目标。
- [设备直连与流式保存](../src/client/device-connection.tsx)、[流式解析](../src/shared/completion.ts)。
- [上下文与插件逻辑测试](../tests/plugins.test.ts)、[Worker 集成测试](../tests/worker.test.ts)、[插件浏览器测试](../tests/browser/plugins.spec.ts)。

旧内置名称会升级；追问/重写未修改的旧长默认提示词清空为可选 system 空白，并补上默认 U0。自定义提示词、模型与参数保留。候选插件过去保存的档案水位、条数和轮数不再参与请求。主对话与插件新建默认强度均为跟随接口，已有显式强度保留。JSON 分析旧默认提示词和 Schema 仍成对升级；旧已完成记录不追溯要求重新确认，新结果必须通过后才使用。

维护规则：后续修改插件消息组成、默认提示词/Schema、执行流程或水位时，同步维护本文件及 Mermaid 图；该规则也已写入仓库 AGENTS.md。
