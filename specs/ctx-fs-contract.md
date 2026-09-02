# `ctx.fs` provider 实现规范（给 `dsh-fs-ssh`）

来源：对 `packages/fs/fs/src`（Service Definition）与 `packages/e2b/fs-e2b/src`（唯一已交付远程 provider）的逐行审计。
引用键：`index.ts` = `packages/fs/fs/src/index.ts`；`types.ts` = `packages/fs/fs/src/types.ts`；`e2b.ts` = `packages/e2b/fs-e2b/src/index.ts`。

## 0. 形态

`class SshFileSystem extends FileSystem`，构造函数 `super(ctx, 'fs')`（`index.ts:86,88`），
用 `static inject = ['ssh']` 声明对连接 owner 的依赖（对照 `e2b.ts:172`）。

## 1. 必须实现的成员

| 成员 | 签名要点 | 强制？ | SSH 实现要点 |
|---|---|---|---|
| `resolve(path, opts?)` | → `Promise<FsTarget>`；相对路径按 `opts.cwd` 解析；**同一文件必须同一 `targetKey`**；允许 I/O（`index.ts:108-116`） | 强制 | helper 的 `realpath -m` 语义（**不存在的尾段也要能解析**，创建新文件靠它）。SFTP 的 `realpath` 在路径不存在时失败 → 必须走 helper |
| `processPath(target)` | → `string`，同步无 I/O，执行世界内的绝对路径（`index.ts:126`） | 强制 | `targetKey` 直接存远端 POSIX 绝对路径，返回它（同 `e2b.ts:191`） |
| `fileUrl(target)` | → `file:` URI，**编码由 provider 负责**（`index.ts:143-148`） | 强制 | 纯字符串，逐段 `encodeURIComponent`（照抄 `e2b.ts:196-197`） |
| `contains(parent, child)` | → `boolean`，自反（child===parent 也为 true），不得解析 key（`index.ts:150-157`） | 强制 | `posix.relative` + 拒 `..`/绝对（`e2b.ts:201-202`）；**前提是 resolve 已完全 canonical** |
| `stat(target, signal?)` | → `FsInfo \| undefined`；仅元数据；`undefined` 表示不存在（`index.ts:165`） | 强制 | helper 一次 `stat`；type 只有 `file/directory/other`（**没有 symlink 分支**，`types.ts:79-80`） |
| `lstat(path, opts?, signal?)` | **按路径**而非 target；不跟随最后一段 symlink（`index.ts:181`） | 强制 | helper `lstat`；可报 `symlink`（`types.ts:87-90`）；相对路径用 `posix.resolve` 词法解析，**不做 realpath 往返** |
| `readText(target)` | 整个文件解码为 UTF-8 字符串（`index.ts:189`） | 强制 | helper 读全量 + 端口移植 `decodeText`（`e2b.ts:53-62`）；**seam 层无大小上限**，注意内存 |
| `streamText(target)` | 分块文本；**跨块 UTF-8 解码与二进制拒绝由 provider 负责**（`index.ts:191-200`） | 强制 | helper 分帧流式；`TextDecoder({fatal:true})` 流式解码 + 跨块 NUL 采样（前 8192 字节，`e2b.ts:311-315`） |
| `readBytes(target, signal, maxBytes)` | 原始字节，不解码不拒二进制；**超限必须报 `FS_TOO_LARGE`，绝不截断**（`index.ts:202-212`） | 强制 | 先 stat 预检，再流式读并维持运行中上限（防"stat 后变大"，`e2b.ts:264-269`） |
| `listDir(target)` | 仅直接子项，**稳定名序**，含已解析的子 target，不读内容（`index.ts:221`） | 强制 | helper 一次 `scandir` 带 attrs（比 fs-e2b 的 N+1 好）；symlink 子项需额外解析，失败则降级 `type:'other'` 且省略 `version`/`size`（`e2b.ts:364-367`） |
| `writeText(target, content, expected?, signal?, sandboxPolicy?)` | **原子**创建或替换；`expected` 做意图与陈旧校验；abort 必须发生在原子发布**之前**（`index.ts:223-241`） | 强制 | 见 §3 原子发布；`sandboxPolicy` 可忽略（`index.ts:230-233`，fs-e2b 直接不接这个参数） |
| `editText(target, edit, expected?, signal?, sandboxPolicy?)` | 原子字面替换；**版本校验先于匹配**（`index.ts:243-262`）；`before` 非空 | 强制 | 读全量 → 纯 JS 字面替换（`e2b.ts:149-168`）→ 同一原子发布；CRLF 多数派嗅探并还原（`e2b.ts:42-51`） |
| `sandboxMode` | getter，报告默认围栏模式 | **可选**：不覆盖即 `undefined` = 不围栏（`index.ts:93-104`） | 不覆盖。后果：`tool-fs` 不再宣告 escalation 字段，用户不会被问审批 |
| `processPathFromHostPath(hostPath)` | 把 harness 宿主绝对路径映射进本世界 | **可选**：不覆盖 / 返回 `undefined`（`index.ts:134-138`） | 不覆盖（远端与本机无共享命名空间）。**除非**将来支持共享挂载 |

## 2. 错误契约

`FsError extends HarnessError`，`code: FsErrorCode`（`types.ts:196-202`）。必须用统一 `mapError` 漏斗
（照抄 `e2b.ts:135-147` 的结构：已是 `FsError` 直接透传 → **先判 abort** → 兜底 `FS_IO_ERROR`）。

