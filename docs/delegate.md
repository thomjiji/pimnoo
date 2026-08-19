# Delegate worker

主 Pi 通过 `delegate` tool 管理无界面 worker：`action: "start"` 一次启动一个或多个 worker，每个 task 至少提供一个明确的 `prompt`，也可以提供 `name`、`role`、`model` 和 `thinkingLevel`；启动之后可以按 task ID 继续控制它们。

- `steer`：向正在运行的 worker 发送 steering message，在下一个模型调用前到达；worker 空闲时应使用 `follow_up`。
- `follow_up`：发送等到当前 agent run settle 后才执行的消息，支持同一 worker 的多轮任务。
- `status`：查询单个 worker（`taskId`）或全部 worker 的状态。
- `wait`：等待一个或一组 worker（`taskIds`，默认全部）到达终态并取回与 task ID 关联的最终报告；父会话按 Escape 取消等待。
- `stop`：中止并终止指定 worker，保留其 session 和 worktree 供检查。
- `logs`：返回指定 worker 的有界最近活动（turn、工具调用与结果、assistant 文本），用于判断它当前在做什么。
- `clean`：删除已终态 worker 的 session 文件、worktree 和 `subagent/task-*` 分支；先用 `dryRun: true` 预览，`includeOrphans: true` 才会处理当前 supervisor 未登记的遗留产物。

`delegate wait` 等待期间会周期性地把每个目标 worker 的进度行（状态、turn、当前工具与耗时、总耗时）流进主对话流；`delegate logs <taskId>` 可以拉取指定 worker 的最近活动。顶层 `maxTurns`、`softTurnThreshold`、`timeoutMs` 可以作为所有 task 的默认值，task 内的显式值优先。

有活跃 worker 时，输入框上方会常驻显示 worker 列表：白色醒目的 `delegate: N active workers` 标题行下，用 box-drawing 层级列出每个 worker 的灰色状态行（turn、当前工具与耗时、总耗时），每 200ms 刷新；最多显示 5 行，超出折叠为 `↓ N more`；worker 结束后其行会停留几秒再消失。列表是纯显示，不占用任何按键。

查看子会话走 Pi 原生 session 机制而不是弹窗：给 `app.session.resume` 绑定一个键（例如 `~/.pi/agent/keybindings.json` 里 `"app.session.resume": ["ctrl+j"]`），按键后在 `/resume` 的 All 范围用方向键选择并回车进入任意 `subagent/*` 会话——主 TUI 直接切换视图，`/resume` 再切回主会话。worker 运行期间子会话的 JSONL 随消息完成持续落盘，切换进去即可看到它已产生的会话流。

每个 worker 使用独立的 Git worktree 和持久 RPC session，完成后不会自动合并、提交或删除 worktree。使用 `delegate clean` 时只会清理终态 worker；显式指定仍在运行的 task 会被拒绝，全量清理不会隐式停止活跃 worker。`dryRun` 只列出将删除的 session、worktree 和分支，不修改文件；`includeOrphans` 用于清理上一次 supervisor 进程留下的、可识别为 delegate 产物的孤儿资源，使用前必须确认没有仍在运行的对应 worker。清理逻辑保护主 worktree、主 session 和非 `subagent/task-*` 会话。

每个 task 可选配置 `maxTurns`（默认 60）、`softTurnThreshold`（默认 `maxTurns - 2`）和 `timeoutMs`（默认不设）：达到软阈值会收到收尾 steering 并进入 `wrapping up`；硬限制后宽限期内未 settle 会被 abort 并标记 `limit-reached`；总超时终止并标记 `timed-out`。返回给主 Pi 的最终文本有 2000 字符上限，完整对话仍保存在 worker session JSONL 中。

状态机区分 `starting`、`running`、`waiting`、`wrapping up`、`completed`、`failed`、`aborted`、`stopped`、`limit-reached` 和 `timed-out`；主 TUI 的编辑器上方只在有活跃 worker 时显示紧凑列表，全部结束后自动清除。
