# delegate 实际运行诊断报告

## 报告范围

本报告复盘了一次真实的 `delegate` 调用，目的是判断两个 headless worker 的运行情况，以及父会话在等待过程中看起来“卡住”的原因。后来确认，用户当时并不知道父会话正在等待 worker 自然结束，因此主动中止了父会话操作并通过 `/resume` 切换到子会话查看；这次主动取消本身是预期交互，不应被误判为 delegate 自动失败。检查对象包括父会话 JSONL、两个 worker 会话 JSONL、worker worktree、`extensions/delegate/` 实现和现有测试。

本次任务只读调研 Pi 的 `Ctrl+O` 行为，没有要求 worker 修改仓库代码。

## 本次调用

父会话调用了一个 `delegate start`，同时启动两个 worker：

- `task-364c2897-2299-4395-8151-f066b7e416c2`，名称 `pi-source-investigation`，会话文件 `/root/.pi/agent/sessions/--workspace-pimnoo--/2026-08-15T09-38-51-885Z_01a004c9-d76d-778f-b4d6-1ef5c70bcf68.jsonl`。
- `task-168e9311-8306-4b7c-89b7-cf5acfc08f4f`，名称 `pi-extension-docs`，会话文件 `/root/.pi/agent/sessions/--workspace-pimnoo--/2026-08-15T09-38-52-641Z_01a004c9-da61-7131-9b80-8c9a5dd82bf3.jsonl`。

两个 worker 都获得了独立 worktree，起始 commit 相同，分别位于 `/workspace/.pimnoo-delegate-worktrees/<task-id>`。两个 worktree 最终都没有未提交修改，也没有产生 commit。

## 重要的调用参数问题

当时的调用把 `maxTurns: 40` 和 `timeoutMs: 120000` 放在了 `delegate start` 的顶层，而当前工具 schema 要求这些字段放在每个 `tasks[]` 元素内。实际调用记录中的两个 task 对象没有这些字段，`delegate` 返回的 start details 也只显示了 `name`、`role`、`prompt` 等字段。

因此，本次运行实际上使用了默认限制：`maxTurns` 默认 60，`timeoutMs` 未设置。两个 worker 长时间运行本身不能作为 timeout 功能失效的证据，这是本次调用方式错误造成的观察偏差。以后应这样传递限制：

```json
{
  "action": "start",
  "tasks": [
    {
      "name": "worker",
      "prompt": "...",
      "maxTurns": 40,
      "timeoutMs": 120000
    }
  ]
}
```

代码层面还有一个值得修正的类型问题：`extensions/delegate/index.ts:18-24` 中的 `DelegateParameters.tasks` 类型没有声明 `maxTurns`、`softTurnThreshold` 和 `timeoutMs`，虽然运行时对象仍然会保留这些字段并传给 supervisor，但类型定义没有反映实际 schema。

## Worker 1：正常完成

### 工作过程

Worker 1 从 `09:38:51` 开始，约在 `09:48:30` 完成，最终状态是 `completed`，共记录 53 个 agent turns。它主要进行了以下工作：

1. 读取 research skill、项目 README、package manifest、Pi 官方 docs 和本机已安装 Pi 包。
2. 通过 `grep`、`read` 和 source map 调查 `app.tools.expand`、`toolOutputExpanded`、`setToolsExpanded()`、扩展快捷键冲突、tool renderer 和 thinking 渲染。
3. 遇到两个可恢复的小问题：读取不存在的 `/workspace/.../CONTEXT.md` 返回 `ENOENT`；一次 `find` 调用使用了当前环境不支持的 `--no-require-git` 参数并返回错误。它随后改用可用的目录检查方式继续，没有陷入循环。
4. 将约 17 KB 的报告写入 `/tmp/pi-source-findings.md`，然后检查文件大小和 parent worktree 状态。

### 结果

Worker 1 的最终文本成功返回，结论与本次调研目标匹配：Pi 当前的 `Ctrl+O` 是全局 boolean，默认扩展快捷键不能直接覆盖保留的 `app.tools.expand`，完整多档支持需要 Pi 核心 seam。

