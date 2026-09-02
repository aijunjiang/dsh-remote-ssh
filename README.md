# dsh-remote-ssh

给 DSH 增加**远程工作区**能力的 out-of-tree 插件集：会话记录、GUI、`$DSH_HOME` 全部留在本地，
工作区的文件读写与命令执行（git / 测试 / 构建 / LSP）发生在 SSH 远端。**用户层面**：
dsh web GUI 里管理 SSH 连接、浏览远端目录、按会话选择远端 —— 连接侧边栏与远程浏览器
来自 fork 的 `UynajGI/dsh-ssh`（MIT），能力层是本仓库自己的 helper 增强 provider。

- 设计与架构证据：`DESIGN.md`
- 契约规范（实现时的唯一依据）：`specs/ctx-fs-contract.md`、`specs/ctx-subprocess-contract.md`
- 阻塞点与决策：`specs/blockers-and-decisions.md`
- **生态调研（先读这个）**：`specs/upstream-dsh-ssh-audit.md`、`specs/ecosystem-survey.md`、
  `specs/reference-plugin-comparison.md`

## 用户层面（GUI）状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 连接管理（添加/测试/删除，密码/密钥/agent、跳板） | ✅ 后端已装 + 已测 | `/dsh-ssh` RPC 端点 `connections.*`，注册表持久化到 `~/.dsh/dsh-ssh-connections.json` |
| 远程目录浏览/mkdir | ✅ 后端已装 | `browse.*` 端点（SFTP 直连，与连接层共享通道） |
| `~/.ssh/config` 主机感知 | ✅ 后端已装 | `config.hosts` + `connections.resolve` |
| **GUI 连接驱动能力层** | ✅ 真机验证 | `SshHelperSession` 在注册表连接自己的传输上跑 helper 通道；fs/subprocess provider 直接消费 —— 浏览器与 agent 共享一条 TCP 连接（`tests/gui-connect.e2e.ts`） |
| **会话级路由（多远端并行）** | ✅ 真机验证 | `SshHelperRouter`：`ssh://<id>/<path>`（或本地占位）cwd 决定机器；fs 全链按 target key 路由、跨机 containment 为 false；spawn 按 cwd 路由；每连接一个 helper 守护进程（`tests/routing.test.ts` + `tests/routing-connect.e2e.ts`） |
| React 侧边栏 + 浏览器 UI | ✅ 已构建并验证 | `lib/client.js`（+map）由 `scripts/build-gui-client.mjs` 用 harness 的 tsdown client 管线产出；`tests/client-bundle.smoke.ts` 校验 wire 格式/外部队列/可实例化。**真实 web 实例验证**：带 patch 启动后 `__DSH_BOOT__` 图含 `dsh-ssh-gui`（5 条 inject 边），`/plugins/??dsh-ssh-gui/client.js&rev=…` 返回 200 且是 `window.__ModuleLoader__.load` 格式。浏览器内渲染待你在实例里打开确认 |
| 目录选择器替换（picker 行） | ⏳ 可选增强 | 替换 dsh 默认 add-workspace 选择器；注入 `ctx.ssh` 的上游接口（`getSftp`/`endpoint`），需要 ctx.ssh 指向 GUI 连接。当前组合改为「禁用 `-auto` 的**表面**、直挂它的 browse **后端**」，让 ssh-gui 的 flow 独占两个 directory-flow 单槽位，本地浏览仍走 `uiWorkspace`（同一条 seam） |

后端已验证：`packages/ssh-gui/tests/backend.test.ts`（真实 cordis Context + fake RPC 传输，
连接增删查、持久化重启、错误码）、`helper-session.test.ts`（部署/启动/验证/请求/进程事件/清理）、
`routing.test.ts`（双连接路由）、`gui-connect.e2e.ts`（真机：注册表连接 + helper 会话 +
fs/subprocess provider 全链）、`client-bundle.smoke.ts`（bundle 注册格式 + 可实例化）。
浏览器侧由我们自己的构建 + smoke 守护（不再依赖上游 CI）。

## 路线已修正：基线用上游，我们只做被证据定位的增量

`UynajGI/dsh-ssh`（MIT）已经把连接 owner、认证矩阵、ProxyJump 多跳、`ctx.fs`、`ctx.subprocess`、
PTY、多连接注册表、`ssh://<id>/<path>` 会话级路由和 Remote-Explorer 风格 GUI 做完了。
**不重写它。** 审计出六条真实缺口（每条都有行号证据，见 `specs/upstream-dsh-ssh-audit.md`）：

