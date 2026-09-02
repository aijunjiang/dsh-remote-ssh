/**
 * `ctx.subprocess` over SSH, helper-backed.
 *
 * Mounted as a Cordis row, this publishes the subprocess seam so that every
 * tool built on it — bash, terminals, LSP launches, subagent processes — runs on
 * the target with no tool-level changes.
 *
 * What this provider does that a plain SFTP+exec implementation cannot:
 *
 *  * reports the child's **real remote pid and pgid**, so termination and
 *    diagnostics have something to name;
 *  * terminates **tree-scoped** by signalling the process group, and treats a
 *    quiescence proof — not a dispatched signal — as the exit condition;
 *  * writes output spills **on the target**, so a reported `spillPath` is
 *    openable by the tools that receive it;
 *  * translates the host-only spelling of the packaged ripgrep binary, so `glob`
 *    and `grep` keep working in a remote session.
 *
 * Deliberate limitation, stated rather than hidden: the host's sandbox policy
 * does not fence remote execution. A local `workspace-write` fence constrains
 * host paths, and this provider's world is another machine. The remote account's
 * own permissions are the fence there.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { RemoteProcessHandle } from './process.ts'
import type { HelperHost, RemoteSpawnRequest, StreamMode } from './process.ts'
import { ENV_PROBE_COMMAND, buildChildEnvironment, parseNulEnvironment } from './environment.ts'
import { resolveRemoteExecutable } from './resolve.ts'
import { isPackagedRipgrep, translateArgv } from '../../remote-argv/src/index.ts'
import { resolveRemoteRipgrep } from '../../remote-argv/src/ripgrep.ts'
import type { RouteMapping } from '../../remote-argv/src/index.ts'
import { SshHelperRouter } from '../../ssh-gui/src/helper-router.ts'
import type { HelperTransport } from '../../ssh-gui/src/helper-router.ts'

/** What this provider needs from the connection owner. */
export interface SshConnection extends HelperHost {
  /** Absolute remote workspace directory. */
  readonly cwd: string
  /** Run one command on the target and report its exit facts. */
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** Absolute path of a provider-owned runtime file on the target. */
  runtimePath(...segments: readonly string[]): string
}

/** Provider configuration. */
export interface Config {
  /**
   * Absolute remote path of ripgrep. Leave unset to discover it: `command -v rg`
   * first, then a previously staged copy.
   */
  ripgrepPath?: string
  /**
   * Host placeholder → remote path mappings, so a host path that reaches argv
   * (a search root, a tool-provided file argument) lands in the right world.
   */
  routes?: RouteMapping[]
}

