/**
 * One remote process tree: lifetime, exit facts, and tree-scoped termination.
 *
 * The contract this satisfies (`packages/subprocess/subprocess/src/types.ts:158-193`)
 * differs from what an SSH channel can express, and every gap here is closed by
 * the helper rather than approximated:
 *
 *  * **Termination is tree-scoped.** Upstream `dsh-ssh` sends
 *    `session.signal('TERM')` (`subprocess.js:229-235` in the published build),
 *    which many OpenSSH servers silently ignore and which never reaches a
 *    descendant. Here the helper `killpg`s the group, and the escalation's exit
 *    condition is a **quiescence proof** (`killpg(pgid, 0)` → ESRCH), not the
 *    fact that a signal was dispatched.
 *  * **`done` vs `waitForExit`.** `done` reports the direct child's exit facts;
 *    `waitForExit` resolves only once the whole group is gone, so a surviving
 *    watcher is observable before teardown returns.
 *  * **A spawn-level failure is not a throw.** `pid` stays -1 and `done`
 *    rejects — the only reason `done` may reject (`types.ts:168,178`).
 *  * **Abort is termination, not disconnection.** The spec's signal runs the same
 *    escalation and must not reject `done` (`types.ts:91-94`).
 *
 * @module
 */

import { Buffer } from 'node:buffer'
import { Writable } from 'node:stream'
import { OutputCollector } from './output.ts'
import type { CollectLimits, OutputRead } from './output.ts'

/** Exit facts, mirroring the seam's `SubprocessOutcome`. */
export interface ProcessOutcome {
  exitCode: number | null
  signal: string | null
}

/** Per-stream disposition this handle understands. */
export type StreamMode = 'pipe' | 'inherit' | CollectLimits

/** What the handle needs from a helper connection; `HelperChannel` satisfies it. */
export interface HelperHost {
  send(op: string, payload: object): Promise<unknown>
  registerProcess(listeners: {
    onData(stream: 'out' | 'err', chunk: Buffer): void
    onEof(stream: 'out' | 'err'): void
    onExit(exitCode: number | null, signal: number | null): void
    onGone(): void
    onSpillLost?(reason: string): void
  }): { handle: string; release(): void }
}

/** A spawn request already translated into the remote world. */
export interface RemoteSpawnRequest {
  /** Program and arguments; passed to `execvp` with no shell in between. */
  argv: readonly string[]
  /** Absolute remote working directory. */
  cwd: string
  /** Complete, already-scrubbed environment; applied with `env -i` semantics. */
  env: Readonly<Record<string, string>>
  stdin: 'ignore' | 'pipe' | { data: string }
  stdout: StreamMode
  stderr: StreamMode
  /** TERM→KILL interval, and the post-exit drain bound for collect pipes. */
  graceMs: number
  /** Caller cancellation; triggers the same escalation as `terminate()`. */
  signal?: AbortSignal | undefined
  /**
   * Completes the request in the remote world just before it is sent: probing
   * the target's environment, resolving ripgrep, translating host-world argv.
   *
   * It exists because `spawn` is synchronous by contract while those steps are
   * not. A rejection here is a spawn-level failure, which is the correct
   * classification: nothing ran.
   */
  prepare?: (request: RemoteSpawnRequest) => Promise<RemoteSpawnRequest>
}

/** POSIX signal numbers → names, for mapping the helper's `waitpid` result. */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  13: 'SIGPIPE',
  15: 'SIGTERM',
  19: 'SIGSTOP',
}

/** Map a numeric signal to its name, keeping the number when unknown. */
export function signalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `SIG${signal}`
}

/** Offset-based reader over one collected stream. */
export interface OutputReader {
  readFrom(fromByte: number): OutputRead
}

/**
 * A live remote process tree.
 *
 * Construction is synchronous — the seam's `spawn` returns a handle, not a
 * promise — while the remote spawn is inherently asynchronous. `pid` is
 * therefore -1 until the helper's reply lands; `whenStarted` exposes that moment
 * for callers that need it (a terminal, or a test).
 */
export class RemoteProcessHandle {
  readonly stdin: Writable | undefined
  readonly collected: { stdout?: OutputReader; stderr?: OutputReader }
  readonly done: Promise<ProcessOutcome>
  /** Resolves with the tree's identity once the helper has spawned it. */
  readonly whenStarted: Promise<{ pid: number; pgid: number }>

