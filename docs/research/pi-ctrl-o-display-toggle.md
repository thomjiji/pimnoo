# Pi Ctrl+O 多档显示切换可行性调研

## 调研结论

当前 Pi 0.84.2 的 `Ctrl+O` 不是可由扩展追加状态的状态机，而是绑定到 `app.tools.expand` 的全局二值开关 `toolOutputExpanded: boolean`。扩展可以正式接入工具渲染、读取或设置这个布尔值，也可以注册快捷键，但不能通过公开 API 直接把内置 `Ctrl+O` 改成三档或多档，并同时控制工具输出、编辑 diff 和 thinking。

如果只要求自定义工具或自定义消息的多档渲染，现有扩展 API 足够。如果要求用户描述的全局行为，最接近的扩展方案是先解绑内置 `app.tools.expand`，再注册一个 `ctrl+o` 扩展快捷键，并重写内置工具 renderer；但这需要维护状态、覆盖所有内置工具、处理历史组件重绘，并通过非正式方式刷新 thinking，属于可行的 workaround，不算干净的公共扩展 seam。

因此，当前结论是：局部可行，全局需求不建议直接实现为扩展 hack。若要长期稳定支持，应该由 Pi 核心提供多档 expansion mode 和对应的快捷键 action。

## 当前实现

Pi 的默认 keybinding 是 `app.tools.expand: ctrl+o`，官方文档将它描述为折叠或展开工具输出。主交互模式注册该 action 后，`toggleToolOutputExpansion()` 只执行 `setToolsExpanded(!this.toolOutputExpanded)`，所以核心状态只有 expanded 和 collapsed 两种。

`setToolsExpanded()` 会把同一个布尔值传给当前 header、loaded resources 和聊天容器中的可展开组件。它影响的不只是工具结果，也可能影响启动信息、summary、custom message、custom entry 等实现了 `setExpanded(boolean)` 的组件；普通 assistant thinking 使用另一套 `hideThinkingBlock` 状态和 `Ctrl+T`，不是同一条控制链。

编辑工具还有一个额外限制：内置 `edit` 的预览 diff 在 tool call renderer 中生成，和结果是否 expanded 不是同一个概念。因此仅调用 `setToolsExpanded(false)` 不能保证编辑 diff 被隐藏。

主要来源：

- [Pi keybindings 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md)：`app.tools.expand` 默认是 `ctrl+o`，`app.thinking.toggle` 默认是 `ctrl+t`。
- [interactive-mode.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts)：`toggleToolOutputExpansion()`、`setToolsExpanded()` 和 `toggleThinkingBlockVisibility()` 的调用链。
- 本机运行包 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:3351-3384`：当前安装版本的实际实现。

## 扩展 API 的能力和边界

### 工具 renderer 可以正式覆盖

Pi 支持扩展使用同名工具覆盖内置工具，并委托原工具的 `execute()`，只替换 `renderCall()` 和 `renderResult()`。官方提供的 `built-in-tool-renderer.ts` 示例明确演示了 read、bash、edit、write 的这种模式，并说明 `renderResult()` 会收到 `expanded` 标志。

官方还提供了 `minimal-mode.ts` 示例。它通过覆盖七个内置工具的 renderer，在 collapsed 状态只显示调用行或完全不显示结果，在 expanded 状态显示输出。这个示例证明“简化工具显示”本身是正式支持的，但示例仍然只使用内置的二值 expanded 状态，并没有真正实现 Ctrl+O 多档循环。

这条能力可以覆盖编辑 diff：扩展可以重写 `edit.renderCall()`，不渲染内置预览 diff，再决定 `renderResult()` 是否渲染结果。代价是需要覆盖 read、bash、edit、write、grep、find、ls 等所有希望统一行为的工具，并持续跟随内置工具参数和 renderer 变化。

主要来源：

- [Extensions 文档的 Custom Rendering](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#custom-rendering)。
- [built-in-tool-renderer.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts)。
- [minimal-mode.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/minimal-mode.ts)。
- 本机类型定义 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:308-376`：tool renderer 只有 `expanded: boolean` 和 `isPartial`。

### 快捷键不能直接抢占默认 Ctrl+O

`pi.registerShortcut("ctrl+o", ...)` 在默认配置下不会覆盖内置行为。Pi 的 `ExtensionRunner` 将 `app.tools.expand` 列入保留快捷键；当解析后的 keybinding 仍然包含 `ctrl+o` 时，扩展快捷键会被跳过并产生冲突诊断。

可以在 `~/.pi/agent/keybindings.json` 中将 `app.tools.expand` 设为 `[]` 或改到另一个键，再让扩展注册 `ctrl+o`。这属于配置允许的组合，不需要 monkey patch，但它已经放弃了内置 action，并且扩展必须自己重建原本的二值切换行为。`/tree` 使用独立的 `app.tree.filter.cycleForward`，默认也使用 `ctrl+o`，所以如果用全局 raw input listener 拦截按键，还会影响 tree 和其他 selector；只解绑主 editor action 则副作用较小。