这部分表现正常：创建、执行、写报告、返回最终文本和保留 worktree 都成功。

## Worker 2：没有自然完成，被父会话取消

### 工作过程

Worker 2 从 `09:38:52` 开始，共记录 32 个 assistant turns 和 125 个 tool results。它主要完成了：

1. 检查 `registerShortcut()`、keybindings manager、`CustomEditor`、raw terminal input、tool renderer、`AssistantMessageComponent` 和 Markdown transformer。
2. 核对 `/reload`、`ctx.ui`、`getToolsExpanded()`、`setToolsExpanded()` 等官方文档和源码。
3. 在 `09:44:14` 左右完成最后一批源码检索后，长时间没有新的 session 记录。
4. 在 `09:59:08.154` 开始尝试把最终报告写入 `/tmp/pi-extension-findings.md`，但该 write tool call 被中止，没有收到 tool result。

最终 `/tmp/pi-extension-findings.md` 不存在，worker session 也没有最终 assistant report。它不是因为研究内容失败，而是在最终写报告阶段被终止。

### 终止原因

父会话在 `09:45:20` 发起 `delegate wait`，等待两个 worker 进入终态。用户在 `09:57:02.518` 发送了“卡住了？”；父会话因此中止当前模型操作，传给 `delegate wait` 的 AbortSignal 也被触发。

`WorkerSupervisor.waitForTerminal()` 的设计是：父等待被取消时，对目标中仍未终止的 worker 执行 `abortAndTerminate(worker, "stopped")`。因此 Worker 2 被标记为 `stopped` 是设计行为，不是 supervisor 把一个已完成 worker 误判为 stopped。Worker 1 当时已经是 `completed`，所以保持 completed。

## 取消后的延迟：不是原始等待故障，但有实现改进点

父会话原本是在正常等待两个 worker 结束。用户因为不知道这是预期的 wait 行为而主动取消，并通过 `/resume` 查看子会话；取消动作本身不是异常。取消处理随后没有立即返回，而是直到 `09:59:08.492` 才得到：

```text
Wait cancelled by parent; current states:
worker 1: completed
worker 2: stopped
```

从用户取消到 delegate 返回约 126 秒。这与代码实现相符：

- `extensions/delegate/supervisor.ts:302-310` 的 wait abort handler 会顺序调用 `abortAndTerminate()`。
- `extensions/delegate/supervisor.ts:637-642` 的 `abortAndTerminate()` 首先 `await worker.rpc.request({ type: "abort" })`。
- `extensions/delegate/supervisor.ts:643-644` 虽然注释写着“Bounded grace”，但 300 ms 的 `waitForStatus()` 只发生在 abort RPC 请求返回之后。
- Pi RPC server 的 `rpc-mode.js` 对 `abort` 执行 `await session.abort()`；`AgentSession.abort()` 又会 `await waitForIdle()`。如果 worker 正在等待 provider/model 请求结束，abort response 本身可能长时间不返回。

因此，当前所谓的 300 ms bounded grace 不能限制整个 abort 流程，只能限制 abort response 已经返回后的 settle 等待阶段。真实运行中，worker 正在模型调用或模型调用迟迟没有结束时，父会话的取消处理可能被一个无超时的 `rpc.request({ abort })` 延迟。

这不是本次“原始 wait 卡住”的证据，因为原始 wait 是按设计等待 worker 结束；它是用户主动取消之后暴露出的终止路径健壮性问题。现有 fake worker 测试没有暴露它，因为 `extensions/delegate/test-fixtures/fake-rpc-worker.mjs` 会立即响应 `abort`，随后才释放 hold。

## 其他观察

### 状态和报告行为

- start 阶段正确创建了两个独立 worktree、两个分支和两个 persistent session file。
- worker 的 session JSONL 保留了完整工具调用和模型消息，适合事后诊断。
- Worker 1 的 worktree 状态干净，Worker 2 的 worktree 也干净；没有出现跨 worktree 写入。
- Worker 2 被父取消时正好处于写报告调用，因而没有报告文件。这符合“终止正在运行的 worker 时保留 session/worktree，但不保证当前 tool call 完成”的行为。
- delegate 的状态 footer 不会因为 worker 状态变化而破坏主会话；`onStateChange` 的 UI 更新被 try/catch 保护。

