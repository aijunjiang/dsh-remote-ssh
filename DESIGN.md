# DSH 远程工作区（SSH）— 设计

> 状态：设计中（round 1）。本文只写**已用代码证据确认**的结论；未确认的条目标注 `⏳待审计`。
> 所有 `path:line` 引用相对 DSH checkout：`C:\Users\Administrator\Documents\deepseek-harness`。

## 1. 目标

| 维度 | 要求 |
|---|---|
| 会话记录 | **全部留在本地** `$DSH_HOME`（sessions / storages / settings / credentials） |
| GUI | 本地 `dsh web`，本地浏览器 |
| 工作区文件读写 | 远端（`read` / `write` / `edit` / `glob` / `grep` 作用于远端路径） |
| 命令执行 | 远端（`bash`、git、测试、构建、LSP） |
| 多远端 | **同一个 dsh 进程内并存多个远端环境**，按工作区/环境切换 |
| 远端形态 | Linux；SSH 首次账密，之后自动改密钥认证；允许常驻 helper |

非目标（本期）：Windows 远端；远端 GUI 转发；把会话记录放远端。

## 2. 决定性架构发现

### 2.1 `ctx.fs` / `ctx.subprocess` 默认是 host 面单例

| row id | plugin | 面 | 证据 |
|---|---|---|---|
| `fs-sandbox` | `dsh-fs-sandbox`（唯一已交付的 `ctx.fs` provider） | host | `packages/bundle/base/cordis.patch.yml:493` |
| `subprocess` | `dsh-subprocess-local` | host | `packages/bundle/base/cordis.patch.yml:205` |
| `sandbox` / `sandbox-policy` | `dsh-sandbox-local` / `dsh-sandbox-policy` | host | `:211` / `:214` |
| `bash-sandbox` / `pwsh-sandbox`（`ctx.shell`） | | host | `:220` / `:226` |

而这个 provider 是**本地实现**，不是抽象壳：

```
packages/fs/fs-sandbox/src/index.ts:55
  export class SandboxedFileSystem extends LocalFileSystem
packages/fs/fs-sandbox/src/containment.ts:9
  import { stat } from 'node:fs/promises'
```

结论：用户"工作区强制在本机"的判断成立，且是 provider 层面的硬绑定。

### 2.2 但 preset 可以用 `isolate` realm 覆盖 host provider —— 这是多远端并存的承载机制

已交付的 `minimal` preset **已经在这么做**：

```
packages/preset/agent-presets/presets/minimal/agent.cordis.yml:72
  # The bare local filesystem shadows the host's sandboxed provider only for this preset.
  :77-78   isolate: { fs: true }
  :80-83   - id: fs-local ...
```

Cordis 的服务解析是**按上下文树词法作用域**的（`docs/cordis-api/context.md:43-52`：
"Below the returned context, reads and writes of the service `name` resolve against the new label instead of the parent's"），
且跨 group 不互相影响（`docs/user/develop/framework/service.md:139`："with no cross-group effect"）。

于是：**一个远端 = 一个 agent preset**，preset 内部用 `isolate` realm 挂自己的 `fs` + `subprocess` + shell + 工具。
同一进程内 `remote-a` / `remote-b` / 本地 `standard` 三个 preset 并存，会话创建时选哪个 preset 就落在哪个世界。

### 2.3 粒度的真相：per-preset，不是 per-session

```
packages/preset/agent-presets/README.md:97
  One standing composition per preset. A preset is mounted once per process
  under a standing scope; agents join by parenting their scope key to the mount
```

含义：
- 同一 preset 的多个并发会话**共享**同一份 provider 实例（同一条 SSH 连接、同一个远端 cwd）——对我们无害，正是想要的连接复用。
- "按工作区切换远端"在实现上落地为**按 preset 切换远端**；工作区路径填远端绝对路径。
- 绑定在会话创建时固定（空会话可重新 link：`docs/subsystems/core.md:577-594`）。

### 2.4 realm 必须罩住 provider 和它的所有消费者

```
packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md:82
  wrap the provider and every consumer that reaches it in one group carrying an isolate realm
SKILL.md:101
  A consumer left outside the group resolves the host's registry, which the preset
  did not populate, and then contributes nothing
SKILL.md:78
  A row that publishes a service may not sit loose in a preset. ... The mount rejects it.
```