| # | 缺口 | 证据 | 我们的对策 | 状态 |
|---|---|---|---|---|
| B1 | 远端会话里 `glob`/`grep` 必然失败：spawn 的是**宿主** rg 二进制路径 | 上游零处理；`tool-fs-search/src/search-core.ts:234-236` | `packages/remote-argv`：argv0 识别 + 占位路径翻译 + 远端 rg 四级解析阶梯 | ✅ 本地已绿 |
| B2 | `listDir` 每个目录项一次 SSH exec（500 项 = 500 次往返） | `filesystem-final.ts:285-287` + `:367` | helper 单次 `listdir` 往返返回全部元数据 | ✅ helper 已实现 |
| B3 | `readText` 无上限、`readBytes` 上限是**读完之后**才判 | `filesystem-final.ts:219/399-408/429/437` | helper `read` 流式分块 + 读取途中硬上限 → `E2BIG` | ✅ helper 已实现 |
| B4 | pid 不可见（`-1`）、终止不是树级、无前台进程组 | 上游 README Limitations | helper `start_new_session` → 真实 pid/pgid、`killpg`、`killpg(pgid,0)` 静默证明 | ✅ helper 已实现（前台组探测待做） |
| B5 | spill 落**本地** tmpdir，模型拿到的 `spillPath` 在它的世界里不存在 | `output.ts:20`、`subprocess.ts:43` | helper spawn 接受 `spill.path`，spill 写远端 | ✅ 协议已含，待接线 |
| B7 | 版本令牌只有**秒级** mtime、无 inode → `edit` 陈旧守卫会漏 | `filesystem-final.ts:87` | `dev:ino:size:mode:mtime_ns:ctime_ns` 的 SHA-256 | ✅ helper 已实现 |

另有 B6（本机 sandbox 围栏对远端执行不生效，上游连文档都没提）与 B8（无重连）待处理。

## 本地验证（不需要远端）

## 怎么用

先让 loader 在 **profile 树**里能解析到这四个包（`--patch` 行的名字按 profile 目录解析，
不是按 patch 文件目录）：

```powershell
# 开发安装：junction 进当前 profile 的 hoisted node_modules（等价于本仓库 README 里
# 的 @deepseek-ai/* junction 手法，只是目标换成 profile 树）
$prof = "$env:USERPROFILE\.dsh\profiles\node_modules"
New-Item -ItemType Junction -Path "$prof\dsh-ssh"            -Target "C:\...\dsh-remote-ssh\packages\ssh"            -Force
New-Item -ItemType Junction -Path "$prof\dsh-fs-ssh"         -Target "C:\...\dsh-remote-ssh\packages\fs-ssh"         -Force
New-Item -ItemType Junction -Path "$prof\dsh-subprocess-ssh" -Target "C:\...\dsh-remote-ssh\packages\subprocess-ssh" -Force
New-Item -ItemType Junction -Path "$prof\dsh-ssh-gui"        -Target "C:\...\dsh-remote-ssh\packages\ssh-gui"        -Force

# 发布形态：dsh plugin add file:<各包目录>（bundle 声明会进 dsh.profile.bundles）
```

然后：

```powershell
$env:DSH_REMOTE_HOST='dev.example'
$env:DSH_REMOTE_USER='dev'
$env:DSH_REMOTE_CWD='/home/dev/proj'
$env:DSH_REMOTE_PASSWORD='...'        # 仅首次；随后自动改用密钥
pnpm dsh web --patch ./dsh-remote-ssh/cordis.patch.yml
```

重启后 web GUI 的「选择工作区目录」流程就是 SSH 连接侧边栏 + 远程浏览器：
已保存连接、`~/.ssh/config` 主机、添加/测试/删除、远程目录浏览与 mkdir、`ssh://<id>/<path>`
路由。浏览「本机」侧仍需宿主 browse seam，见下方第 6 条。

`cordis.patch.yml` 做的事，理由都写在文件正文里：

1. **两个 seam 一起换**（`subprocess` + `fs-sandbox` 下，`subprocess-ssh` + `fs-ssh` 上）。
   只换一个会得到"文件在本机、命令在远端"的分裂世界。