主要来源：

- [Extensions 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)：`pi.registerShortcut()` 的公开接口。
- [runner.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/runner.ts)：保留 action 和 shortcut 冲突处理。
- [keybindings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md)：用户配置可以覆盖默认 binding。
- 本机实现 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:5-35,320-349`。

### Thinking 没有对应的扩展 setter

Pi 有持久化设置 `hideThinkingBlock`，内置 `Ctrl+T` 会调用核心私有的 `toggleThinkingBlockVisibility()`，重建聊天组件并更新 streaming 组件。`ExtensionUIContext` 公开了 `setHiddenThinkingLabel()`，但它只改变隐藏后的标签，不提供 `setHideThinkingBlock()` 或 `toggleThinkingBlockVisibility()`。

扩展可以使用 `registerMarkdownTransformer()` 观察 `messageType === "assistant-thinking"` 并返回替代 Markdown，也可以保存自己的显示档位。但 transformer 只负责显示文本转换，不会自动触发既有 assistant 组件重建，也不能直接改变核心的 `hideThinkingBlock`。为了让历史 thinking 立即刷新，扩展还需要借助主题重绘等间接手段，这比普通 renderer override 更脆弱。

主要来源：

- [Settings 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)：`hideThinkingBlock` 设置。
- [Extensions 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregistermarkdowntransformer)：Markdown transformer 的范围和限制。
- 本机实现 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:3371-3384`。
- 本机实现 `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js:80-145`。

## 方案评估

| 方案 | 可行性 | 评价 |
| --- | --- | --- |
| 只使用现有 `Ctrl+O` 和 `Ctrl+T` | 高 | 稳定，但只能得到两个互相独立的二值开关，不能实现一个键的多档循环。 |
| 覆盖内置 tool renderer | 高 | 官方支持，可以隐藏 edit diff、工具结果甚至工具调用；不能单独改变核心 Ctrl+O 的状态模型。 |
| 解绑 `app.tools.expand`，扩展注册 `ctrl+o` | 中 | 能接管主 editor 的按键，但扩展必须自行维护档位并模拟原生行为；默认保留冲突规则说明这不是直接覆盖 seam。 |
| `onTerminalInput()` 全局拦截 Ctrl+O | 中低 | 能拦截原始输入，但会影响 tree、selector、overlay 等焦点场景，容易引入路由问题。 |
| monkey patch 私有 `InteractiveMode`、扫描 chat children | 低 | 明显 hack，依赖私有字段和内部组件遍历，版本升级风险高。 |
| 修改 Pi 核心增加多档 mode | 高 | 最干净。需要把 boolean 提升为公开 expansion mode，并让内置组件、renderer 和快捷键 action 统一使用它。 |

## 推荐的产品级实现方向

如果这个需求要做成长期使用的 Pi 能力，建议在 Pi 核心中增加类似下面的公共 seam：

1. 将 `toolOutputExpanded: boolean` 提升为 `ToolOutputExpansionMode`，例如 `standard`、`expanded`、`minimal` 或 `conversation-only`。
2. 增加 `getToolOutputMode()`、`setToolOutputMode()` 和一个正式的 cycle action，例如 `app.tools.cycle`；默认 `Ctrl+O` 绑定这个 cycle action。
3. 将 tool、message、entry renderer 的 `expanded: boolean` 扩展为 `expansionMode`，同时保留 `expanded` 作为兼容派生值。
4. 让 edit diff、tool result、assistant thinking 的可见性分别由 mode 决定，并统一处理 streaming、历史消息、pending tool 和新建组件。
5. 明确这个显示档位是否只存在于当前 TUI，是否跨 `/reload`、`/resume` 和重启持久化。

如果暂时只想验证交互，不改 Pi 核心，可以先做一个实验性扩展：解绑 `app.tools.expand`，覆盖内置工具 renderer，使用另一个现有 API 能可靠触发的重绘路径验证工具侧的三档视觉效果；thinking 部分先固定使用 `hideThinkingBlock: true`，不要在第一版里用 transformer 模拟动态隐藏。

## 最终判断

“能不能方便地 modify Ctrl+O”分成两层：

- 只改工具显示：可以，官方的内置工具 renderer override 已经提供了足够的基础，`minimal-mode.ts` 是直接参考。
- 按用户描述让一个 Ctrl+O 在工具输出、代码 diff、thinking 之间循环，并对整个当前 transcript 生效：当前没有方便且完整的公共 API。解绑 keybinding 加扩展状态可以做出原型，但不应称为不 hacky 的正式方案；正式实现应补 Pi 核心的多档显示状态和 action seam。
