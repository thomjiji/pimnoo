# `rpiv-mono` 仓库结构调研

研究对象固定在 [`juicesharp/rpiv-mono@c6e15db`](https://github.com/juicesharp/rpiv-mono/tree/c6e15dbdf962185db574413f77cc50be43e65791)。

## 结论

`rpiv-mono` 值得作为发展方向参考，但不适合原样复制。它解决的是多个可发布 package、内部共享依赖、统一测试和统一发布的问题；当前仓库仍是七个无第三方依赖的私有扩展，直接搬入完整发布体系会增加维护成本。

`thomo` 已采用其中最重要的基础设计：根 package 既是私有 npm workspace，也是整体加载入口；每个 `packages/thomo-<name>/` 都有独立的 `package.json` 和测试边界。共享依赖和 release automation 仍应等到实际需求出现后再增加。

## `rpiv-mono` 的组织方式

- 根 `package.json` 是私有 npm workspace，统一管理 `packages/*`、开发依赖、检查、测试、版本和发布命令。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/package.json)
- `packages/` 同时包含公开 Pi package 和不发布的内部 package；每个公开 package 自带 manifest、README、文档、测试和发布元数据。[公开 package 示例](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/packages/rpiv-btw/package.json) [内部 package 列表](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/README.md#everything-else-in-the-workspace)
- `rpiv-pi` 是组合层，依赖或对接多个 sibling package，而不是让仓库根目录同时承担产品 package 的职责。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/packages/rpiv-pi/package.json)
- 测试与源码放在各 package 内，由根 Vitest 配置统一发现、并发执行和统计覆盖率。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/vitest.config.ts)
- CI 在多个 Node 版本上统一执行静态检查和测试，并上传覆盖率。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/.github/workflows/ci.yml)
- README 被定义为入口而不是手册；完整参考资料放进 `docs/`。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/docs/readme-standard.md)
- 所有公开 package 采用 lockstep version，并通过脚本同步版本、更新 changelog、打 tag 和发布。[来源](https://github.com/juicesharp/rpiv-mono/blob/c6e15dbdf962185db574413f77cc50be43e65791/scripts/release.mjs)

## 借鉴范围

1. README 只负责介绍、安装和入口，扩展参考资料放入 `docs/` 或 package 自己的 `docs/`。
2. 每个扩展都是独立 package 边界：源码、测试、fixture、manifest 和专属文档放在一起。
3. 根仓库提供统一的 test、typecheck 和 smoke test 入口；后续再补 GitHub Actions。
4. 只有出现稳定共享代码时才建立内部 package，不增加无边界的 `shared/` 目录。
5. 根 manifest 使用 Pi 支持的 glob 加载 `./packages/*/index.ts`。Pi package manifest 的资源数组支持 glob。[Pi package 文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#creating-a-pi-package)

## 暂时不应照搬

- 暂不需要发布流水线、lockstep version、每个扩展的 changelog 和 npm 元数据；当前 package 全部是 `private`。
- 暂不需要 Vitest、覆盖率门槛、共享 test-utils 和多 Node 版本矩阵；现有 Node test suite 已覆盖当前规模。
- 暂不需要站点、封面图、badge 分支或 `.rpiv/guidance` 这类配套系统。
- 不应仅为了看起来像 monorepo 而拆出内部 package；只有稳定复用关系出现后才建立依赖边界。

## 采用状态

- [x] 根 README 精简为入口，复杂扩展使用独立文档。
- [x] 仓库和 package family 统一命名为 `thomo`。
- [x] 扩展迁移到 `packages/thomo-<name>/`，根 package 保持 Git 安装的 umbrella。
- [x] 根目录声明私有 npm workspace，并统一 unit test、typecheck 和 smoke test。
- [ ] 增加最小 GitHub Actions CI。
- [ ] 出现共享代码时抽出 `packages/thomo-config`、`packages/thomo-test-utils` 等有明确调用者的内部 package。
- [ ] 只有出现独立安装和版本需求后，增加公开 npm package、changelog 和 release automation。

## 名称

`thomo` 简短、容易形成个人 package 家族，例如 `thomo-auto-title` 和 `thomo-delegate`；但名称本身不能说明它与 Pi 有关，需要依靠仓库描述和 README。检查时 `thomjiji/thomo` GitHub 仓库和 npm 上未发现同名项目。

仓库采用 `thomo`，package family 使用 `thomo-<name>`。仓库描述和 README 负责说明它与 Pi 的关系。