2. **连接 cwd 与 `sandbox-policy.workspaceRoot` 取同一个环境变量** —— 同一个目录出现两处拼写，
   就是 one-world 违背的入口。
3. **本机 sandbox 行全部下掉**。这不是"围栏失效"而是"必然崩"：`LocalSandboxProvider.confine()`
   把 argv 重写成宿主 launcher（`bwrap` / `sandbox-exec` / Windows ACL runner，
   `sandbox-local/src/index.ts:306-328`），而 `bash-sandbox` 每条命令都过它
   （`bash-sandbox/src/index.ts:178`）—— 发到 Linux 目标机，那些程序和路径根本不存在。
   `dsh-permission-presets` 也随之禁用：它的预设**捆绑 sandbox 模式**，面对无围栏 executor
   直接拒绝激活（"the mounted bash executor does not confine … is a misconfiguration"）。
4. **shell 栈按目标机而非宿主选**：Windows 宿主默认开 `tool-pwsh`、关 `tool-bash`，
   执行一旦发生在 Linux，这两个决定都是错的。`ctx.shell` 用**未围栏**的 `bash-local`
   —— 它 `inject = ['subprocess']`，命令因此跟着 seam 跑到远端，正是整个设计的论点。
5. **GUI 行挂包根** `dsh-ssh-gui`（不是 `dsh-ssh-gui/web` 子路径）：client-modules 只扫描
   名字解析到**包根**的 loader entry（子路径行在解析前就被判"非 client 行"），包根模块
   再透传 web.ts 的 `apply/inject/Config`。
6. **默认目录选择器让位**：`-auto` 行（`directory-picker`）会向 ui-workspace 的两个
   directory-flow **单槽位**再注册一个占用者——与 ssh-gui 的 flow 冲突（二次注册即抛错）。
   禁掉它后直挂它的 browse **后端**（`dsh-host-directory-picker-browse`，无表面），保住
   `ctx.directoryPicker` → `remote.directoryPicker` 链（ui-workspace 的 client 硬注入它，
   断链会让整个工作区 UI 卡在 pending）。

> ⚠️ **宿主的 sandbox 策略对目标机不构成任何约束。** 那边唯一的围栏是远端账号自身的权限。
> 请指向一台你愿意让 agent 以该账号全部权限操作的机器。这句话已写进 patch 正文，并由
> `tests/composition.test.ts` 断言"必须写出来"，防止将来被静默降级。

## 真机验证（2026-03-09，192.168.10.125 / Ubuntu 20.04 x86_64 / Python 3.8.10）

```powershell
$env:DSH_SSH_HOST='192.168.10.125'; $env:DSH_SSH_USER='amax'; $env:DSH_SSH_CWD='/home/amax'
$env:DSH_SSH_PASSWORD='...'; $env:DSH_SSH_IDENTITY_DIR='...\dsh-remote-ssh\.scratch-identity'
node .\packages\ssh\tests\connect.e2e.ts
```

输出（一次通过）：

```
fs-ssh e2e: ok — resolve identity, CRLF fidelity, CAS edits, one-trip listing, capped reads
subprocess-ssh e2e: ok — env scrub, real pid, tree termination, remote spill
connect.e2e: ok — auth, helper, fs identity, spawn, tree termination, providers, and search all verified
connect.e2e: removed 2 provisioned key line(s) for dsh@192.168.10.125
```

覆盖：真实 sshd 上的密码→密钥认证阶梯、helper 上传与启动、协议帧路由、纳秒版本令牌
（同秒同大小改写仍换 token）、`realpath -m`、独占创建、树级 TERM 后静默证明、
`ctx.fs` 全链（CRLF 保真往返、CAS 编辑、一次往返 listDir、目标侧字节上限）、
`ctx.subprocess` 全链（远端环境 scrub、真实 pid、树级终止、**目标机上可读的 spill**）、
以及运行后的**自动密钥清理**（从 `authorized_keys` 移除本次安装的行）。

> `remote-argv e2e: skipped — the target has no rg on PATH` 是设计内行为：
> 该段只在目标机有 ripgrep 时运行（用了它的 `command -v` 阶梯）。argv 翻译本身
> 由 `packages/remote-argv/tests/*` 全量覆盖，其中 `translate.test.ts` 用的正是
> `tool-fs-search` 的真实 argv 形态。

## 本地验证（不需要远端）