  private readonly host: HelperHost
  private readonly request: RemoteSpawnRequest
  private readonly registration: { handle: string; release(): void }
  private readonly collectors = new Map<'out' | 'err', OutputCollector>()
  private pidValue = -1
  private pgid = -1
  private outcome: ProcessOutcome | undefined
  private settleDone!: (outcome: ProcessOutcome) => void
  private failDone!: (error: Error) => void
  private resolveDone!: (outcome: ProcessOutcome) => void
  private settleStarted!: (identity: { pid: number; pgid: number }) => void
  private failStarted!: (error: Error) => void
  private goneWaiters: (() => void)[] = []
  private isGone = false
  private terminating = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private escalation: Promise<void> | undefined

  constructor(host: HelperHost, request: RemoteSpawnRequest) {
    this.host = host
    this.request = request
    // `done` must not resolve before the process identity exists: a caller that
    // awaits `done` and then reads `handle.pid` must see the real pid. A fast
    // command (printf, true) can exit before the spawn REPLY arrives — the exit
    // event and the reply race on the wire — so `done` is gated on the reply.
    this.whenStarted = new Promise<{ pid: number; pgid: number }>((resolve, reject) => {
      this.settleStarted = resolve
      this.failStarted = reject
    })
    const identity = this.whenStarted.then(() => undefined, () => undefined)
    this.done = new Promise<ProcessOutcome>((resolve, reject) => {
      this.settleDone = resolve
      this.failDone = reject
      // Both `onExit` (the happy path) and `markGone` (the no-exit-frame path)
      // call `resolveDone`, which waits for the identity before settling.
      this.resolveDone = (outcome) => void identity.then(() => this.settleDone(outcome))
    })
    void this.whenStarted.catch(() => {})
    // A rejected start must not surface as an unhandled rejection for callers
    // that only ever await `done`.
    void this.whenStarted.catch(() => {})

    for (const stream of ['out', 'err'] as const) {
      const mode = stream === 'out' ? request.stdout : request.stderr
      if (typeof mode === 'object') this.collectors.set(stream, new OutputCollector(mode))
    }
    this.collected = {}
    const out = this.collectors.get('out')
    const err = this.collectors.get('err')
    if (out !== undefined) this.collected.stdout = out
    if (err !== undefined) this.collected.stderr = err

    // Listeners are registered BEFORE the spawn request is sent: the helper may
    // relay output before the reply arrives, and a dropped first chunk cannot be
    // recovered.
    this.registration = host.registerProcess({
      onData: (stream, chunk) => this.onData(stream, chunk),
      onEof: () => {},
      onExit: (exitCode, signal) => this.onExit(exitCode, signal),
      onGone: () => this.onGone(),
      // The helper deleted the file; every reader must stop advertising it, or
      // the model receives a path that no longer exists.
      onSpillLost: () => {
        for (const collector of this.collectors.values()) collector.markSpillLost()
      },
    })

    this.stdin = request.stdin === 'pipe' ? this.createStdin() : undefined
    void this.start()

    if (request.signal !== undefined) {
      if (request.signal.aborted) this.terminate()
      else request.signal.addEventListener('abort', () => this.terminate(), { once: true })
    }
  }

  /** Process id of the tree root; -1 before the spawn reply and after a failure. */
  get pid(): number {
    return this.pidValue
  }

  /**
   * Begin (or continue) the tree-scoped TERM → grace → KILL escalation.
   *
   * Idempotent and never throws: a signal that cannot be delivered is not an
   * error, because the only authority on success is the quiescence proof.
   */
  terminate(): void {
    if (this.isGone || this.terminating) return
    this.terminating = true
    this.escalation = this.escalate().catch(() => {})
  }

