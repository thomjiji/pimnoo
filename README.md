# thomo

`thomo` 是一组我根据个人使用习惯编写的 Pi 插件，用于修改或增强 Pi 的行为。

仓库可以作为 umbrella package 整体安装；每个 `packages/thomo-<name>/` 目录也可以独立加载。

## 插件

| 插件 | 用途 |
| --- | --- |
| [`thomo-auto-title`](docs/auto-title.md) | 给每个 session 自动生成一个英文短标题 |
| [`thomo-bash-readable`](packages/thomo-bash-readable/) | 调整 Bash 工具的显示格式 |
| [`thomo-block-style`](packages/thomo-block-style/) | 为语义背景块增加可切换的样式 |
| [`thomo-export-md`](packages/thomo-export-md/) | 通过 `/export-md` 导出对话 Markdown |
| [`thomo-no-italic`](packages/thomo-no-italic/) | 禁用 TUI 的 italic 样式 |
| [`thomo-reply-anchor`](packages/thomo-reply-anchor/) | 在 agent 回复开头添加可搜索的 `§` 锚点 |

`thomo-delegate` 已停用，不会随 umbrella package 或独立 package 加载；相关源码和文档仅保留作历史参考。

## 安装

```bash
pi install git:github.com/thomjiji/thomo
pi list
```

以上命令安装到用户级 settings。仅在当前项目中使用时加 `-l`：

```bash
pi install -l git:github.com/thomjiji/thomo
```

Git source 会安装整个仓库。只加载一个插件时，使用本地 checkout：

```bash
pi install /path/to/thomo/packages/thomo-auto-title
```

Pi 插件拥有 Pi 进程的系统权限，安装前请审查源码。

## 更新和回滚

```bash
pi update --extensions
```

需要临时固定版本时，安装指定 commit：

```bash
pi install git:github.com/thomjiji/thomo@<commit>
```

## 开发

直接加载 checkout，修改后在 Pi 中运行 `/reload`：

```bash
pi install /path/to/thomo
```

开发单个插件时可以只加载对应 package，但不要同时从 umbrella package 和 checkout 加载同一插件，否则会重复注册。

每个 package 的 `package.json` 只加载 `index.ts`。package 自己的测试和 fixture 放在对应目录；根目录的 `test/` 只放 umbrella package 和跨 package 测试。

## 测试

```bash
npm run test:unit
npm run typecheck
PI_BIN=/path/to/pi npm test
```

完整测试包含单元测试和 package smoke test；smoke test 使用临时 Pi agent directory，不读取用户 settings。

## 清理旧副本

如果插件曾放在 `~/.pi/agent/extensions/`，先预览再停用旧副本，避免重复加载：

```bash
node scripts/disable-legacy-extensions.mjs --dry-run
node scripts/disable-legacy-extensions.mjs
pi list
```