```powershell
node .\scripts\test.mjs                              # 19 个套件一次跑完
python -m py_compile .\packages\ssh\helper\dsh_helper.py
```

当前输出：`all 19 local suites passed`。

| 套件 | 验证内容 |
|---|---|
| `packages/ssh/tests/keys.smoke.ts` | `ssh2` 接受我们手工生成的 `OPENSSH PRIVATE KEY`，签名/验签闭环 |
| `packages/ssh/tests/runtime.smoke.ts` | 模块图在 harness 包域内可解析、schema 默认值、引号不可逃逸 |
| `packages/ssh/tests/channel.test.ts` | 帧路由：逐字节切分、一包多帧、尾部半帧、流式 payload、进程事件先于 spawn 回复、错误码、畸形帧不致命、就绪竞态、通道死亡后全量拒绝、spill 丢失事件 |
| `packages/remote-argv/tests/translate.test.ts` | rg 识别只命中宿主拼写、最长前缀优先、Windows 大小写、非路径参数零误伤 |
| `packages/remote-argv/tests/ripgrep.test.ts` | 四级阶梯与五种失败模式、musl/aarch64 资产选择 |
| `packages/subprocess-ssh/tests/output.test.ts` | 全流字节偏移、非消耗式重复读、溢出保尾、跨 chunk 多字节字符、spill 超限即丢弃且不再上报 |
| `packages/subprocess-ssh/tests/process.test.ts` | 生命周期、退出事实映射、**树级终止以静默为判据**、grace 内已死不再 KILL、abort 不 reject `done`、stdin 三形态、远端 spill |
| `packages/subprocess-ssh/tests/environment.test.ts` | `env -0` NUL 解析（含多行值）、**远端世界**的 scrub 与 seam 谓词逐字一致、墓碑删除、显式覆盖 |
| `packages/subprocess-ssh/tests/resolve.test.ts` | 绝对路径校验、相对路径拒绝、按子进程 PATH 查找、builtin/函数拒绝、引号注入 |
| `packages/subprocess-ssh/tests/service.test.ts` | 在**真实 cordis Context** 上：eager 校验、环境探测缓存、rg argv 翻译、disposal 必须等到整树静默 |
| `packages/fs-ssh/tests/core.test.ts` | 二进制/非法 UTF-8 拒绝、跨 chunk 流式解码、CRLF 多数派往返、edit 顺序（版本先于匹配）、guard 三形态、containment 自反、`file:` 编码、错误漏斗（abort 优先） |
| `packages/fs-ssh/tests/provider.test.ts` | 同一文件多种拼写得同一 key、不存在的尾段也能 resolve、**listDir 只用一次往返**、上限必须传到 helper、O_EXCL 守卫、CAS 发布、失败的 edit 不落盘 |
| `packages/ssh-gui/tests/smoke.ts` | GUI 闭包全部模块解析（runtime/connection/registry/transport/web/picker/plugin） |
| `packages/ssh-gui/tests/backend.test.ts` | 真实 cordis Context + fake RPC 传输：注册表挂载、连接增删查、持久化重启、错误码 |
| `packages/ssh-gui/tests/helper-session.test.ts` | GUI 连接上部署/启动/验证 helper、请求、进程事件、runtimePath、disposal |
| `packages/ssh-gui/tests/routing.test.ts` | 双连接路由：cwd 决定机器、写/包含/spawn 都按路由分发 |
| `tests/client-bundle.smoke.ts` | `lib/client.js` 是 `window.__ModuleLoader__.load({id:"dsh-ssh-gui",…})`；外部队列只有 `react`/`react/jsx-runtime`；factory 可实例化出 `{apply, inject}`；sourcemap 是合法 v3 |
| `tests/composition.test.ts` | patch 的每个行 id 在 base/web-app bundle 里真实存在、两个 seam 必须同时切换、cwd 与 workspaceRoot 同源、shell 孪生行成对切换、sandbox/permission/默认 picker 的下掉声明、GUI 行挂包根、`./client` 已导出 |
| `packages/ssh/helper/tests/test_spill.py` | 远端 spill 累积、超限删除并上报、独占创建、写失败上报 |

真机 E2E（未运行，需要一台 Linux 目标）：

