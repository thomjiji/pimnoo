# pimono

`pimono` 是一个由 Git 跟踪的个人 Pi umbrella package。它把个人扩展作为一个安装和更新单元管理，不创建独立的子 package，也不依赖自动发现目录中的旧副本。

## 包含的扩展

| 扩展 | 入口 | 用途 |
| --- | --- | --- |
| `auto-title` | `extensions/auto-title/index.ts` | 为没有手动名称的 session 生成英文短标题 |
| `bash-readable` | `extensions/bash-readable/index.ts` | 只改变 Bash 工具的显示格式，不改变执行行为 |
| `delegate` | `extensions/delegate/index.ts` | 在独立 Git worktree 中启动 headless Pi RPC worker |
| `export-md` | `extensions/export-md/index.ts` | 通过 `/export-md` 导出只包含提示和回复的 Markdown |
| `no-italic` | `extensions/no-italic/index.ts` | 禁用 TUI 的 italic 显示样式 |
| `reply-anchor` | `extensions/reply-anchor/index.ts` | 在 agent 回复开头添加可搜索的 `§` 锚点 |

`bash-readable/format.ts` 是 package 内部 helper，不是 Pi extension。根目录的 `package.json` 通过 `pi.extensions` 声明 `./extensions`，Pi 的 package 目录发现规则只加载每个子目录的 `index.ts`，因此 helper 和测试不会被当成 extension 加载。

## Delegate worker

主 Pi 通过 `delegate` tool 管理无界面 worker：`action: "start"` 一次启动一个或多个 worker，每个 task 至少提供一个明确的 `prompt`，也可以提供 `name`、`role`、`model` 和 `thinkingLevel`；启动之后可以按 task ID 继续控制它们。

- `steer`：向正在运行的 worker 发送 steering message，在下一个模型调用前到达；worker 空闲时应使用 `follow_up`。
- `follow_up`：发送等到当前 agent run settle 后才执行的消息，支持同一 worker 的多轮任务。
- `status`：查询单个 worker（`taskId`）或全部 worker 的状态。
- `wait`：等待一个或一组 worker（`taskIds`，默认全部）到达终态并取回与 task ID 关联的最终报告；父会话按 Escape 取消等待。
- `stop`：中止并终止指定 worker，保留其 session 和 worktree 供检查。
- `logs`：返回指定 worker 的有界最近活动（turn、工具调用与结果、assistant 文本），用于判断它当前在做什么。

`delegate wait` 等待期间会周期性地把每个目标 worker 的进度行（状态、turn、当前工具与耗时、总耗时）流进主对话流；`delegate logs <taskId>` 可以拉取指定 worker 的最近活动。顶层 `maxTurns`、`softTurnThreshold`、`timeoutMs` 可以作为所有 task 的默认值，task 内的显式值优先。

查看子会话走 Pi 原生 session 机制而不是弹窗：给 `app.session.resume` 绑定一个键（例如 `~/.pi/agent/keybindings.json` 里 `"app.session.resume": ["ctrl+j"]`），按键后在 `/resume` 的 All 范围用方向键选择并回车进入任意 `subagent/*` 会话——主 TUI 直接切换视图，`/resume` 再切回主会话。worker 运行期间子会话的 JSONL 随消息完成持续落盘，切换进去即可看到它已产生的会话流。

每个 worker 使用独立的 Git worktree 和持久 RPC session，完成后不会自动合并、提交或删除 worktree。每个 task 可选配置 `maxTurns`（默认 60）、`softTurnThreshold`（默认 `maxTurns - 2`）和 `timeoutMs`（默认不设）：达到软阈值会收到收尾 steering 并进入 `wrapping up`；硬限制后宽限期内未 settle 会被 abort 并标记 `limit-reached`；总超时终止并标记 `timed-out`。返回给主 Pi 的最终文本有 2000 字符上限，完整对话仍保存在 worker session JSONL 中。

状态机区分 `starting`、`running`、`waiting`、`wrapping up`、`completed`、`failed`、`aborted`、`stopped`、`limit-reached` 和 `timed-out`；主 TUI 的状态栏只在有活跃 worker 时显示单行汇总，全部结束后自动清除。

## 安全和信任

Pi package 中的 extension 是可执行代码，拥有 Pi 进程的完整系统权限。安装前请审查 Git 仓库和将要运行的 commit。项目 scope 的安装仍然遵循 Pi 的 project trust 流程；不要为了绕过信任提示而把源码复制到全局 extension 目录。

## 新机器安装

正常的个人安装使用不带 tag 或 commit 的 Git source。将下面的 URL 替换为自己的私有仓库地址；不带 ref 是有意设计的，后续更新跟随仓库默认分支。

```bash
pi install git:github.com/<account>/pimono
```

`pi install` 默认写用户 settings，因此这些扩展在所有项目中可用。安装后用下面的命令确认 package 已进入 Pi 管理状态：

```bash
pi list
```

如果只想在一个项目中测试或选择性采用，可以使用 project scope：

```bash
cd /path/to/project
pi install -l git:github.com/<account>/pimono
```

安装 package 前请确认项目和仓库可信。不要把 API key 或其他 credential 写入 package、settings 或测试 fixture。

## 本地 checkout 开发

开发时直接使用 checkout 作为 local package。local path 只写入 settings，不会复制源码，所以修改 checkout 后可以直接检查最新实现：

```bash
pi install /path/to/pimono
```

