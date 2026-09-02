# 上游 `UynajGI/dsh-ssh` 审计（v0.x，pushed 2026-08-16，MIT）

它是这个方向上唯一完整的实现，覆盖面比我原计划大：`ctx.ssh` + `ctx.subprocess` + `ctx.fs` 三个
provider 一行挂齐、ProxyJump 多跳、ssh-agent/Pageant、`~/.ssh/config` 别名、host key 校验、
多连接注册表（`~/.dsh/dsh-ssh-connections.json`）、`ssh://<connectionId>/<path>` 路由、
Remote-Explorer 风格 GUI、SFTP 目录选择器。**会话级多远端并存这一条它做到了**（路由键落在 target key 上，
不是全局 current），这正是被 vendored 的旧 `dsh-easyssh` 构建缺的那一块。

本地副本：`.reference/UynajGI__dsh-ssh/`。以下每条都经过独立核实。

## A. 活代码与死代码

`src/index.ts:17` 导出的是 `filesystem-final.ts`。同目录另有两份副本：

- `filesystem.ts`（498 行）—— 早期非路由版本，未被导出。
- `filesystem-routed.ts`（522 行）—— **根本无法编译**：`:295` 与 `:297` 在同一块里
  两次 `const remotePath`，是 `SyntaxError: Identifier 'remotePath' has already been declared`。
  说明它是被 `filesystem-final.ts` 取代后遗留的草稿。

⇒ 审计只针对 `filesystem-final.ts` / `subprocess.ts` / `process.ts` / `output.ts` / `terminal.ts`。

## B. 已核实的功能缺口

### B1 `glob` / `grep` 在远端会话里必然失败（目标点名的阻塞点）

全源码检索 `ripgrep|rgPath|vscode/ripgrep|tool-fs-search|glob|grep`：**零命中**。而 harness 侧：

```ts
// packages/fs/tool-fs-search/src/search-core.ts:234-236
handle = ctx.subprocess.spawn({
  argv: [await resolveRgPath(), '--no-config', ...argv],
  cwd: workdir,
```

`resolveRgPath()` 返回**宿主**的 `@vscode/ripgrep` 二进制路径（Windows 上是 `C:\...\rg.exe`）。
远端 spawn 拿这个路径去 execvp → 127。所以 README 那句 "Every tool built on those seams …
switches to the remote host with zero changes" 对搜索工具不成立。

附带第二个漏洞：`glob.ts:344` 的搜索根用
`toWorkdirRelative(input.path, run.workdir)`，内部是宿主 `node:path.relative`，
而 `run.workdir` 是**本地占位目录**。在 Windows 宿主上拿它去和远端 POSIX 路径求相对路径会得到垃圾。
不传 `path:` 时根为 `.`、rg 输出相对路径，显示链恰好正确 —— 所以这个洞只在显式传 `path:` 时暴露。

**我的对策**（本轮已实现并单测）：`packages/remote-argv/`
- `isPackagedRipgrep(argv0)` —— 只翻译宿主专属拼写；`/usr/bin/rg`、裸 `rg` 原样通过。
- `translateHostPath()` / `translateArgv()` —— 占位前缀 → 远端路径，最长前缀优先，
  Windows 大小写不敏感，非路径参数不可能误命中。
- `resolveRemoteRipgrep()` —— 四级阶梯：配置路径 → `command -v rg` → 已预置的二进制 → 现场预置；
  每一级都用**实际执行 `rg --version`** 证明（只看可执行位会让架构不匹配的二进制在很久以后才以
  ENOEXEC 形式暴露）。配置了却跑不起来是硬错误，绝不静默降级。
- `ripgrepAssetTriple()` —— musl/gnu 与 aarch64 拼写是"静默产出不可运行二进制"的两个来源，
  不支持的组合返回 `undefined` 而不是猜。

### B2 `listDir` 每个目录项一次 SSH exec

```ts
// filesystem-final.ts:285-287
for (const entry of listed) {
  const canonical = await this.canonicalPath(childRemotePath, signal, route.transport)
```

`canonicalPath`（`:367`）是一次 `realpath -mz -- <path> | base64 -w0` 的 **exec**。
于是列一个 500 项的目录 = 500 次串行 SSH exec。这不是常数因子问题，是量级问题。

**我的对策**：helper 的单个 `listdir` 动作在一次往返里返回全部条目的 type/version/mode/size
（`packages/ssh/helper/dsh_helper.py` `op_listdir`）。

### B3 `readText` 无上限，`readBytes` 的上限是事后检查