```powershell
$env:DSH_SSH_HOST='dev.example'; $env:DSH_SSH_USER='dev'; $env:DSH_SSH_CWD='/home/dev/scratch'
$env:DSH_SSH_PASSWORD='...'          # 仅首次；之后自动改密钥
$env:DSH_SSH_IDENTITY_DIR="$env:USERPROFILE\.dsh\remote-ssh"
node .\packages\ssh\tests\connect.e2e.ts
```

它一次性验证认证、helper 上传与启动、`realpath -m`、原子发布与版本令牌、独占创建、
`which` 的拒绝规则、spawn 的 pid/pgid/退出码、坏 cwd 必须是 spawn 级失败、**树级** TERM 后的静默证明 ——
然后是 **provider 全链**：`ctx.fs` 的 resolve 恒等、CRLF 保真、CAS 编辑、一次往返 listDir、目标侧上限；
`ctx.subprocess` 的远端环境 scrub、真实 pid、树级终止、**目标机上可读的 spill**；以及
**搜索翻译**（用 `tool-fs-search` 的真实 argv 形态去远端执行 rg，目标机有 rg 时验证）。

## 布局

```
packages/ssh/
├── helper/dsh_helper.py    # 远端常驻守护：pgid、树存活、killpg、原子发布、纳秒级版本令牌
├── src/protocol.ts         # 线协议类型（与 helper 同步修改）
├── src/channel.ts          # 帧编解码与路由（无传输依赖 ⇒ 唯一可完整单测的部分）
├── src/keys.ts             # ed25519 → OpenSSH 私钥 PEM + authorized_keys 行（零原生依赖）
└── src/index.ts            # ctx.ssh：连接/认证/helper 供给（路由已委派给 channel.ts）
packages/remote-argv/
├── src/index.ts            # argv0 识别 + 宿主占位路径 → 远端路径翻译
└── src/ripgrep.ts          # 远端 rg 解析阶梯（用实际执行 --version 证明，不看权限位）
packages/subprocess-ssh/    # ctx.subprocess provider（helper 后端）
├── src/index.ts            # service 外壳：环境探测缓存、rg 解析、argv 翻译、disposal
├── src/process.ts          # 一棵远端进程树：生命周期、退出事实、树级终止
├── src/output.ts           # 有界收集器：字节偏移、保尾、远端 spill 记账
├── src/environment.ts      # 远端世界的 env 探测 / scrub / 墓碑合并
├── src/resolve.ts          # resolveExecutable 的三种情况与一种拒绝
└── src/shell.ts            # ctx.shell：复用未围栏的 bash-local（理由见文件头）
packages/fs-ssh/            # ctx.fs provider（helper 后端）
├── src/index.ts            # 一次往返的 listdir、带上限的流式读、原子发布 + CAS
├── src/text.ts             # 二进制拒绝、严格 UTF-8、跨 chunk 流式解码、CRLF 保真
├── src/edit.ts             # 字面替换（不经模式解释）、guard 语义、匹配计数
├── src/paths.ts            # target key 身份、containment、file: 编码、显示路径
└── src/errors.ts           # 唯一错误漏斗：已编码透传 → abort 优先 → errno → IO 兜底
packages/ssh-gui/           # 用户层（fork 自 UynajGI/dsh-ssh，MIT）
├── src/web.ts              # /dsh-ssh RPC 通道宿主面（inject=connection，loopback 围栏）
├── src/plugin.ts           # 组合 apply（= web.ts）；包根 index.ts 再透传 inject/Config
├── src/registry.ts         # 连接注册表（持久化 ~/.dsh/dsh-ssh-connections.json）
├── src/connection.ts       # ssh2 连接封装（ProxyJump、SFTP）
├── src/transport.ts        # ssh:// 路由解析与占位路径
├── src/helper-session.ts   # GUI 连接上部署/启动 helper 通道
├── src/helper-router.ts    # cwd → 连接的会话级路由（懒挂载每连接 helper）
├── src/picker.ts           # SFTP 目录选择后端（未挂；见诚实清单）
├── src/client/             # React 侧边栏 + 远程浏览器（flow/form/ui/icons/index）
├── lib/client.js(+map)     # 构建产物（client-modules 服务这个文件）
└── cordis.gui.patch.yml    # GUI-only 组合层（禁默认 picker 表面、挂 browse 后端、ssh 根行）
cordis.patch.yml            # 组合：两个 seam 一起换、sandbox/permission 行下掉、shell 按目标机选、GUI 行挂包根
tests/composition.test.ts   # patch 的行 id 与 one-world 不变量的回归守卫
tests/client-bundle.smoke.ts# lib/client.js 的 wire 格式 + 实例化回归守卫
scripts/test.mjs            # 本地套件统一入口
scripts/build-gui-client.mjs# 用 harness 的 tsdown client 管线重建 lib/client.js
scripts/fetch-deps.mjs      # 不用 npm 的依赖安装器
scripts/fetch-repo.mjs      # 参考实现下载器（.reference/<owner>__<repo>/）
.reference/                 # 四个现有实现的源码副本，审计引用的行号以此为准
```

