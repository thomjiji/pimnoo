# whimsical 许可与安装方式调研

## 结论

上游 `mitsuhiko/agent-stuff` 仓库使用 Apache License 2.0。这个许可证允许复制、修改和再分发，因此把 `whimsical.ts` 放进 `pimono` 在许可上是可行的，但不能把该第三方文件无条件地当作 `pimono` 的 MIT 代码处理。

当前仓库已经保留了 README 来源说明，但复制进来的文件没有附带 Apache-2.0 许可证副本，也没有在被修改的文件中明确标注修改；如果要把当前仓库作为可再分发包，建议先补齐第三方许可说明。本文不是法律意见。

如果不需要修改插件，直接从上游安装通常更干净；但必须使用 Pi 的 package filter 只加载 `whimsical.ts`，否则会同时加载上游 package 声明的其他 extensions、skills、prompts 和 themes。

## 一手来源

- 上游源码：[extensions/whimsical.ts](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/whimsical.ts)。
- 上游许可证：[LICENSE](https://github.com/mitsuhiko/agent-stuff/blob/main/LICENSE)。
- 上游 package manifest：[package.json](https://github.com/mitsuhiko/agent-stuff/blob/main/package.json)。其中 `pi.extensions` 声明了 `./extensions/*.ts`，同时还声明了 `./skills`、`./themes` 和 `./commands`。
- Apache 官方许可证：[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)。
- Pi 官方 package 文档：[Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。
- Pi 官方扩展文档：[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。

## Apache-2.0 对复制集成的要求

Apache-2.0 第 2 条授予复制、准备衍生作品、公开展示、再许可和分发的版权许可；第 3 条还提供了相应的专利许可，但专利诉讼会触发许可证中的终止条件。

Apache-2.0 第 4 条允许以源代码或目标代码形式分发原作品和衍生作品，但要求向接收者提供许可证副本，要求被修改的文件带有醒目的修改说明，并要求保留源代码中的相关版权、专利、商标和归属声明。如果原作品带有 `NOTICE` 文件，还必须保留其中适用的归属内容。

`pimono` 的 `package.json` 当前声明整个 package 的默认许可证为 MIT；这可以和第三方 Apache-2.0 文件共存，但应明确 MIT 只覆盖 `pimono` 自己的代码，`extensions/whimsical/index.ts` 是 Apache-2.0 的第三方衍生文件。建议添加 `LICENSES/Apache-2.0.txt` 或等价的第三方许可文件，并在 `whimsical` 入口顶部写明上游地址、Apache-2.0 和本地修改内容。

本次集成即使保留英文文案，也已经把单文件移动到新的 package 入口并增加了导出测试 seam，因此应视为修改过的文件，不能省略修改说明。

## 直接从上游安装

Pi 官方文档支持从 Git source 安装 package：

```bash
pi install git:github.com/mitsuhiko/agent-stuff
```

如果使用普通字符串形式，这会按上游 manifest 加载整个 package 的资源范围，不只是 `whimsical.ts`。只加载该插件时，应在 `settings.json` 使用 object form：

```json
{
  "packages": [
    {
      "source": "git:github.com/mitsuhiko/agent-stuff",
      "extensions": ["extensions/whimsical.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Pi 的 filter 路径相对于 package 根目录；省略某个资源类型会加载该类型的全部 manifest 内容，空数组表示不加载该类型。为了可复现，生产使用可以把 Git source 固定到 commit 或 tag，例如 `git:github.com/mitsuhiko/agent-stuff@<commit>`。

如果同时保留 `pimono` 中的副本和上游 package，必须确保其中一个来源排除 `whimsical`，否则两个入口都会注册 `turn_start` 和 `turn_end`，导致重复加载。当前选择性 plug 的思路是正确的：从一个 package 过滤掉该扩展，再从另一个 source 加载它。

`pi -e git:github.com/mitsuhiko/agent-stuff` 适合一次性试用，但仍应按 package 资源范围审查其内容；它不是只加载单个 `whimsical.ts` 的等价写法。若只想临时加载一个文件，应先取得源码，再用 `pi -e /path/to/whimsical.ts`。

## 两种方案比较

| 方案 | 许可处理 | 维护成本 | 推荐度 |
| --- | --- | --- | --- |
| 复制到 `pimono` | 需要在仓库中保留 Apache-2.0 副本、归属和修改说明；MIT 与 Apache-2.0 需分层说明 | 需要自己跟踪上游更新 | 需要修改或希望 umbrella package 单一入口时采用 |
| 直接从上游 filtered install | 不把上游源码再分发到自己的仓库，Pi 直接管理其 Apache-2.0 package | 跟随上游，需审查更新；应固定 ref 以获得可复现性 | 不需要修改时更推荐 |

## 建议

如果只是想使用原版英文 `whimsical`，建议把它从 `pimono` 中排除，直接安装上游 package，并在 `settings.json` 只允许 `extensions/whimsical.ts`。如果希望所有个人扩展都由 `pimono` 统一锁定和发布，可以继续保留当前集成，但应补充 Apache-2.0 文本、归属说明和修改标记。

无论采用哪种方式，都应审查实际要执行的 commit；Pi 官方文档明确提醒 package extensions 具有完整系统权限，第三方 package 不是仅包含静态文本。
