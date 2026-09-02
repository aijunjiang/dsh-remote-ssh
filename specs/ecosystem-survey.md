# 生态调研：已有实现覆盖到哪一步

抓取于 2026-09（本地副本在 `.reference/`）。结论先写：**我原本计划自己写的 P1/P2，社区已经有人写了约八成**，
但**"一台设备对多个远端同时开发"这一条恰恰没实现**，而且缺的三处正是我的契约审计预判到的硬点。

## 已有的四个东西

| 包 | 来源 | 规模 | 做什么 |
|---|---|---|---|
| `dsh-easyssh` | 被 `chai1110/dsh-ssh-remote` vendored；其 subprocess 注明 "Ported from UynajGI/dsh-ssh (MIT)" | `index.js` 2219 / `fs.js` 516 / `subprocess.js` 583 / `client.js` 1631 | **真正替换 `ctx.fs` + `ctx.subprocess`**，模式路由 facade |
| `dsh-ssh` | `chenw2759-wq/dsh-IDE`（BSD-3） | `index.js` 3627 | SSH 引擎：连接池、隧道、网页终端、`ssh_*` 工具 |
| `dsh-aionui-panel` | 同上 | `index.js` 2017 + client | 右侧 IDE 面板：文件树 / 预览 / 编辑 / 终端 / diff |
| `dsh-ssh-remote` | `chai1110/…`，fork 自 `flymysql/dsh-remote`（MIT） | `lib/index.js` 1600 + 9 个模块 | 多机注册表、**每机独立连接池**、`rw_*` 工具、SFTP 双向镜像同步 |
| `dsh-remote-workspace` | `Hefulalala/…` | `index.ts` 1773 + client 950 | 站点表 + 锚点工作区 + 侧栏 GUI + `remote_*` 工具（**无执行能力**，见 `reference-plugin-comparison.md`） |

## `dsh-easyssh` 做到了什么（这是关键的一个）

它的 `cordis.patch.yml` 直接做了 seam 切换 —— 和我 DESIGN §2.6 的路由 provider 想法一致：

```yaml
- id: fs-sandbox      # 停掉本地 ctx.fs
  disabled: true
- id: subprocess      # 停掉本地 ctx.subprocess
  disabled: true
- insert:
    - id: easyssh-fs           name: 'dsh-easyssh/fs'
    - id: easyssh-subprocess   name: 'dsh-easyssh/subprocess'
```

`fs.js` 是名副其实的 provider：`import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'`，
覆盖了 `FS_NOT_FOUND / FS_PERMISSION_DENIED / FS_TOO_LARGE / FS_NOT_TEXT / FS_STALE_VERSION /
FS_NOT_OBSERVED / FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT / FS_NOT_DIRECTORY / FS_NOT_REGULAR_FILE /
FS_ABORTED / FS_IO_ERROR`；`realpath -mz -- <path> | base64 -w0`（`:321`）正是我设计的 `realpath -m` 语义；
写入走临时文件 + `rename`（`:387-396`），独占创建用一次 shell 探测。
`subprocess.js` 有 spawn、collect+spill、TERM→grace→KILL、以及**真的 PTY 终端**（SSH PTY + login shell 替换）。
本地模式下两个 facade 都 `delegate()` 回本地实现。

所以"SSH 模式下模型用**标准** read/write/edit/bash 就直接操作远端"这件事，**已经实现了**。

## 但是：四处实测缺口（都有行号）

### 1. 不是会话级 —— 全局单一 current 远端（**这条正是你最初的需求**）

`easyssh-fs` / `easyssh-subprocess` 路由读的是 `getState()`，返回**全进程唯一**的
`{ mode, alias, remoteRoot }`（`fs.js:117-122`、`index.js:1247-1260`），由一个 HTTP 端点
"进入/退出 SSH 模式"整体切换（`index.js:1498-1550`）。后果：

- 同一进程内**只有一个远端生效**。切到 B 机，所有会话（包括正在对 A 机干活的那个）一起被切走。
- `dsh-ssh-remote` 给 `rw_*` 工具加了 `machineId` 参数确实能并行操作多机，但那是**旁路工具**；
  标准 `read`/`edit`/`bash` 仍然只跟随全局 current。所以"多机并行"只对 `rw_*` 成立，
  对"用标准工具在多个远端同时开发"不成立。

我的 §2.6 路由方案（锚点路径 / 工作区 → 机器）正是修这一条：路由键从"全局 current"换成"入参路径所属工作区"。

### 2. `signalForeground` 直接拒绝 → 交互式命令语义退化

```js
// subprocess.js:359-360
signalForeground(_signal) {
  return Promise.reject(new Error('subprocess-ssh: cannot resolve the foreground process group over an SSH channel'))
}
```

与我 `specs/ctx-subprocess-contract.md` 的预判一致：SSH channel 拿不到前台进程组，
必须远端 helper 做 `tcgetpgrp` + `/proc/<pid>/wchan`。缺了它，终端里 Ctrl-C 之类的语义不完整。

### 3. 没有 pgid / `setsid` / `killpg` → 进程树杀不干净

终止走的是 SSH channel 的 `session.signal('TERM')`（`subprocess.js:229-235`）。两个问题：
**很多 OpenSSH 服务端直接忽略 channel signal 请求**；即便生效也只打到顶层进程，
`sleep 120 & sleep 120`、`npm test` 拉起的 watcher 之类会残留。契约要求的是树级终止。

### 4. spill 落在**本地** tmpdir，版本令牌只有秒级精度

```js
// subprocess.js:445
spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-ssh-'))
```

模型拿到的 `spillPath` 指向本机文件，而它的世界是远端 → 读不到（我的 B6 就是这条）。
`fs.js:61-67` 的 version = hash(size, mtime, mode)，SFTP 的 mtime 是**秒级**，
所以"同大小、同一秒内被改写"检测不到 stale，`edit` 的陈旧守卫会漏。我的 helper 用
`dev:ino:size:mode:mtime_ns:ctime_ns` 正是为此。

### 5. 其它已知取舍（它自己承认）

它的 workspace guidance 明写："SSH 模式下本机沙箱不对远程执行生效"（= 我的 4.2）、
"远程 grep/glob 有限深与条数上限"（它没预置 ripgrep，自己实现了受限的 remote glob/grep，= 我的 B5 的另一种解法）。

## 结论与建议

**不要重写。** 该做的是增量：

1. 先把 `dsh-easyssh` + `dsh-ssh`(+面板) 这一套装上跑通，确认基线行为。
2. **会话级路由**：把全局 `getState()` 换成按"入参路径 → 工作区 → 机器"的路由表，
   让多个远端在一个进程内真正并存（DESIGN §2.6）。这是你最初要的那一条，也是现成实现唯一没做的大功能。
3. **helper 增强**：给 subprocess 加 helper 模式，拿回 pgid 树级终止、foreground group、远端 spill；
   给 fs 换 inode+纳秒版本令牌。我已经写完并本地验证的 `packages/ssh`（helper + 协议 + 密钥阶梯）
   正好是这三件的零件，不必丢弃。

许可上均为 MIT / BSD-3（见各 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`），可以 fork 并二次分发，需保留声明。
