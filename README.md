# dsh-remote-ssh

> English | [中文](docs/README.zh-CN.md)

Move the workspace's file IO and command execution onto an SSH target — while sessions, the web GUI, and `$DSH_HOME` stay on this machine. A DSH plugin set for **remote development over SSH**.

Manage connections and browse remote directories from the web GUI; each session routes to the host its working directory names, and several remote hosts can run side by side. Design notes, contracts, and audits live in [`DESIGN.md`](DESIGN.md) and [`specs/`](specs/). The **harness-fork patch** behind same-named remote workspace titles lives under [`harness-patches/`](harness-patches/README.md) — see [Issue #1](https://github.com/aijunjiang/dsh-remote-ssh/issues/1).

---

## Feature overview

| Capability | What it does |
|---|---|
| **SSH connection manager** | Add / test / remove connections in the web GUI: password, key, SSH agent, ProxyJump |
| **Remote directory browser** | Browse the target's tree in the GUI and adopt any directory as a workspace |
| **Per-session routing** | A session's working directory decides the machine: `ssh://<id>/<path>` and its local placeholder twin are equivalent; many remotes can run in parallel |
| **Remote fs/subprocess** (full mode) | `ctx.fs` / `ctx.subprocess` point at the remote host: git, tests, builds, reads and writes happen there |
| **Agent guidance** (built-in) | Routed sessions declare "which machine am I on" in the runtime context, plus a usage guide, `ssh_exec` / `ssh_route_status`, and `DSH_SSH_*` env vars — no more guessing from paths, no silent "empty project" mirrors |
| **Credentials stay local** | Passwords and identity keys only ever live under this machine's DSH home |

---

## Install

Prereqs: DSH (deepseek-harness) and Node ≥ 22 locally; an SSH account on the target with `python3` and `bash`.

### A. Official `dsh plugin add` (recommended — zero-flag startup)

The repository root IS the official bundle package (`dsh.bundle.patch` → the GUI user layer), applied at every boot:

```bash
dsh plugin --profile web add github:aijunjiang/dsh-remote-ssh
# or from a local checkout: dsh plugin --profile web add <this-repo-path>

pnpm dsh web          # no flags needed
```

> pnpm installs the root package (internal `@deepseek-ai` deps ride the DSH baseline as optional peers; only `ssh2` comes from npm) and auto-registers the bundle in the profile layer. Uninstall: `dsh plugin --profile web remove dsh-remote-ssh`.

### B. Local dev install script

```bash
git clone https://github.com/aijunjiang/dsh-remote-ssh && cd dsh-remote-ssh
node scripts/install.mjs        # links 4 packages + registers the GUI layer (idempotent)
# options: --home <dsh home> | --profile <name> (default web) | --remove
pnpm dsh web                    # zero flags
```

Startup modes:

```bash
# A. (default) SSH GUI user layer: connection manager + remote browser + agent
#    guidance/tools. Local fs/subprocess stays local.
pnpm dsh web

# B. Full remote workspace: move file IO AND command execution to the remote
#    (run on a dedicated instance, not your daily one)
export DSH_REMOTE_HOST=your-host
export DSH_REMOTE_USER=your-user
export DSH_REMOTE_PASSWORD=your-password      # first connect only; key auto-provisioned after
export DSH_REMOTE_CWD=/home/you/workspace
pnpm dsh web --patch <repo>/cordis.patch.yml
```

---

## Quick start (GUI)

1. Open the web GUI → **Connections** panel → **Add** a connection (host, account, auth), **Test** it.
2. Enter the connection, browse the remote tree, and "adopt as workspace" on the target directory.
3. Start a new session in that workspace.

The session is now **routed**: its runtime context shows e.g.

> This session's working directory is on SSH route `c1` (amax@192.168.10.125:22); its remote absolute path is /home/haitang/JunHeAssemblyLine.

…followed by a usage guide (when to use `ssh_exec`, that mirrors are untrusted, that `ssh_route_status` is the recovery tool, output caps, …). Just say "check this device's hardware" — the agent runs `ssh_exec` on the **remote** host.

### Same-named directories

Remote workspaces are unique by `route + remote absolute path`, so same-named directories on different devices/paths never collide. Workspace/session titles carry a human route suffix (connection label, else `user@host`):

```
JunHeAssemblyLine · amax@192.168.10.125     # on remote 192.168.10.125
JunHeAssemblyLine · amax@192.168.10.126     # on another remote
```

Give connections meaningful labels (e.g. `dev-server`) to control the suffix. The same rule applies to agents: the runtime context names the route and host directly, and `ssh_route_status` re-confirms it any time.

### Built-in agent capabilities

- **`ssh_exec`** — run one script on the session's route over the in-process ssh2/helper channel (no local ssh.exe, no quoting layers). Locale fixed to C; output capped at 256 KiB/stream with truncation marked; every result is verified against an **end sentinel** — a sentinel-verified empty output is genuinely empty, suspected lost output auto-retries once and reports loudly.
- **`ssh_route_status`** — route facts, known connections, manifest path; `checkLive: true` probes reachability.
- **Environment** — routed shells carry `DSH_SSH_ROUTE_ID / HOST / USER / PORT / REMOTE_CWD / ENDPOINT`.
- **Route manifest** — `<dsh home>/dsh-ssh-routes.json`, plain and secret-free, so "which host is c1" is answerable even offline.
- **Adaptive semantics** — in full mode your read/write/glob/grep hit the remote; in GUI-only mode they stay local and the guide says so (remote reads via `cat` / `sed -n`, never the local placeholder dirs).

---

## Full mode (move the local world to the remote)

`cordis.patch.yml` is a **one-way switch**, not an overlay:

- turns off local `subprocess`, `fs-sandbox`, `sandbox`, both sandboxed shells, the default directory chooser and permission presets;
- mounts remote `fs-ssh` / `subprocess-ssh` (incl. remote `shell`) plus the routing GUI layer;
- points `sandbox-policy.workspaceRoot` at `DSH_REMOTE_CWD`.

Environment:

| Variable | Meaning |
|---|---|
| `DSH_REMOTE_HOST` | target host (required) |
| `DSH_REMOTE_USER` | remote account (required) |
| `DSH_REMOTE_PASSWORD` | first connect only; a key is provisioned after |
| `DSH_REMOTE_PORT` | default 22 |
| `DSH_REMOTE_CWD` | remote working directory (default `/root/workspace`) |
| `DSH_REMOTE_RIPGREP` | optional absolute remote rg path (auto-discovered when unset) |

> One directory, one source: `cwd` and `sandbox-policy.workspaceRoot` both derive from `DSH_REMOTE_CWD`, so files and commands always name the same world.

---

## Security model (read this)

- **The remote account's own permissions are the only fence.** Full mode disables the local sandbox rows: whatever machine you hand files and commands to is a machine an agent operates as that account. Use a dedicated account, least privilege, rotated keys — or constrain reach via ProxyJump.
- Connection passwords/keys live only in `<dsh home>/dsh-ssh-connections.json` and the identity dir; the route manifest contains no secrets.
- GUI-only mode leaves the local file/command world untouched — start there before full mode.

---

## Limitations (honest)

- **GUI-only mode does not move fs/subprocess**: files/commands stay local; `dsh-ssh-routes/...` are placeholder dirs (the agent guide says so).
- **No PTY yet**: `spawnTerminal` is unavailable on remote connections (helper PTY subsurface pending); ordinary spawns are unaffected.
- `ssh_exec` calls are serialized per step; run multiple commands inside one call.
- Remote `read` has no line numbers; window big files with `sed -n`.
- Remote execution needs the Python helper on the target (auto-deployed to the account home on first use).

---

## Repository layout

```
package.json               # official root bundle package (dsh.bundle.patch → bundle.gui.patch.yml)
bundle.gui.patch.yml       # official GUI user layer (auto-applied by dsh plugin add)
src/index.ts               # official root entry (re-exports the ssh-gui plugin surface)
lib/client.js              # official root client bundle (id dsh-remote-ssh)
cordis.patch.yml           # full-mode composition (one-world switch + remote rows)
harness-patches/           # harness-fork patch + apply/rebuild README (Issue #1)
packages/
  ssh/                     # connection owner: auth ladder, key provisioning, helper channel & protocol
  fs-ssh/                  # ctx.fs → remote filesystem (single-trip listings, capped reads, CAS writes)
  subprocess-ssh/          # ctx.subprocess → remote processes (real pid/pgid, tree-scoped kill, target-side spills)
  remote-argv/             # remote rg/grep argv translation
  ssh-gui/                 # GUI: registry / /dsh-ssh RPC / sidebar / React bundle + agent experience
scripts/
  install.mjs              # local dev install (links + profile auto-register; --remove)
  build-gui-client.mjs     # rebuild client bundles (dev id dsh-ssh-gui / official id dsh-remote-ssh)
  test.mjs                 # all local tests: node scripts/test.mjs
specs/ DESIGN.md           # contracts, audits, design rationale
```

Development, tests, bundle building and design rationale: [`DESIGN.md`](DESIGN.md); upstream-fork differences: `specs/upstream-dsh-ssh-audit.md`. Sidebar & browser are a fork of `UynajGI/dsh-ssh` (MIT). The same-name-title harness patch: [`harness-patches/`](harness-patches/README.md) / [Issue #1](https://github.com/aijunjiang/dsh-remote-ssh/issues/1).

---

## License

[MIT](LICENSE)