所以远端 preset 的 group 内必须同时包含：`fs-ssh`、`subprocess-ssh`、`ctx.shell` 执行器（`bash-local`）、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、`tool-bash`，以及（可选）`terminal-*`、`lsp-*`。

> ⚠️ `ctx.subprocess` 在任何已交付 composition 里**从未**被 preset 挂载过（host `bash-sandbox` 硬取 host subprocess）。
> 我们是第一个这么做的，必须自己验证 realm 内 `subprocess` + `bash-local` 组合能通过 mount 审计。

### 2.5 会话记录天然留本地 —— 无需额外工作

这些 row 都在 host 面且**直接用 `node:fs`，不走 `ctx.fs`**，因此 provider 换成远端也不会把它们带走：

| 关注点 | row | 证据 |
|---|---|---|
| 会话日志 | `session-persistence-jsonl` | `packages/session/session-persistence-jsonl/src/index.ts:11`（`node:fs`） |
| 附件 | `attachment-local` | `packages/attachment/attachment-local/src/store.ts:4` |
| spill | `spill-local` | `packages/spill/spill-local/src/store.ts:10` |

这正是需求里"记录统一管理"的免费实现。

### 2.6 修正：路由式 provider 取代"一个远端一个 preset"

读完 `Hefulalala/dsh-remote-workspace`（逐条对照见 `specs/reference-plugin-comparison.md`）后，
2.2–2.4 的结论要改。它的**锚点目录**手法给出了一个更好的载体：

每个远端工作区在本地有一个锚点目录 `$DSH_HOME/remote-workspaces/<workspaceId>/`，
注册进 `workspaceRegistry` 后，会话的 `cwd` 就是该锚点路径。于是存在一个可靠的映射：

```
session.cwd（本地锚点绝对路径） → workspaceId → siteId + remoteRoot
```

因此 `ctx.fs` / `ctx.subprocess` 不必按 preset 分身，各挂**一个路由 provider** 即可：

| 入参 | 判定 | 去向 |
|---|---|---|
| 路径落在某个锚点目录下 | 查表得 (site, remoteRoot) | 该站点的 SSH/helper |
| 其它路径 | — | 委派本地实现（`LocalFileSystem` / `subprocess-local`） |

逐条对上最初的要求：

- **"我希望是会话级的，通过工作区切换不同远端环境开发"** —— 路由粒度天然按路径/按工作区，
  也就是按会话，不再受 2.3 那条"一个 preset 每进程只挂一次"的限制。
- **多远端同时开发** —— 一个进程内任意多站点并存，切工作区即切远端，无需为每个远端造 preset。
- **不需要 `isolate` realm** —— 2.4 的"realm 必须罩住 provider 和所有消费者"整块复杂度消失，
  连 2.2 结尾那条"`ctx.subprocess` 从未被 preset 挂载过"的风险也一并消失。

代价：

1. **一个 provider 跨两个执行世界。** `processPath` 的契约是"backend 执行世界内的绝对路径"，
   路由 provider 返回的世界取决于入参。必须保证 `ctx.fs` 与 `ctx.subprocess`
   **共用同一张表、同一套前缀匹配**，否则会出现"文件在远端、命令在本地"的错位 ——
   这是 one-world 不变量在路由形态下的新写法。
2. **sandbox 围栏**：`sandbox-policy.workspaceRoot` 是单值，无法同时描述本地锚点与远端根。
   远端分支不参与 `ctx.sandbox`（同 4.2 结论），本地分支保持原围栏。
3. **spill / 附件路径分裂**（4.3）在远端分支依旧存在，限制不变。

### 2.7 采用的最终形态

在 `Hefulalala/dsh-remote-workspace` 之上补执行层：复用它的站点表、锚点目录、SFTP 连接池与 GUI，
新增 `dsh-ssh` 的 helper 控制通道（SFTP 表达不了的那部分）与两个路由 provider。
B1（上游 `packages/workspace` 只认本机目录）由锚点目录绕开，**不再需要改上游**。

## 3. 包划分（out-of-tree，`--patch` 加载）

DSH 支持本地插件包直接 overlay：`pnpm dsh web --patch ./scratch-plugin/cordis.yml`
（`docs/user/develop/basic/tool.md:43`），发布形态是 `dsh plugin add` + `link:`（`publish.md:90`）。
因此**不改 DSH 源码**。