只开发单个组件时可以只挂载该组件而不切换整个包：在 `~/.pi/agent/settings.json` 的 `packages` 里用对象形式把该组件从 git 源排除（例如 `{"source": "git:github.com/<account>/pimono", "extensions": ["!extensions/<name>/**"]}`），同时在 `extensions` 数组里挂载 checkout 里的组件目录；新组件直接挂载即可。修改 settings 后 `/reload`，并确认每个扩展只加载一次——同一个组件从两个来源加载会重复注册。

Windows 主机可以在 settings 中使用主机路径，例如 `C:\Users\<name>\git\pimono`。如果 Pi 在 WSL、容器或其他 runtime 中运行，应把这个路径替换为该 runtime 能访问的对应路径；扩展代码不包含任何环境专用 loader path。

在 Pi 中修改扩展后运行 `/reload`。`/reload` 会重新加载 package 管理的 extensions；不需要复制文件或重启 Pi。开发期间也可以用一次性加载检查 package：

```bash
pi -e /path/to/pimono
```

## 更新和回滚

常规更新只需要执行：

```bash
pi update --extensions
```

因为正常 source 没有 ref，Pi 会把 managed Git checkout 更新到仓库默认分支。仓库的默认分支是多个机器之间的同步源，提交前请先运行测试和 smoke test。

如果新 commit 有问题，优先在远端默认分支上 revert 或修复该 commit，然后再次运行 `pi update --extensions`。需要临时固定版本时，可以显式安装一个 tag 或 commit：

```bash
pi install git:github.com/<account>/pimono@<known-good-tag-or-commit>
```

固定版本适合恢复和调查，不是本 package 的常规更新策略。未来如果需要稳定发布，可以在不改变 `extensions/` 布局的情况下增加 release tag、版本和独立 package manifest。

## 清理旧的全局副本

安装 managed package 后必须确保旧的自动发现副本不再加载。当前迁移涉及以下路径：

```text
~/.pi/agent/extensions/auto-title/
~/.pi/agent/extensions/bash-readable.ts
~/.pi/agent/extensions/bash-readable/
~/.pi/agent/extensions/export-md.ts
~/.pi/agent/extensions/no-italic.ts
```

先停止 Pi 并确认 package 已安装，再把旧路径移出 `~/.pi/agent/extensions/`。仓库提供的脚本会把它们移动到同一个 agent directory 下的 `extensions-disabled/pimono/` 备份目录，不会删除源码：

```bash
node scripts/disable-legacy-extensions.mjs --dry-run
node scripts/disable-legacy-extensions.mjs
pi list
```

如果 Pi 使用自定义 agent directory，请设置 `PI_CODING_AGENT_DIR` 后运行脚本。不要仅仅在自动发现目录中改名为另一个 `.ts` 文件，因为它仍然可能被 Pi 加载。清理后重新启动 Pi，并确认 `/autotitle` 和 `/export-md` 各出现一次；bash tool 和 no-italic 也应只注册一次。

## 维护清单

新增 extension 时按下面的顺序操作：

1. 将源码放入 `extensions/<name>/`，把入口命名为 `index.ts`。
2. 在根 `package.json` 的 `pi.extensions` 允许范围内确认入口可被发现；不要把 helper、fixture、测试或文档放入可执行入口。
3. 为可观察行为增加独立于 package 安装机制的测试；如果 extension 没有合适的纯函数 seam，至少让 smoke test 验证加载成功。
4. 更新上面的扩展清单和本节 checklist。
5. 检查旧全局副本、命令重复和不应加载的 helper。
6. 设置可信的 Pi CLI 路径并运行 `PI_BIN=/path/to/pi npm test`、`npm run typecheck` 和 `git diff --check`。
7. 在干净 agent directory 中运行 package smoke test，然后再提交默认分支。

未来如果某个扩展获得独立用户、依赖或 release cadence，可以把它拆成自己的 Pi package。拆分时为该扩展增加自己的 manifest、README、版本和依赖契约，不需要改变其他扩展的行为契约。

## 测试

单元测试不需要 live model、credential、npm publication 或用户现有的 Pi settings：

```bash
npm run test:unit
```

完整测试的 package smoke test 需要一个明确指定的 Pi CLI 路径，但不读取用户的全局 settings、sessions、credentials 或自动发现 extensions。路径可以来自本机的 Pi toolchain、项目依赖或容器镜像：

```bash
PI_BIN=/path/to/pi npm test
```

Smoke test 会创建临时 Pi agent directory，使用本地 package manager 安装 package，启动 RPC mode 检查 command 和 no-italic 行为，验证 legacy duplicate loading，并通过受控本地 Git HTTP remote 验证无 ref source 可以被 `pi update --extensions` 更新：

```bash
npm run test:smoke
```

`npm run typecheck` 使用 Node 的 TypeScript strip-types syntax check 检查所有 extension 源码。Pi extension 由 jiti 在运行时加载，不需要预编译；完整 package boundary 验证由 smoke test 完成。

## 目录和发布范围

根 `package.json` 是 umbrella package 的唯一 manifest。`extensions/` 只包含六个运行时 extension 和 `bash-readable` 的内部 helper；`test/`、`scripts/` 和文档不在 `pi.extensions` 的资源范围内。初始版本不发布 npm、不添加第三方 runtime dependency、不创建 sibling package，也不提供会安装其他 package 的 `/setup` 命令。
