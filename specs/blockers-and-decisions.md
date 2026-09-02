# 阻塞点与待决策

审计完成后浮现的、会改变计划的事实。按严重程度排序。

## B1（严重）远程工作区**必须**改动 DSH 自身的 `packages/workspace`

审计结论：`packages/workspace` 与 `packages/host/directory-picker*` **完全不使用 `ctx.fs`**，
全部直接 `node:fs` / `node:os` / `node:path`。`ctx.fs` 在这两个区域只被提到一次，而且是说
"picker 有意与 `ctx.fs` 分离"（`directory-picker/README.md:66`）。

关键绑定点：

| # | 位置 | 代码 | 后果 |
|---|---|---|---|
| 1 | `workspace/src/paths.ts:21` | `return await realpath(path)` | 包内自称"唯一的唯一性正典"（`paths.ts:10-12`），且是**唯一的 realpath 调用集**入口 |
| 2 | `workspace/src/index.ts:159-161` | `realpathNormalize(path)` + `stat(canonical).isDirectory()` | `create()` 只接受本机可解析目录 |
| 3 | `workspace/src/entity.ts:124,132` | 同上 | 会话 attach 时校验 cwd |
| 4 | `workspace/src/entity.ts:182` | `stat(this.record.path).isDirectory()` | 远程工作区**永久报 `missing-dir`** |
| 5 | `workspace/src/index.ts:580-581` | 启动时对**每个**持久化会话 header 做本地 realpath+stat | 远端 cwd 全部落入 `invalidSessionPaths` |
| 6 | `workspace/src/spec.ts:23` | `path: z.string()`，无 locality 判别字段 | 两台机器的 `/home/dev/proj` 是**同一个**工作区，且会在启动校验里被当成记录损坏（`index.ts:532-539`） |

在 Windows 本机上对 `/home/dev/proj` 调 `workspace.create()` 的实际结果：
`realpath` 把无盘符路径重定位到当前盘 → ENOENT 直接 reject。
**更糟的情况**：若本机恰好存在 `C:\home\dev\proj`，则**静默创建到错误目录**（包内无 `isAbsolute` 校验）。

### 三条出路

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 小改上游（推荐）** | 给 `workspaceRecord` 加可选 `target` 字段（沿用 `spec.ts:55` 已有的 `.default()` 加法迁移模式）、`spec.ts:70` 版本号 +1；把 `realpathNormalize`（`paths.ts:21`）与 3 处 `stat`（`index.ts:160`、`entity.ts:132`、`entity.ts:182`）改为经可注入的 seam 分派 | 约 50–80 行改动，落在 DSH checkout 内（在我的写沙箱之外，每次写需批准）。是唯一干净解 |
| B. 分叉 `workspaceRegistry` | 自己写一个 provider 顶掉 host 面那行 | 要复刻 ~600 行并跟随上游演进；Web 客户端经 typert API 与之对话，接口要完全兼容。不划算 |
| C. 本地占位目录 | 工作区指向本地占位目录（如 `C:\dsh-remote\hostA\home\dev\proj`）骗过校验，realm 内 `fs-ssh`/`bash-local` 的 cwd 指真远端路径 | 纯 out-of-tree，零上游改动；但工作区路径与工具显示路径不一致，会话 cwd 与工作区归属的比较逻辑（`entity.ts:138`）需要小心对齐。可作为 P3 的过渡验证手段 |

**待你决策**：走 A（我需要对 checkout 的写权限批准）还是先用 C 打通链路再决定。

## B2（中）PTY 子面不可拒绝，helper 的能力下限被抬高

原以为 `spawnTerminal` 可以先不实现 —— 错。它是无条件 `abstract`（`subprocess/src/index.ts:139`），
且 seam 明确说这是"唯一的非管道进程原语"。因此 helper 从"最好有"变成**必需**，
且必须能做 `tcgetpgrp` 与 `/proc/<pid>/wchan` 级别的前台组探测（见 `specs/ctx-subprocess-contract.md` §3）。

影响：`dsh-subprocess-ssh` 的工作量按 `subprocess-e2b` 的 1835 src 行量级估算，不能砍 PTY 来省。

## B3（中）没有共享一致性测试套件可用

两个 seam 都只有自测 spec，不导出可复用入口（详见 subprocess 规范 §6）。
⇒ 验收标准改为"自写 provider 一致性测试 + 对照 local/e2b 行为逐条核对"，
可仿 `packages/storage/storage/tests/contract.ts` 的 `runKvBackendContract(label, create)` 形态。

## B4（中）本机开发环境限制：`node.exe` 直调被沙箱拒绝

`& "C:\Program Files\nodejs\node.exe" ...` → `Access is denied` +
`[sandbox: file access denied under workspace-write mode]`。
`node -v` / `npm -v` 经 PATH 调用可以工作。需要确认 `npm install` 能否在当前策略下完成
（`ssh2` 依赖、TypeScript 构建都依赖它）。若不能，实现阶段需要一次提权批准。

## B5（低）ripgrep argv0 转译

`tool-fs-search` 直接 spawn 本地打包的 `@vscode/ripgrep`（`search-core.ts:172-178,234`），
`rgPath` 不可配置，README 已把这列为已知限制（`tool-fs-search/README.md:215`）。
对策见 `DESIGN.md` §4.1（远端预置 + argv0 转译）。

## B6（低）spill 世界一致性

`SubprocessCollect.spill` 与 `glob/grep` 的溢出 spill 都必须写在**远端**，
否则 `spillPath` 在模型所处的执行世界里读不到（`subprocess/src/index.ts:81-83`）。
`spill-local` 是 host 面 `node:fs`（`spill-local/src/store.ts:10`），
所以 `tool-fs-search` 的溢出提示在远端 preset 下会指向本地文件 —— 已知限制，需在 preset 提示里说明。