```
dsh-remote-ssh/
├── packages/
│   ├── ssh/              # dsh-ssh          → ctx.ssh   连接/认证/helper/远端 cwd 的唯一 owner
│   ├── fs-ssh/           # dsh-fs-ssh       → ctx.fs     provider
│   └── subprocess-ssh/   # dsh-subprocess-ssh → ctx.subprocess provider
├── presets/
│   └── remote.agent.cordis.yml   # 每个远端一份（isolate realm 模板）
└── remote-ssh.patch.yml          # 把 preset 注册进 roster
```

对齐 E2B 的三包结构（owner + 两个 provider），它是唯一已交付的远程先例：
`packages/e2b/e2b`（190 src 行）、`fs-e2b`（569）、`subprocess-e2b`（1722）。

### 3.1 `dsh-ssh`（`ctx.ssh`）职责

1. **连接**：`ssh2` 单连接多 channel（sftp + exec + pty 共用），keepalive、断线重连。
2. **认证阶梯**（模仿 Remote-SSH 的体验）：
   - 首次：账密（`password` / `keyboard-interactive`）；
   - 随后自动生成 ed25519 密钥 → 追加到远端 `~/.ssh/authorized_keys` → 之后只用密钥；
   - 私钥存 `$DSH_HOME`，权限 0600。
3. **helper 部署与保活**：上传/校验 helper 脚本到 `~/.dsh-remote/`，按内容哈希决定是否重传；进程死掉自动重起。
4. **远端 cwd 归属**：与 E2B 的 one-world 不变量对齐（`packages/e2b/e2b/tests/fixtures/composition/cordis.yml:1-3`
   "e2b.cwd and sandbox-policy.workspaceRoot must name the same remote directory"）。
5. **staged binaries 目录**：解决 ripgrep 问题（见 4.1）。

### 3.2 helper 形态决策

需要 helper 的理由：进程组记账、kill 升级、退出码/信号上报、PTY 前台进程探测、批量 stat。

- 首选：**Python3 常驻守护**（Linux 近乎必备），单条 exec channel 上跑换行分隔 JSON 协议。
- 不要求远端装 Node（DSH 要 `^22.19 || >=24`，远端不一定有；VS Code Server 自带的 node 通常也不达标）。
- 无 helper 降级模式：纯 `ssh exec` + `setsid`，能跑但 kill 升级粗糙、无 PTY 前台探测。

## 4. 已知阻塞点与对策

### 4.1 `glob` / `grep` 会 spawn**本地**打包的 ripgrep

```
packages/fs/tool-fs-search/src/search-core.ts:172-178   # 解析 @vscode/ripgrep 的 rgPath
packages/fs/tool-fs-search/src/search-core.ts:234       # ctx.subprocess.spawn(...)
packages/fs/tool-fs-search/README.md:215
  Remote or virtual filesystems need a co-located workspace or another search consumer.
```

`rgPath` 不可配置，且在远端不存在（还是个 Windows exe）。对策，按优先级：

1. **argv0 转译 + 远端预置**：`dsh-ssh` 在 `~/.dsh-remote/bin/` 放一份 linux-x64 的 `rg`；
   `subprocess-ssh` 发现 argv[0] 指向本地 `@vscode/ripgrep` 时改写为远端路径。契约内可控，无需改 DSH。
2. 若远端自带 `rg`，直接用之（版本探测）。
3. 兜底：realm 内不挂 `tool-fs-search`，改用远端 `grep`/`find`（能力退化，最后手段）。

### 4.2 sandbox 围栏在跨机后失效（必须显式承认）

```
docs/subsystems/sandbox.md:5
  wraps a same-world subprocess argv ... Containers, microVMs, and remote execution
  are sibling implementations of whole capability seams, not providers of ctx.sandbox
```

realm 内配置必须：`sandbox-policy.mode: danger-full-access` + `sandbox` 不参与 + 用 `bash-local`
（E2B fixture 就是这么做的：`packages/e2b/e2b/tests/fixtures/composition/cordis.yml:13,30`）。
后果：**远端等于全权限**。补偿手段（部署侧，非代码）：远端用专用账号 + 目录权限；
或后续在 helper 侧包一层 bwrap（远端同世界，`ctx.sandbox` 的 Linux 后端语义可复用）。