```ts
// filesystem-final.ts:219 / :429 / :437
await this.readBytesRaw(target, signal, Number.POSITIVE_INFINITY)
// :399-408
sftp.readFile(route.path, …)          // 整个文件读进内存
if (data.length > maxBytes) throw new FsError(…, 'FS_TOO_LARGE')   // 读完之后才判
```

`readBytes`（`:224-229`）会先看 `info.size` 预检，但 size 缺失时仍会整读；`readText` 路径压根没有上限。
一个 4 GB 的远端文件足以把 harness 打爆。

**我的对策**：helper 的 `read` 动作流式分块、`maxBytes` 是**预检 + 读取途中**双重硬上限，
超限立即以 `E2BIG` 中止（`op_read`）。

### B4 进程控制三缺（作者自己在 README 的 Limitations 里列了）

| 缺 | 后果 |
|---|---|
| 远端 pid 不可见 → `pid = -1` | 上层无法定位远端进程 |
| 终止不是树级 | 后代进程存活（`npm test` 拉起的 watcher、`sleep 120 &`） |
| 无前台进程组 → `inspectForeground` 返回 undefined、`signalForeground` 抛错 | 终端交互语义不完整 |

根因是 SSH 协议本身：channel 上既拿不到 pid/pgid，也拿不到 `tcgetpgrp`。

**我的对策**：`dsh_helper.py` 用 `start_new_session=True` 让子进程成为会话首领（pgid == pid），
`op_spawn` 回报真实 pid+pgid，`op_kill` 走 `killpg`，`op_alive` 用 `killpg(pgid, 0)` 证明整树静默。
（前台组探测 `tcgetpgrp` + `/proc/<pid>/wchan` 仍待实现，标记为 P1b。）

### B5 spill 文件落在本地

```ts
// output.ts:20
defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-ssh-'))
// subprocess.ts:43
private readonly spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-ssh-'))
```

模型收到的 `spillPath` 指向**宿主**文件，而它被告知自己在远端世界里 → 它拿这个路径去 `read` 必然找不到。

**我的对策**：helper 的 `spawn` 接受 `spill.path`，spill 写在远端；`spillPath` 因此落在模型的世界里。

### B6 完全不与 sandbox 交互

检索 `sandbox|workspaceRoot|processPathFromHostPath`：**零命中**。
即本机 `sandbox-policy` 的围栏对远端执行不生效，README 的 Limitations 也没提这一条。
这与我 `DESIGN.md` §4.2 的结论一致（跨机后围栏必然失效），但**必须显式向用户声明**，
不能让人以为 `workspace-write` 模式还在保护什么。

### B7 版本令牌只有秒级精度

```ts
// filesystem-final.ts:87
FsVersion(`ssh:${sha256(JSON.stringify([path, stats.size, stats.mtime, stats.mode]))}`)
```

`stats.mtime` 来自 SFTP v3 属性，**秒级**，且没有 inode。同大小、同一秒内的改写检测不到，
`edit` 的陈旧守卫会漏 —— 恰好是并发编辑最危险的场景。

**我的对策**：helper 用 `dev:ino:size:mode:mtime_ns:ctime_ns` 的 SHA-256（`_version_token`）。

### B8 无自动重连；远端会话不进工作区注册表

作者在 Limitations 里列了。后者的根因就是我独立发现的 B1（`packages/workspace` 全程 `node:fs`），
对策是锚点目录（`DESIGN.md` §2.6）。

## C. 结论

**基线该用它，不该重写。** 它把最难的部分（连接、认证矩阵、ProxyJump、路由、GUI、SFTP fs、PTY）
做完了且质量不低。我的增量是六条**已被证据定位**的缺口：

| 增量 | 状态 |
|---|---|
| B1 ripgrep + argv/路径翻译 | ✅ 已实现 + 单测绿（`packages/remote-argv`） |
| B4 真实 pid/pgid + 树级终止 | ✅ helper 已实现（`op_spawn`/`op_kill`/`op_alive`），待真机验收 |
| B5 远端 spill | ✅ 协议已含 `spill.path`，待接线 |
| B2/B3 单次往返 listdir + 流式带上限 read | ✅ helper 已实现（`op_listdir`/`op_read`），待接线 |
| B7 inode+纳秒版本令牌 | ✅ helper 已实现（`_version_token`），待接线 |
| B6 sandbox 失效的显式声明 | ⏳ 文档 |
| B8 重连 | ⏳ |

许可 MIT，可 fork 并二次分发。
