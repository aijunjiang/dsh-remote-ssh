# Changelog

Notable changes to `dsh-remote-ssh`. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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
