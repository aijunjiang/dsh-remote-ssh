# 对照：`Hefulalala/dsh-remote-workspace` 已实现什么、没实现什么

抓取时间：仓库 `pushed_at` = 2026-08-18，默认分支 `main`，19 个文件 / 137 KB。
本地副本在 `.reference/`（`src/index.ts` 1773 行、`src/client/index.tsx` 950 行）。
下面每条都有行号证据，引用相对 `.reference/`。

## 它的架构

`export const inject = ['webServer', 'tools', 'workspaceRegistry']`（`src/index.ts:65`）——
**host 面单插件 + 客户端 UI**，不碰任何能力 seam。

- 传输：纯 SFTP。`sftpRealpath` `:636`、`sftpStat` `:642`、`sftpMkdir` `:648`、`sftpList` `:654`、
  `sftpReadText` `:678`、`sftpWrite` `:691`、`sftpAppend` `:697`、`sftpWriteAt` `:704`。
- 连接管理：`SftpConnectionPool` `:483-545`，懒连接 / keepalive / 空闲 TTL / **自动重连** /
  每站点上限（并发尖峰退化为一次性连接）；读缓存按 `mtime + size`（`architecture.md:51-54`）。
- 侧边栏融合：`$DSH_HOME/remote-workspaces/<workspaceId>/` 作为**锚点目录**，
  写入 `AGENTS.md`，再 `workspaceRegistry.create(anchor, name)`（`:1198-1202`，`architecture.md:55-59`）。
- HTTP API `/remote-workspaces/api` + 14 个 agent 工具：`remote_site_*` 7 个（`:1557-1645`）、
  `remote_workspace_*` 7 个（`:1645-1754`）。
- 客户端：`sidebar.footer.action` 面板 + 以优先级 `-1` 影子注册
  `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`
  （`architecture.md:73-90`），卸载即恢复内置流程。
- 工程化齐全：`install.sh`、`tsdown`、CI、`SECURITY.md`、`CHANGELOG.md`、v1→v2 存储迁移。

## 逐条对照用户需求

| 需求 | 参考插件 | 证据 | 我的实现 |
|---|---|---|---|
| 会话记录留本地 | ✅ | 存储在 `$DSH_HOME/storages/remote-workspaces.json` | ✅ |
| 远端工作区出现在侧边栏、能拥有会话 | ✅ | 锚点目录 + `workspaceRegistry.create` `:1202` | ❌ 未做 |
| 站点管理 GUI（增/改/测/删）+ 远端目录浏览选根 | ✅ | `client/index.tsx` 950 行 | ❌ 未做 |
| 远端文件读写 | ✅ **但只经专用工具** | `remote_workspace_read/write/append/write_at` | ✅ 经 `ctx.fs` |
| 标准 `read`/`write`/`edit` 作用于远端 | ❌ | 无 `extends FileSystem`；`AGENTS.md` 明确写 "Do NOT expect project files in this local anchor directory"（`:352-353`） | ✅ provider 替换 |
| `glob`/`grep` 作用于远端 | ❌ | 无搜索工具 | ⚠️ 需 ripgrep 预置（B5） |
| **远端命令执行：bash / git / 测试 / 构建** | ❌ **完全没有** | 对 `\.exec\|shell\|bash\|command\|pty\|Terminal\|git` 全文检索：**0 命中**（只有 `AGENTS.md` 文案和错误消息） | ✅ helper + `ctx.subprocess` |
| PTY / 终端 | ❌ | 同上 | 计划 P1b |
| LSP | ❌ | — | realm 内可挂 `lsp-stdio` |
| 原子写 / 版本令牌 / 独占创建 | ❌ | `sftpWrite` `:691` 直写，无临时文件+rename | ✅ helper `os.replace`/`os.link` + 纳秒级令牌 |
| 连接池 / keepalive / 自动重连 / 读缓存 | ✅ | `:483-545` | ⚠️ v1 无重连（P4） |
| 首次账密 → 自动生成并下发公钥 | ❌ | `AuthConfig` 只有 `password` / `privateKeyPath`（`:76-78`）；无 `authorized_keys`/keygen | ✅ `keys.ts`（已本地验证） |
| 主机指纹信任 | ✅ | `architecture.md:22` | ❌ 应该抄过来 |
| 发布工程（install.sh / CI / 迁移 / 安全策略） | ✅ | — | ❌ 应该抄过来 |

## 结论

**它不是"全实现了"，两者覆盖的是不同的层。**

它做的是**前端 + 站点管理 + SFTP 文件工具**：让远端目录出现在侧边栏，并给模型一组
`remote_workspace_*` 工具去读写远端文件。代价是模型必须改用另一套工具，标准工具全部仍打在本地磁盘上，
而且**没有任何远端执行能力** —— 不能在远端跑 git、跑测试、跑构建、开终端，这恰恰是
"在那里开发，用远端资源运行" 的核心。SFTP 协议本身也做不到（细节见 `ctx-subprocess-contract.md` §3）。

我做的是**能力层**：替换 `ctx.fs` / `ctx.subprocess`，让**标准**工具与 shell 直接落在远端。
其中远端 helper 守护进程解决的正是 SFTP 无法表达的那些事：pid/pgid、整棵进程树的存活、
`killpg`、PTY 前台组、`realpath -m`、原子发布、纳秒级新鲜度令牌。

**它已经验证了我原本担心的那一点**：`$DSH_HOME` 下建锚点目录再注册进 `workspaceRegistry`
（也就是我提给你的"方案 C"）在真实环境里是可行的，且它把 `AGENTS.md` 放进锚点作为工作区说明 ——
这个手法值得直接采用。

## 可直接复用的东西

1. 锚点目录 + `workspaceRegistry.create` 的写法（`:1198-1218`）与卸载语义（`architecture.md:127-134`）。
2. `SftpConnectionPool` 的重连 / 空闲 TTL / 并发退化策略（`:483-545`）—— 补我 P4 的缺口。
3. 客户端 `directoryFlow` 影子注册（优先级 `-1`）——这是"在 GUI 里加远端工作区"的正确接法。
4. 主机指纹信任、`install.sh`、v1→v2 存储迁移、CI 与 SECURITY 模板。