同时注意：`fs-sandbox` 的围栏 root 来自 `sandbox-policy.workspaceRoot`，默认 `process.cwd()`
（`packages/bundle/base/cordis.patch.yml:218`），对远端路径永不匹配 —— 要么全拒要么形同虚设，
所以 realm 内不能沿用 `fs-sandbox`。

### 4.3 spill / attachment 的路径分裂

`glob`/`grep` 超限时把完整结果写到**本地** spill 文件，而里面的路径指向远端文件 → 模型拿到的
`retrievalHint` 用自己的 `read` 读不到。本期作为已知限制记录；缓解：给远端 preset 调小
`sampleOverCapGlobResults` 相关阈值，或在提示里说明。

### 4.4 跨平台路径

本地 Windows + 远端 POSIX：`fs-ssh` 必须始终用 POSIX 语义解析（不能用 `node:path` 的 win32 分支），
且对模型只呈现远端绝对路径。`fs-e2b` 已有同类处理，实现时对照。

## 5. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| P0 | `dsh-ssh` 连接+认证阶梯+helper 部署 | 能对远端跑一条命令并拿到退出码 |
| P1 | `subprocess-ssh` 通过 `ctx.subprocess` 契约（含 collect/kill 升级） | 自写一致性测试绿 + 对照 `local`/`e2b` 逐条核对 |
| P2 | `fs-ssh` 通过 `ctx.fs` 契约 | 同上 |
| P3 | 路由接线：锚点路径 → 站点表 → 远端分支；rg 预置 | GUI 里选一个远端工作区建会话，`read`/`edit`/`bash`/git 全落远端，记录在本地 |
| P4 | 多远端并存 + 断线重连（复用参考实现的连接池策略） | 两个远端工作区在同一进程内交替使用，互不干扰 |

## 6. 审计结论（round 1 已完成）

四份契约审计已落盘，实现时以它们为准：

| 文档 | 内容 |
|---|---|
| `specs/ctx-fs-contract.md` | `ctx.fs` 13 个成员的签名/强制性、13 个错误码的触发条件、必须保留的语义清单、`fs-e2b` 的实现手法、SFTP 映射与 4 个"SFTP 做不到"的硬点 |
| `specs/ctx-subprocess-contract.md` | `ctx.subprocess` 3 个抽象成员、spawn spec 逐字段的 SSH 职责、collect 读取器语义、7 项"必须有 helper"的契约、退出事实映射 |
| `specs/blockers-and-decisions.md` | B1–B6 阻塞点与待决策 |

**三条推翻原计划的结论：**

1. **`spawnTerminal` 不可拒绝**（`packages/subprocess/subprocess/src/index.ts:139` 是无条件 `abstract`）。
   §3.2 里"helper 是首选"要升级为"helper 是必需"，且必须做到 `tcgetpgrp` + `/proc/<pid>/wchan` 级别的
   前台组探测。工作量按 `subprocess-e2b` 的 1835 src 行量级估。
2. **不存在共享 conformance 套件**。两个 seam 的 `tests/service.spec.ts` 都只是自测、不导出入口，
   `fs-e2b`/`subprocess-e2b` 各自手写 fake 打桩。⇒ §5 的 P1/P2 验收标准改为"自写 provider 一致性测试
   + 对照 `local`/`e2b` 行为逐条核对"，可仿 `packages/storage/storage/tests/contract.ts` 的
   `runKvBackendContract(label, create)` 形态。
3. **`packages/workspace` 完全不用 `ctx.fs`**，全是直接 `node:fs`。所以即便挂上远端 `ctx.fs`，
   工作区注册表也**看不见**它。原本这需要小改上游（`specs/blockers-and-decisions.md` B1 的方案 A），
   现已由**锚点目录**（2.6）绕开：注册进 `workspaceRegistry` 的是本地锚点，远端根只存在于站点表里。
   参考实现已在真实环境验证这条路可行（`.reference/src/index.ts:1198-1202`）。⇒ **B1 关闭，不改上游。**

## 7. 本机环境约束

- npm CLI 不可用（`npm -v` 之外的子命令全部失败），但 registry HTTPS 通。
  依赖用 `scripts/fetch-deps.mjs`（固定版本 + tarball 直取 + 内置 bsdtar 解包）安装。
- `node.exe` 用绝对路径直调会被文件沙箱拒绝；经 PATH 调用正常。
