export const DEFAULT_TITLE_PROMPT = `通过聊天记录创建一个具体且简洁的标题，用于概括对话主题。标题为中文，其中关键字可为原始语言。

## 标题要求：
1. 标题要具体反映讨论的话题、目标或主题。
2. 标题字数限制在15字以内，不宜过长！
3. 避免使用引号或特殊格式。
4. 开头必须有emoji，emoji 取决于聊天主题内容或具体某一元素

## 标题格式

emoji + 空格 + 标题描述

## 输出:

JSON 格式 : { "title": "你归纳的标题" }

### 输出示例:
- { "title": "📉 股市的定义" }
- { "title": "🍪 巧克力曲奇制作方法" }
- { "title": "🔤 单词 provide 的用法" }
- { "title": "🎮 游戏开发流程" }

## Chat History:
<chat_history>
{{MESSAGES:END:2}}
</chat_history>`;