/**
 * The subprocess service, extending the seam's own abstract base so service
 * identity and registration match the harness exactly (a structural stand-in
 * would be a second source of truth — the class of bug that already bit this
 * package once, when the client's wire shapes drifted from the helper's).
 */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']

  static Config: z<Config> = z.object({
    ripgrepPath: z.string(),
    routes: z.array(z.object({ hostPrefix: z.string(), remotePrefix: z.string() })).default([]),
  })

  private readonly config: Config
  private readonly live = new Set<RemoteProcessHandle>()
  private readonly router: SshHelperRouter
  /** Login-environment probes, cached per transport (one per connection). */
  private readonly probedEnv = new WeakMap<object, Promise<Record<string, string>>>()
  /** Ripgrep resolutions, cached per transport. */
  private readonly ripgrep = new WeakMap<object, Promise<string | undefined>>()
  private disposing = false

  constructor(ctx: Context, config: Config = {}) {
    // The base class registers this as `ctx.subprocess`.
    super(ctx)
    this.config = config
    this.router = new SshHelperRouter(ctx)
    ctx.effect(() => async () => await this.terminateAll(), 'ssh subprocess teardown')
  }

  /**
   * Terminate every managed tree and await real quiescence.
   *
   * This is the service's disposal body, exposed as a method because disposal
   * must be observable: an orphan left running on someone else's machine is the
   * failure this guards against, and a test has to be able to assert that
   * teardown does not return until the tree is actually gone.
   */
  async terminateAll(): Promise<void> {
    this.disposing = true
    const handles = [...this.live]
    for (const handle of handles) handle.terminate()
    await Promise.allSettled(handles.map(async (handle) => await handle.waitForExit()))
    this.live.clear()
  }

  private get connection(): SshConnection {
    return (this.ctx as unknown as { ssh: SshConnection }).ssh
  }

  /**
   * The target's login environment for one transport, probed once per
   * connection and cached.
   *
   * Probed rather than assumed: the base must be the TARGET's `PATH`, `HOME`, and
   * locale. The host's own environment belongs to the wrong machine.
   */
  private async remoteEnvFor(transport: HelperTransport): Promise<Record<string, string>> {
    let cached = this.probedEnv.get(transport)
    if (cached === undefined) {
      cached = transport.exec(ENV_PROBE_COMMAND).then((result) => {
        if (result.exitCode !== 0) {
          throw new Error(`subprocess-ssh: could not probe the remote environment (${ENV_PROBE_COMMAND} failed)`)
        }
        return parseNulEnvironment(result.stdout)
      })
      this.probedEnv.set(transport, cached)
    }
    return await cached
  }

  /** The default transport's login environment (for `resolveExecutable`). */
  private async remoteEnv(): Promise<Record<string, string>> {
    return await this.remoteEnvFor(this.connection)
  }

  /** Ripgrep on one transport's target, resolved once per connection. */
  private async remoteRipgrepFor(transport: HelperTransport): Promise<string | undefined> {
    let cached = this.ripgrep.get(transport)
    if (cached === undefined) {
      cached = resolveRemoteRipgrep({
        exec: (command) => transport.exec(command),
        ...(this.config.ripgrepPath === undefined ? {} : { configuredPath: this.config.ripgrepPath }),
        stagedPath: transport.runtimePath('bin', 'rg'),
      }).then((resolved) => resolved?.path)
      this.ripgrep.set(transport, cached)
    }
    return await cached
  }

  /** The default transport's ripgrep (for `resolveExecutable`). */
  private async remoteRipgrep(): Promise<string | undefined> {
    return await this.remoteRipgrepFor(this.connection)
  }

  /**
   * Resolve one command to an absolute path on the target.
   * @param command - program name or absolute remote path.
   * @param env - the environment the child will receive; its PATH is searched.
   * @param signal - optional cancellation.
   * @returns the absolute remote path.
   */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    // A host-only ripgrep spelling is not missing — it is in the wrong world.
    if (isPackagedRipgrep(command)) {
      const remote = await this.remoteRipgrep()
      if (remote !== undefined) return remote
    }
    const path = env?.PATH ?? (await this.remoteEnv()).PATH
    return await resolveRemoteExecutable((command) => this.connection.exec(command), command, {
      ...(path === undefined ? {} : { path }),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /**
   * Start one process on the target.
   *
   * Synchronous by contract: the handle is returned immediately and its remote
   * identity arrives later (`RemoteProcessHandle.whenStarted`). A spawn-level
   * failure surfaces as `pid === -1` plus a rejected `done`, never as a throw
   * from here — except for the argument validation the seam performs eagerly.
   *
   * @param spec - the fully specified spawn request.
   * @returns a live handle over the remote process tree.
   */
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | 'pipe' | { data: string }; stdout: StreamMode; stderr: StreamMode }
    env?: Record<string, string | undefined> | undefined
    graceMs: number
    signal?: AbortSignal | undefined
  }): RemoteProcessHandle {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess graceMs must be a positive finite number')
    }
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }

    // The request is assembled asynchronously (environment probe, ripgrep
    // resolution, argv translation) but the handle must exist now, so the
    // handle owns a lazily-resolved request. The caller cwd decides the machine:
    // `ssh://<id>/<path>` (or its local placeholder) routes to that registry
    // connection's helper session; anything else stays on the default.
    const route = this.router.resolveCwd(spec.cwd)
    const handle = new RemoteProcessHandle(route.transport, {
      argv: spec.argv,
      cwd: route.base,
      env: {},
      stdin: spec.stdio.stdin,
      stdout: spec.stdio.stdout,
      stderr: spec.stdio.stderr,
      graceMs: spec.graceMs,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      prepare: async (request: RemoteSpawnRequest) => await this.prepare(request, spec.env, route.transport),
    })
    this.live.add(handle)
    const release = () => void this.live.delete(handle)
    void handle.done.then(release, release)
    return handle
  }

  /**
   * Complete a spawn request in the remote world: probe the environment ON THE
   * ROUTED TRANSPORT, layer the spec's explicit entries, and translate any
   * host-world argv element.
   */
  private async prepare(
    request: RemoteSpawnRequest,
    explicit: Record<string, string | undefined> | undefined,
    transport: HelperTransport,
  ): Promise<RemoteSpawnRequest> {
    const env = buildChildEnvironment(await this.remoteEnvFor(transport), explicit)
    const ripgrep = isPackagedRipgrep(request.argv[0] ?? '') ? await this.remoteRipgrepFor(transport) : undefined
    const translated = translateArgv(request.argv, {
      ...(ripgrep === undefined ? {} : { remoteRipgrep: ripgrep }),
      routes: this.config.routes ?? [],
    })
    return { ...request, argv: translated.argv, env }
  }

  /**
   * Terminal allocation over SSH.
   *
   * The seam declares this unconditionally abstract with no capability probe and
   * no "unsupported" convention
   * (`packages/subprocess/subprocess/src/index.ts:139`), so a provider may not
   * decline it. It is **not implemented in this increment**: a faithful
   * implementation needs the helper's PTY subsurface (`pty.openpty`, plus
   * `tcgetpgrp` and `/proc/<pid>/wchan` for the foreground-group facts the
   * contract wants), and shipping a shell-pipe imitation would misreport
   * `isatty` and foreground state rather than fail honestly.
   *
   * @throws always, naming what is missing.
   */
  async spawnTerminal(): Promise<never> {
    throw new Error(
      'subprocess-ssh: spawnTerminal is not implemented yet (the helper PTY subsurface is pending). '
        + 'Terminal-backed features are unavailable on this connection; ordinary spawns are unaffected.',
    )
  }
}

export default SshSubprocessRuntime
