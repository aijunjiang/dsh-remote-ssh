# Changelog

Notable changes to `dsh-remote-ssh`. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — 2026-11-11

### Fixed

- **Background jobs work on DSH 0.2.x again.** `ssh_exec` passed the whole
  *agent object* as `JobSpec.owner`, but 0.2.x resolves `owner` as a **session
  id** against its live-agent registry. Every registration therefore failed
  with ``session "[object Object]" has no live agent (background job owner must
  be live)`` — and because explicit daemonization (`setsid` / `nohup` /
  `disown`) auto-registers, *every* detaching spelling was blocked, leaving
  only foreground calls. The owner is now the session id string.
- **The job log is no longer empty.** `JobSpec.output` was never supplied, so
  `job_output` and the header log read an empty ring even though the job was
  producing output. The remote job hooks now publish a live pull source that
  fans out the same bytes the completion-notice tail keeps, and the creating
  tool call is recorded (`JobSpec.toolCall`).
- **A refused registration is reported, not hidden.** The registry's refusal
  (no live owner agent, per-owner job limit, no attached controller) is now
  named verbatim and labelled a DSH bookkeeping limitation instead of coming
  back as a bare `ssh_exec failed: …`. The command itself is still started —
  detached (`nohup`, stdin cut, output to `.dsh-detach-*.log`, pid in
  `.dsh-detach-*.pid`, POSIX-portable, no `setsid` needed) — so a long task is
  never lost to a bookkeeping failure. The tool description and the runtime
  usage guide now say "prefer `background: true`; detach by hand only when the
  tool says the job could not be registered", instead of teaching the manual
  detach as the primary channel.
- **`ssh_job action: read` joins ring chunks.** 0.2.x answers a read with
  `{ chunks: [{ text }] }`, not a pre-joined `text`; both shapes are accepted.
- **The workspace-directory picker scrolls.** In the picker's right pane the
  directory list had no working scroll region: `.main` was a flex column
  without `min-height: 0` and `.browser` carried a `min-height: 200px` floor
  that beat its shrink factor, so a directory ranked below the fold was
  unreachable (no scrollbar, no way to reach it). `.main` is now a bounded
  column, `.browser` is the one scrolling region (`min-height: 0`,
  `overflow-y: auto`, `overscroll-behavior: contain`), and the breadcrumb bar
  no longer shrinks away. The shipped `lib/client.js` bundles were rebuilt from
  the patched CSS.

## [0.4.0] — 2026-11-11

Targets **DSH 0.2.x** (verified on `0.2.2-rc.1`) while staying compatible with
the 0.1.x line.

### Added

- **PTY on the target.** `ctx.subprocess.spawnTerminal` now allocates a real
  pseudo-terminal through the helper's new `pty_*` operation family
  (`pty_spawn`, `pty_write`, `pty_resize`, `pty_foreground`, `pty_activity`,
  `pty_kill`). Interactive shells get job control, resize reaches the running
  application, and `isatty()` is genuinely true — none of which a shell-pipe
  imitation can report honestly. This removes the provider's last
  "not implemented" seam.
- **Workspace host labels.** Each SSH-routed Workspace has its host written into
  its title at boot (`🌐 user@host · name`). DSH 0.2.x stores no remote field per
  Workspace and the header row exposes no slot, so the title is the one place
  this can persist and stay visible. Idempotent: a title already carrying the
  marker is rebuilt from its base, and a hand-written `name · user@host` suffix
  is recognised rather than duplicated.

### Changed

- `terminalEnvironment` answers from the **target** (`uname -s`, `$SHELL`, then
  the passwd entry) instead of reporting the host's own `process.platform`,
  which says nothing about the machine a terminal will run on.
- `spawn` publishes `stdout` / `stderr` as live streams for a `'pipe'` request
  and leaves them undefined otherwise, exactly as the seam specifies. `control`
  is `undefined`: the helper protocol has no duplex channel.
- `Outcome.signal` is typed `NodeJS.Signals`. A signal number outside Node's
  table still reports as `SIG<n>` rather than null.
- Environment and ripgrep probes resolve the default **transport** through the
  router instead of reading `ctx.ssh` directly. A connection owns the ssh2 client
  and the SFTP channel; a transport is the helper session on top of it, and only
  the latter answers `request` / `send` / `registerProcess` / `runtimePath`.

### Removed

- The `ssh-gui` runtime invariant companion and its two dependency
  declarations. DSH 0.2.x removed `@deepseek-ai/dsh-invariants` along with the
  `ctx.invariants` service and every `./invariant` subpath, so a row naming it
  would fail to load. The companion was an empty check — connection, process and
  terminal teardown each have a single ready promise and nothing to cross-check —
  so no behaviour is lost.

### Fixed

- A refused workspace rename no longer disturbs the boot: the label is cosmetic
  and failures are logged, not thrown.

## [0.3.3] — previous

See the repository history.
