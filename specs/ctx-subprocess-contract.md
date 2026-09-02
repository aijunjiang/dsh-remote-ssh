# `ctx.subprocess` provider 实现规范（给 `dsh-subprocess-ssh`）

来源：`packages/subprocess/subprocess/src`（142+264+22 行，全部读完）+ `packages/e2b/subprocess-e2b`（1835 src 行）审计。
引用键：`index.ts` / `types.ts` = `packages/subprocess/subprocess/src/*`；`e2b-*` = `packages/e2b/subprocess-e2b/src/*`。

## 0. 三个抽象成员，一个都不能拒

`abstract class SubprocessRuntime extends Service`，`super(ctx, 'subprocess')`（`index.ts:102-104`）。

| 成员 | 签名 | 可否声明不支持 |
|---|---|---|
| `resolveExecutable(command, env?, signal?)` | `Promise<string>`（`index.ts:118-122`） | **不可** |
| `spawn(spec)` | `SubprocessHandle`，**同步返回**（`index.ts:130`） | **不可** |
| `spawnTerminal(spec)` | `Promise<SubprocessTerminalHandle>`（`index.ts:139`） | **不可** |

> ⚠️ 与最初判断相反：**PTY 子面是强制的**。seam 里没有能力探测、没有 `?` 可选标记、没有"抛 Unsupported"约定。
> 唯一被许可的降级在数据层：foreground 解析不出来可返回 `undefined`（`types.ts:249`）、
> 证明不了在等输入就 `inputWaiting: false`（`types.ts:225`）、
> 会话成员观测不全但必须在文档里声明限制（`types.ts:259-262`）。

`spawn` 的失败语义：**不是抛异常**，而是 `pid === -1`（`types.ts:168`）+ `done` reject（`types.ts:178`，
"rejects only for spawn-level failures"）。

## 1. spec 字段 → SSH 实现职责

| 字段 | 语义 | SSH 侧做法 | 难度 |
|---|---|---|---|
| `argv` | `argv[0]` 是程序，**绝不经 shell 解释**（`types.ts:76`） | 用 helper 传 NUL 分隔 argv 后 `execvp`。纯字符串拼接+单引号转义仍然过了远端登录 shell，不满足契约字面要求 | 高 |
| `cwd` | 子进程工作目录（`types.ts:79`） | SSH 协议无 cwd 字段。helper `chdir()` 并把失败作为 **spawn 级失败**上报（`done` reject + `pid=-1`），**不要**用 `cd \|\| exit 125` —— 会和子进程真实的 125 撞车 | 高 |
| `env` | 显式条目合并在 provider **scrubbed 基底**之上；`undefined` 是墓碑，删除环境条目（`types.ts:96-102`） | `scrubbedParentEnv()` 读的是**本地** `process.env`（`index.ts:62`）——世界错了。必须：`env -0` 探测远端登录环境 → 本地套同两条谓词（`SENSITIVE_ENV_PATTERN` `index.ts:44`、大写后 `DSH_` 前缀 `index.ts:63`）→ 合并 spec.env 与墓碑 → `env -i K=V -- cmd` 启动，防 PAM/`/etc/environment`/rc 重新注入。**不能用 `SendEnv`**（受 `AcceptEnv` 限制且只能加不能减） | 高 |
| `stdio.stdin` | `'ignore'` = fd0 挂 `/dev/null`（`types.ts:32`）；`'pipe'` 暴露 `Writable`；`{data}` 写完即 EOF | `'ignore'` 必须真的开 `/dev/null`（不能只是不写，否则子进程看到永不 EOF 的管道）；`{data}` 用 channel EOF，**不要关 channel**（会丢 exit status） | 低 |
| `stdio.stdout/stderr` | `'pipe'` 原样交出、**绝不缓冲**（`index.ts:88`）；`'inherit'` 透传父描述符；collect 有界缓冲 | SSH 无描述符传递 → `'inherit'` 只能把远端流管到**本地** `process.stdout/stderr`，并明确记录语义偏差（子进程 `isatty` 为假） | 中 |
| `graceMs` | 正有限，≤ `MAX_TIMER_DELAY_MS`；既是 TERM→KILL 的间隔，**也是进程退出后仍开着的 collect 管道的排空上限**（`types.ts:83-88`） | 两个独立本地定时器。注意 `MAX_TIMER_DELAY_MS` **不由本包导出**，需另寻或信任调用方 | 低 |
| `signal` | 触发**与 `terminate()` 相同**的树级升级；本 seam 不做超时分类（`types.ts:91-94`） | abort → 远端 kill 阶梯，**不是**关 SSH channel；`done` 不得 reject | 低 |

## 2. collect 读取器语义（纯本地，最容易做对）

- 偏移是**全流字节坐标**、**非消耗式**、可重复读（`types.ts:132-137`，`index.ts:86-88`）。
- 内存上限溢出保留**尾部**（`types.ts:45`）；`readFrom(0)` 在结束后即批量结果，`lossy` 表示尾窗丢了头。
- `spill` 缺省则完全不落盘（`types.ts:47`）；超 `spill.maxBytes` 要**丢弃已不完整的 spill**（`types.ts:49`）
  并停止上报 `spillPath`（`types.ts:128` 要求"仍然完好"）。