  /**
   * Wait for the whole tree to exit.
   * @param signal - optional bound for the wait.
   * @returns true when the tree exited, false when `signal` aborted first.
   */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.isGone) return true
    if (signal?.aborted === true) return false
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const waiter = () => finish(true)
      this.goneWaiters.push(waiter)
      if (signal === undefined) return
      signal.addEventListener(
        'abort',
        () => {
          this.goneWaiters = this.goneWaiters.filter((entry) => entry !== waiter)
          finish(false)
        },
        { once: true },
      )
    })
  }

  private async start(): Promise<void> {
    const spill = this.spillRequest()
    try {
      // Everything that needs a round trip happens here, not in `spawn`: the
      // seam requires a synchronous handle, and a rejection at this point is
      // correctly classified as a spawn-level failure.
      const effective =
        this.request.prepare === undefined ? this.request : await this.request.prepare(this.request)
      const reply = (await this.host.send('spawn', {
        handle: this.registration.handle,
        argv: [...effective.argv],
        cwd: effective.cwd,
        env: effective.env,
        stdin: this.request.stdin === 'ignore' ? 'ignore' : 'pipe',
        ...(spill === undefined ? {} : { spill }),
      })) as { pid: number; pgid: number }
      this.pidValue = reply.pid
      this.pgid = reply.pgid
      this.settleStarted({ pid: reply.pid, pgid: reply.pgid })
      // `{ data }` is the batch shape: write the bytes, then EOF. The channel
      // itself must stay open, or the exit status is lost with it.
      const stdin = this.request.stdin
      if (typeof stdin === 'object') {
        await this.host.send('stdin', {
          handle: this.registration.handle,
          dataB64: Buffer.from(stdin.data, 'utf8').toString('base64'),
          close: true,
        })
      }
      // No abort re-trigger is needed here: `escalate()` awaits `whenStarted`
      // before signalling, so a terminate() or abort that landed while the spawn
      // was in flight is already pending on the group id. Re-triggering would
      // start a SECOND escalation and send a duplicate TERM.
    } catch (error: unknown) {
      // A spawn-level failure: pid stays -1 and `done` rejects. This is the only
      // path allowed to reject `done`.
      this.pidValue = -1
      const cause = error instanceof Error ? error : new Error(String(error))
      this.failStarted(cause)
      this.failDone(cause)
      this.registration.release()
      this.markGone()
    }
  }

  private spillRequest(): { maxBytes: number; streams: Record<string, string> } | undefined {
    // Each stream's path is named explicitly here rather than derived remotely:
    // this side is what reports `spillPath`, so it must own the name. Paths are
    // REMOTE, so the reported value is openable by the tools that receive it.
    const streams: Record<string, string> = {}
    let maxBytes = 0
    for (const stream of ['out', 'err'] as const) {
      const mode = stream === 'out' ? this.request.stdout : this.request.stderr
      if (typeof mode !== 'object' || mode.spill === undefined) continue
      streams[stream] = mode.spill.path
      maxBytes = Math.max(maxBytes, mode.spill.maxBytes)
    }
    if (Object.keys(streams).length === 0) return undefined
    return { maxBytes, streams }
  }

  private createStdin(): Writable {
    return new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        this.host
          .send('stdin', { handle: this.registration.handle, dataB64: bytes.toString('base64') })
          .then(
            () => callback(),
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
          )
      },
      final: (callback) => {
        // `close: true` shuts the child's fd 0 — never the SSH channel, which
        // would take the exit status with it.
        this.host.send('stdin', { handle: this.registration.handle, close: true }).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        )
      },
    })
  }

  private onData(stream: 'out' | 'err', chunk: Buffer): void {
    this.collectors.get(stream)?.append(chunk)
  }

  private onExit(exitCode: number | null, signal: number | null): void {
    // A fast process can send `gone` (from the quiescence poll) before `exit`;
    // the default outcome that `markGone` may have settled must then be
    // overwritten with the REAL exit facts.
    if (this.outcome !== undefined && (this.outcome.exitCode !== null || this.outcome.signal !== null)) return
    this.outcome = {
      exitCode,
      signal: signal === null ? null : signalName(signal),
    }
    this.resolveDone(this.outcome)
  }

  private onGone(): void {
    this.markGone()
  }

  private markGone(): void {
    if (this.isGone) return
    this.isGone = true
    if (this.killTimer !== undefined) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    // A tree that vanished without an exit frame (helper death, channel loss)
    // still has to settle `done`, or an awaiting caller hangs forever.
    if (this.outcome === undefined) {
      this.outcome = { exitCode: null, signal: null }
      this.resolveDone(this.outcome)
    }
    this.registration.release()
    const waiters = this.goneWaiters
    this.goneWaiters = []
    for (const waiter of waiters) waiter()
  }

  /**
   * TERM the group, wait out the grace, then KILL — and keep going until the
   * helper proves the group is silent. Signal delivery failures are tolerated;
   * only the proof matters.
   */
  private async escalate(): Promise<void> {
    await this.sendSignal('TERM')
    if (this.isGone) return
    await new Promise<void>((resolve) => {
      this.killTimer = setTimeout(resolve, this.request.graceMs)
    })
    if (this.isGone) return
    await this.sendSignal('KILL')
    // The helper reports `gone` from its own quiescence poll; if the channel is
    // healthy that frame is the terminal proof, so nothing more is needed here.
  }

  private async sendSignal(signal: 'TERM' | 'KILL'): Promise<void> {
    if (this.pgid <= 1) {
      // No group to signal yet: the spawn reply has not landed. Wait for it so a
      // terminate() issued immediately after spawn cannot be lost.
      try {
        await this.whenStarted
      } catch {
        return
      }
    }
    if (this.isGone) return
    try {
      // The group id, not the handle: the group can outlive the direct child, and
      // signalling it is what makes termination tree-scoped.
      await this.host.send('kill', { pgid: this.pgid, signal })
    } catch {
      // Delivery failure is not authoritative; the quiescence proof is.
    }
  }
}