### 测试覆盖缺口

现有 `extensions/delegate/delegate.test.ts:552-571` 覆盖了父取消 wait 会停止被等待 worker，但 fake worker 的 abort response 是立即的，没有覆盖下面的真实情况：

- abort RPC 永远不返回。
- abort RPC 延迟数秒后才返回。
- worker 在模型请求期间不处理 stdin 的 abort 命令。
- 父取消后应在有限时间内结束 wait 并强制终止子进程。

建议增加一个 fake worker directive，例如 `@fake:hang-abort`，让它收到 abort 后不回复，然后验证 `waitForTerminal()` 在固定上限内仍返回 `stopped`，同时 worker 进程被 SIGTERM/SIGKILL 清理。

## 建议 delegate 开发 agent 优先检查

1. 将 `abortAndTerminate()` 中的 abort RPC 请求改为有界等待，或并行发起 terminate fallback；不能让 `await worker.rpc.request({ type: "abort" })` 成为无限等待点。
2. 明确 abort 的优先级：先尝试让 worker 记录 abort，再在短 deadline 后直接关闭 stdin、发送 SIGTERM，必要时发送 SIGKILL。
3. 为 abort request 增加超时或取消能力，同时确保超时后不会留下 pending request、未处理 rejection 或重复状态转换。
4. 增加“abort response hang / delayed abort response”集成测试，并把 parent wait cancellation 的总耗时作为断言。
5. 修正 `DelegateParameters.tasks` 的 TypeScript 类型，使其包含 schema 已支持的三个限制字段，避免调用方和实现对参数层级产生误解。
6. 在文档和 tool description 中明确：父会话取消 wait 会停止目标 worker，而不是只取消等待；如果需要保留 worker，应使用 status 或不要取消 wait。

## 总结判断

本次两个 worker 的并发启动和独立 worktree 隔离工作正常。Worker 1 完整成功，Worker 2 的研究本身也已接近完成，随后因用户主动取消父会话而在最终写报告阶段被终止。

原始 wait 并没有证据表明发生了两个 worker 互相阻塞、worktree 损坏或 session 文件损坏；它只是按设计等待 worker 进入终态。需要转交 delegate 开发 agent 的改进点是：父会话取消后，supervisor 在 `abortAndTerminate()` 中无界等待真实 Pi 的 abort RPC，可能导致取消响应延迟；现有测试使用立即响应 abort 的 fake worker，因此没有覆盖这个场景。

另一个独立的本次使用问题是我把 `maxTurns` 和 `timeoutMs` 放错了层级，导致本次两个 worker 没有启用预期的运行限制。这一点应与 abort cancellation 的实现问题分开处理。

## 证据索引

- 父会话：`/root/.pi/agent/sessions/--workspace-pimnoo--/2026-08-15T09-33-53-357Z_01a004c5-494d-79f0-aa7f-8b9eed83eb23.jsonl`。
- Worker 1 会话：`/root/.pi/agent/sessions/--workspace-pimnoo--/2026-08-15T09-38-51-885Z_01a004c9-d76d-778f-b4d6-1ef5c70bcf68.jsonl`。
- Worker 2 会话：`/root/.pi/agent/sessions/--workspace-pimnoo--/2026-08-15T09-38-52-641Z_01a004c9-da61-7131-9b80-8c9a5dd82bf3.jsonl`。
- supervisor 的取消路径：`extensions/delegate/supervisor.ts:288-315,632-676`。
- delegate 参数 schema 和类型：`extensions/delegate/index.ts:7-24,123-129`。
- 现有 parent cancellation 测试：`extensions/delegate/delegate.test.ts:552-571`。
- Pi RPC abort 实现：`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:298-337` 和 `dist/core/agent-session.js:1168-1174`。
