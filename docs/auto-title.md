# auto-title 工作原理

为没有手动名称的 session 生成英文短标题，全部实现位于 `packages/thomo-auto-title/index.ts`。

## 触发时机

- 新会话第一次交换 settle 后（`agent_settled`）。
- 无名字的老会话在 start / resume / fork 时。
- `/autotitle` 强制重新生成。

已有名字的会话不触发，名字只生成一次，之后不刷新。

## 给 LLM 的输入

遍历当前分支的所有 user / assistant 消息（跳过空文本），只选最多 4 个锚点：

- 首条 user 消息（定主题）。
- 末条 user 消息（定当前目标）。
- 末条 assistant 消息。
- 首条 assistant 消息。

锚点索引去重后按原始顺序排列，被跳过的消息用 `[...messages omitted...]` 占位。每条消息单独裁剪：user 最多 1400 字符，assistant 最多 500 字符，超长时保留首尾段落。系统提示要求标题不超过 40 字符、优先使用完整单词、英文 ASCII、sentence case、无 emoji，并要求模型在输出前自行计数。

## 输出处理

模型按回退链尝试：`deepseek/deepseek-v4-flash` -> `openai-codex/gpt-5.6-luna` -> 当前模型 -> 首个已配置认证的模型。`cleanTitle` 去掉 code fence 和加粗标记、取首个非空行、剥掉引号和尾标点、保证句首大写（仅在模型输出全大写时统一转小写，保留 ChatGPT 这类专有名词的大小写），并在超过 40 字符时优先按完整单词截断。最终会话名是 `标题 (YYYY-MM-DD HH:mm)`。

## 约束

- 已有名字永不覆盖（`/name` 设置的名字优先）。
- `/autotitle on|off` 是会话级开关；`PI_AUTOTITLE=0` 全局关闭；`PI_AUTOTITLE_MODEL` 覆盖标题模型。
- 单次命名互斥、30 秒超时、session 切换时中止，避免竞态和残留请求。