client 侧一旦改了 `packages/ssh-gui/src/client/*`，重建并冒烟：

```powershell
node .\scripts\build-gui-client.mjs     # 临时宿主进 checkout → tsdown → 拷回 lib/ → 清理
node .\tests\client-bundle.smoke.ts
```

## 尚未交付（诚实清单）

- **浏览器内渲染确认** —— bundle 已构建、boot 图已含 `dsh-ssh-gui`、`/plugins/...` 已 200
  服务（独立 profile 实例上验证过）；还差你在自己实例里打开「选择工作区目录」的肉眼确认。
- **`spawnTerminal`** —— seam 里无条件抽象、不许拒绝，但忠实实现需要 helper 的 PTY 子面
  （`pty.openpty` + `tcgetpgrp` + `/proc/<pid>/wchan`）。当前**明确抛错并说明缺什么**，
  而不是用 shell 管道假装终端（那会让 `isatty` 和前台组一起撒谎）。受影响的只有终端类功能。
- **picker 行（远程经 seam 浏览）** —— `dsh-ssh-gui/picker` 需要 `ctx.ssh` 提供上游连接
  owner 接口（`getSftp`/`endpoint`）；当前远程浏览走 /dsh-ssh 通道自己的 SFTP 端点。
- **断线重连** —— 连接断开后需要重启会话。
- **认证阶梯无密码回退** —— 目标机上的密钥行被删后，本地旧私钥认证失败不会自动落回密码
  （删掉 `~/.dsh/remote-ssh/<user>@<host>.key` 即可恢复）。
- **写入串行化只在进程内** —— 与 `fs-e2b` 同样的限制，远端没有 advisory lock；
  `editText` 的发布走 helper 的 compare-and-swap，把窗口压到最小但没有完全消除。
- **搜索段的真机验证** —— 目标机装上 ripgrep 后即可跑通（`remote-argv` 段会自动启用）。

## 为什么 helper 是必需的

SSH 协议本身表达不了这些，而两个 seam 的契约要求它们（逐条引用见 `specs/`）：
远端 pid/pgid、整棵进程树的存活、channel 关闭之后仍能发出的 `killpg`、
PTY 前台进程组（`tcgetpgrp`）与"正在等输入"的证明、`realpath -m`、
以及带 inode + 纳秒精度的新鲜度令牌。helper 只用 Python 3 标准库，不要求远端装 Node。
上游 dsh-ssh 的 B2/B3/B4/B5/B7 五条缺口全部源于"只用 SFTP + exec"这个约束，helper 正是解除它的那一层。

## 本机开发环境的三个坑（已绕过）

1. **npm CLI 不可用**（`npm -v` 之外全部失败）→ 用 `scripts/fetch-deps.mjs` 固定版本直取 tarball，
   用 Windows 内置 bsdtar 解包。
2. **tsx / esbuild 被沙箱挡住**（worker 的 `spawn` 得到 EPERM）→ 直接用 Node 24 内置的 TS 类型剥离
   （`node file.ts`），因此源码只用可擦除的 TS 语法，相对导入一律写全 `.ts` 后缀。
   `node -e "..."` 内联脚本也被拒，测试一律写成文件。
3. **out-of-tree 包解析不到 `@deepseek-ai/*`** → `node_modules/@deepseek-ai/` 下为每个需要的包建 junction
   指向 checkout 内的真实目录。Node 按 realpath 去重，所以 `Service` 类身份与 harness 进程内一致
   （这一点至关重要：vendoring 第二份 cordis 会让服务注册失败）。
   正式发布路径仍是文档里的 `dsh plugin add` + `link:`。

`ssh2` 是 CommonJS 且命名导出不可静态探测，一律用默认导入后解构。
