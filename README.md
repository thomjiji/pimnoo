# pimono

`pimono` 是一个由 Git 跟踪的个人 Pi umbrella package。根 package 方便一次安装和更新全部扩展；每个 `extensions/<name>/` 目录同时是一个自包含的 Pi package 单元，因此也可以只安装其中一个，不依赖自动发现目录中的旧副本。

## 包含的扩展

| 扩展 | 入口 | 用途 |
| --- | --- | --- |
| `auto-title` | `extensions/auto-title/index.ts` | 为没有手动名称的 session 生成英文短标题 |
| `bash-readable` | `extensions/bash-readable/index.ts` | 只改变 Bash 工具的显示格式，不改变执行行为 |
| `block-style` | `extensions/block-style/index.ts` | 为语义背景块增加可切换的样式 |
| `delegate` | `extensions/delegate/index.ts` | 在独立 Git worktree 中启动 headless Pi RPC worker |
| `export-md` | `extensions/export-md/index.ts` | 通过 `/export-md` 导出只包含提示和回复的 Markdown |
| `no-italic` | `extensions/no-italic/index.ts` | 禁用 TUI 的 italic 显示样式 |
| `reply-anchor` | `extensions/reply-anchor/index.ts` | 在 agent 回复开头添加可搜索的 `§` 锚点 |

每个扩展目录都有自己的最小 `package.json`，通过 `pi.extensions` 明确只加载 `./index.ts`；目录里的 helper、extension-specific test 和 fixture（例如 `bash-readable/format.ts` 和 `auto-title/auto-title.test.ts`）都是该扩展的内部源码，不会被当成独立 extension 加载。根目录的 `package.json` 通过 `pi.extensions` 声明 `./extensions`，所以安装根 package 时仍然会加载全部这些自包含单元。

## Delegate worker

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

如果只想使用一个扩展，可以直接安装它的目录。下面的例子只加载 `auto-title`，不会加载 `export-md`、`delegate` 或其他扩展：

```bash
pi install /path/to/pimono/extensions/auto-title
```

远程 Git source 的安装粒度是整个仓库；如果不想让其他扩展被加载，可以在 settings 中把 package 写成对象并筛选资源，例如 `{"source": "git:github.com/<account>/pimono", "extensions": ["extensions/auto-title/**"]}`。如果连仓库 checkout 都不想保留，就需要单独的 npm package 或单独的 Git 仓库；当前不为此给每个小扩展增加发布流水线。

如果只想在一个项目中使用根 package，可以使用 project scope：

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

只开发或验证单个组件时，直接挂载它自己的目录即可：

```bash
pi install /path/to/pimono/extensions/auto-title
```

如果同时保留了 umbrella package，则不要再从该 umbrella package 加载同一个组件；可以在 `~/.pi/agent/settings.json` 的 `packages` 里用对象形式排除它（例如 `{"source": "git:github.com/<account>/pimono", "extensions": ["!extensions/auto-title/**"]}`）。修改 settings 后 `/reload`，并确认每个扩展只加载一次——同一个组件从两个来源加载会重复注册。

Windows 主机可以在 settings 中使用主机路径，例如 `C:\Users\<name>\git\pimono`。如果 Pi 在 WSL、容器或其他 runtime 中运行，应把这个路径替换为该 runtime 能访问的对应路径；扩展代码不包含任何环境专用 loader path。

在 Pi 中修改扩展后运行 `/reload`。`/reload` 会重新加载 package 管理的 extensions；不需要复制文件或重启 Pi。开发期间也可以用一次性加载检查 package：

```bash
pi -e /path/to/pimono
```

## 真实 Pi 端到端验证

单元测试和 package smoke test 验证逻辑与加载边界；需要确认 TUI 视觉效果或真实 Pi 生命周期时，再把 checkout 中的目标扩展 plug 到正在使用的 settings。先备份 `~/.pi/agent/settings.json`，只挂载待验证的扩展目录，运行 `/reload` 或重启 Pi，实际操作对应命令或界面，然后恢复 settings；不要让 umbrella package 和 checkout 同时加载同一个扩展。

新扩展可以直接挂载：

```json
{
  "extensions": ["/path/to/pimono/extensions/<name>"]
}
```

如果扩展已经由 Git package 提供，则在 package 对象中排除 Git 版本，再挂载 checkout 版本：

```json
{
  "packages": [
    {
      "source": "git:github.com/<account>/pimono",
      "extensions": ["!extensions/<name>/**"]
    }
  ],
  "extensions": ["/path/to/pimono/extensions/<name>"]
}
```

验证完成前检查 `pi list`、命令或 tool 列表以及 Pi 报告的 source path，确认待测组件只有一个 active source。视觉验证是补充，不替代可重复的 unit、typecheck 和 smoke test。

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

1. 将源码放入 `extensions/<name>/`，把入口命名为 `index.ts`，并为该目录添加只声明 `./index.ts` 的最小 `package.json`。
2. 在根 `package.json` 的 `pi.extensions` 允许范围内确认入口可被发现；把 extension-specific test 和 fixture 放在该扩展目录中，并确认最小 manifest 仍然只加载 `./index.ts`。
3. 为可观察行为增加独立于 package 安装机制的测试，并用该目录的 local path 验证它可以单独加载；如果 extension 没有合适的纯函数 seam，至少让 smoke test 验证加载成功。
4. 更新上面的扩展清单和本节 checklist。
5. 检查旧全局副本、命令重复和不应加载的 helper。
6. 设置可信的 Pi CLI 路径并运行 `PI_BIN=/path/to/pi npm test`、`npm run typecheck` 和 `git diff --check`。
7. 在干净 agent directory 中运行 package smoke test，然后再提交默认分支。

当前采用两层边界：根目录是便于个人同步的 umbrella package，扩展目录是便于选择性安装的最小 Pi package；暂不把每个单文件扩展都发布成独立 npm package。对没有第三方依赖、没有独立版本节奏的 `auto-title` 这类扩展，npm 发布只会额外引入包名、版本和发布维护成本，不会改善 Pi 的运行方式。若以后需要远程用户用一条 npm 命令安装某个扩展，可以直接发布现有扩展目录，不需要再复制一套 monorepo package 结构。

## 测试

extension-specific unit test 与 fixture 和对应源码放在同一个 `extensions/<name>/` 目录；根 `test/` 只保留 umbrella package 的 manifest 测试和跨 package smoke test。单元测试不需要 live model、credential、npm publication 或用户现有的 Pi settings：

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

根 `package.json` 是 umbrella package 的聚合 manifest；每个 `extensions/<name>/package.json` 是只声明 `./index.ts` 的最小独立 Pi manifest。`extensions/` 包含七个运行时 extension、各自的 helper 以及 colocated test/fixture；根 `test/` 只包含 package boundary 测试和跨 package smoke test，二者都不在 `pi.extensions` 的资源范围内。当前不发布 npm、不添加第三方 runtime dependency，也不提供会安装其他 package 的 `/setup` 命令。