| code | 触发条件 | SSH 侧来源 |
|---|---|---|
| `FS_NOT_FOUND` | 目标不存在；空白路径 | helper ENOENT |
| `FS_NOT_DIRECTORY` | `listDir` 对非目录 | ENOTDIR |
| `FS_NOT_TEXT` | 含 NUL 或非法 UTF-8 | 本地解码判定 |
| `FS_NOT_REGULAR_FILE` | 对目录/特殊文件读写 | stat 类型判定 |
| `FS_TOO_LARGE` | `readBytes` 超 `maxBytes` | 预检 + 流内上限 |
| `FS_PERMISSION_DENIED` | EACCES/EPERM | helper errno |
| `FS_SANDBOX_DENIED` | 围栏拒绝 | **不产生**（我们不围栏） |
| `FS_IO_ERROR` | 传输/IO 兜底 | 连接断开、协议错误 |
| `FS_STALE_VERSION` | 版本不匹配；`replaceIfVersion` 遇不存在；**edit 时目标消失也用这个而非 NOT_FOUND**（`e2b.ts:413-415`） | 版本比较 |
| `FS_NOT_OBSERVED` | `createIfAbsent` 发现已存在（含发布时竞争失败） | 原子独占创建失败 |
| `FS_AMBIGUOUS_EDIT` | `replaceAll:false` 且匹配数 ≠ 1 | 本地匹配 |
| `FS_EDIT_NOT_FOUND` | `oldString` 未找到或为空 | 本地匹配 |
| `FS_ABORTED` | signal 已中止 | 每次往返之间 `assertNotAborted` |

## 3. 三个"SFTP 做不到、必须靠 helper"的硬点

1. **`realpath -m` 语义**：不存在的尾段也要 canonical（创建文件的前提）。
2. **原子覆盖发布**：SFTP v3 的 `SSH_FXP_RENAME` 不保证覆盖（OpenSSH 遇已存在直接 `SSH_FX_FAILURE`）。
   需要 `posix-rename@openssh.com` 扩展或 helper 的 `os.replace()`。
   **绝不能用 unlink+rename 模拟**——破坏原子性。
3. **`createIfAbsent` 的原子独占创建**：fs-e2b 用 `ln -T` + `test -e/-L`（`e2b.ts:546-558`），
   并且这一步**故意不可 abort**（`e2b.ts:548`）。helper 里用 `os.link()`/`open(O_EXCL)` 实现。

## 4. version token（最大的坑）

`FsVersion` 是"新鲜度令牌"，provider 自选表示（`types.ts:29-34`），但必须非空（`invariant.ts:31`），
且 `stat`/`lstat`/`listDir`/write/edit **必须共用同一个铸造函数**，否则 guard 会假报陈旧。

fs-e2b 的关键手法：往文件元数据里塞 `randomUUID`，使 size+mtime 不变也能变版本（`e2b.ts:520,531`）。
SSH 侧没有元数据边栏，方案（按优先级）：

1. helper 返回 `st_dev:st_ino:st_size:st_mode:st_mtime_ns:st_ctime_ns` 并哈希 —— **推荐**，
   Python `os.stat` 直接给纳秒与 inode，一次往返，保真度高于 SFTP v3（后者只有秒级 mtime、无 inode）。
2. 内容 `sha256`（精确但 O(size)，仅在需要时用）。
3. 纯 SFTP 降级：`[path,type,size,mode,mtime]` 哈希 —— 亚秒内同大小覆盖会被漏判，不采用。

## 5. 其它必须保留的语义

- **换行**：`FsWriteOutcome.before/after`、`FsEditOutcome.before` 均为 **LF 归一化**文本（`types.ts:137-142,161`）；
  edit 匹配也在归一化之后进行（`types.ts:148`）。但落盘要还原原文件的 CRLF 多数派（`e2b.ts:425`）。
- **guard 语义**：`createIfAbsent` 遇存在 → `FS_NOT_OBSERVED`；`replaceIfVersion` 遇不存在或不匹配 → `FS_STALE_VERSION`；
  省略 guard = 无条件覆盖，**不是第三种分支**（`types.ts:118-122`）。
- **`before: null` 是合法降级**：文件原本不存在，或 provider 拒绝提供上下文基线（如原文件是二进制）（`types.ts:135-138`）。
- **字节窗口与行号渲染不在本 seam**（`index.ts:5-6`）——provider 不实现 offset/limit。
- **写入串行化**：fs-e2b 只有**进程内** `withLock(targetKey)` 互斥（`e2b.ts:174,431-441`），无远端 advisory lock。
  SSH provider 继承同样限制，需在 README 声明。
- **abort**：往返之间逐点 `assertNotAborted`（`e2b.ts:517,529,534,540,544`），流式读中止要 `destroy()`。
- **事件**：`fs/write-intent`、`fs/edit-intent`、`fs/observed` 由上层发，provider **不需要**发
  （fs-e2b 一个都不发；其 invariant companion 是 no-op，理由见 `fs-e2b/src/invariant.ts:18-21`）。

## 6. 数据形状清单（provider 必须构造）

| 形状 | 字段 | 引用 |
|---|---|---|
| `FsTarget` | `targetKey`（不透明，非空）、`displayPath`（非空，面向模型/UI） | `types.ts:60-68`，`invariant.ts:16-17` |
| `FsInfo` | `version`、`type: file\|directory\|other`、`size?` | `types.ts:76-83` |
| `FsPathInfo` | `version`、`type: file\|directory\|symlink\|other`、`size?` | `types.ts:91-98` |
| `FsDirEntry` | `name`、`type`、`target`、`version?`、`size?` | `types.ts:104-115` |
| `FsWriteOutcome` | `operation: create\|update`、`version`、`before: string\|null`、`after: string` | `types.ts:128-144` |
| `FsEditOutcome` | `version`、`before: string`（非空可空性）、`after: string` | `types.ts:157-168` |

品牌构造器 `FsTargetKey(...)` / `FsVersion(...)` 不做校验，仅供 backend 使用（`types.ts:24-26,43-45`）。