- **spill 必须写在远端世界**：`spillPath` 是路径字符串，而"可执行路径属于与文件系统 provider 共享的同一个执行世界"
  （`index.ts:81-83`）。写在本地的 spill 在那个世界里读不到。

## 3. 必须有 remote helper 才能满足的契约

| 契约 | 引用 | 为什么 SSH 协议本身不够 |
|---|---|---|
| `pid`（树根 pid） | `types.ts:168-169` | SSH 从不回传远端 pid |
| 进程组 / 分离 | `types.ts:162-165` | 需要远端 `setsid()` 并把 pgid 回传；`exit-status` 只带状态 |
| 树级 TERM→grace→KILL | `types.ts:181-185` | 关 channel ≠ kill（无 pty 时 sshd 不可靠地发 SIGHUP，且 setsid 的子进程对 SIGHUP 免疫）；OpenSSH 不实现 exec channel 的 `signal` 请求 |
| `waitForExit` 观测**整棵树** | `types.ts:187-193` | `exit-status` 只覆盖 leader |
| `inspectForeground` | `types.ts:222-227,251` | 没有任何 SSH 消息报告 `tcgetpgrp`；seam 自己说这"无法从普通管道 stdio 重建"（`types.ts:232-234`） |
| `signalForeground` 返回**确切** gid | `types.ts:255-257` | 同上；往 pty 里注入 `^C`/`^Z` 只能覆盖 5 个许可信号里的 2 个，且拿不到 gid |
| 服务 disposal 终止所有托管进程 | `index.ts:94-95` | 以上各项之和 |

helper 需要的动作集：`SPAWN`（chdir + `env -i` 语义 + `setsid` + NUL argv `execvp` + 回传 pid/pgid）、
`WAIT`（`waitpid` → status/signal）、`TREE`（pgid 存活轮询到 `ESRCH`）、
`KILL`（`kill(-pgid,sig)` 阶梯）、`FG`（`tcgetpgrp` + `/proc/<pid>/wchan` 证明在等输入）、
`SPILL`（远端有界 spill 文件）。

**完全不需要远端代码就能做的**：管道 stdio、本地有界收集、偏移读取器、pty 分配与文本传输、window-change。

## 4. 退出事实映射

| 情况 | 上报 |
|---|---|
| 正常退出 | SSH `exit-status` → `{exitCode:n, signal:null}` |
| 信号致死 | SSH `exit-signal`（带信号**名**如 `TERM`）→ `{exitCode:null, signal:'SIGTERM'}` |
| spawn 失败 | `done` reject + `pid=-1`（唯一的 reject 原因） |
| 超时 | **本 seam 不表达**（`types.ts:108-110`）；调用方自己按其持有的 signal 分类 |
| abort | 走 terminate 阶梯，最终是普通信号退出；`done` 不 reject |

部分服务器不发 `exit-signal` → 以 helper 的 `waitpid`/`WTERMSIG` 为权威（e2b 也是这么做的：
自己记录发出的信号并覆盖 SDK 结论，`e2b-process.ts:552-557`）。

## 5. 从 subprocess-e2b 直接抄的结构经验

- **文件划分**：`index.ts`（service 外壳：config/registry/disposal，不含远程协议）、
  `process.ts`（管道进程全生命周期）、`terminal.ts`（PTY）、`output.ts`（纯本地解码器+读取器）、
  `environment.ts`（远端环境探测/scrub/序列化）、`remote.ts`（共享 SDK 选项与容错）。
- **kill 阶梯的"证明"式写法**：两条信号通路都容许失败，**唯一权威是存活探测**（`e2b-process.ts:612-650`）；
  终止可重试直到证明静默（`e2b-process.ts:235-248`）。
- **pgid 校验**：拒绝非数字、拒绝 `pid <= 1`，防止 `kill -- -1`（`e2b-process.ts:496-503`）。
- **僵尸算死**：存活探测排除 `Z/X/x` 状态（`e2b-process.ts:658`）。
- **拒绝相对可执行路径**（`e2b-index.ts:119-123`），与 seam 的 `index.ts:111-112` 一致。
- 私有状态目录：`runtimeRoot/processes/<uuid>`、`terminals/<uuid>`，owner 的 teardown 兜底清理。

## 6. 没有共享一致性测试套件（重要）

`packages/subprocess/subprocess/tests/service.spec.ts` 与 `packages/fs/fs/tests/service.spec.ts`
都只是 seam 自测（各自本地定义 stub/fake），**不导出任何入口**。
`subprocess-e2b` / `fs-e2b` 的测试各自手写 `FakeSandbox` 打桩。

⇒ 验收标准不能写成"跑共享套件"。仓库里可借鉴的模板是
`packages/storage/storage/tests/contract.ts`（`runKvBackendContract(label, create)`）。
我们的做法：**自己写一套 provider 一致性测试**，用一个 fake SSH 传输打桩，并对照
`subprocess-local` / `subprocess-e2b` 的行为逐条核对上表。
