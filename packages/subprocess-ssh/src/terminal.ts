/**
 * Terminal allocation over SSH, backed by the helper's `pty_*` operation family.
 *
 * A terminal is not a pipe. `isatty()` on the child's stdio, the foreground
 * process group, a window-size change that reaches the running application, and
 * the input-wait fact all require a real PTY pair on the TARGET — the host has
 * no standing to answer any of them for another machine. The helper therefore
 * owns the PTY (`pty_spawn` … `pty_kill`) and this class is the client-side
 * façade that satisfies {@link SubprocessTerminalHandle}.
 *
 * Observable limits, stated rather than hidden:
 *
 *  - `pid` is the REMOTE process id, meaningful inside the SSH host's pid
 *    namespace only. Nothing on the host can signal it directly.
 *  - `inspectActivity` answers from the helper's foreground evidence. A target
 *    without `/proc` (or a shell not parked in a known read) reports `unknown`
 *    rather than guessing `idle`: an unprovable fact is not reported as proven.
 *  - Killing the terminal signals the whole process GROUP on the target, so a
 *    shell's background jobs do not outlive the tab.
 *
 * @module
 */

import { Readable } from 'node:stream'
import type {
  SubprocessOutcome,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import type { HelperHost } from './process.ts'

/** What one PTY allocation needs from the caller. */
export interface RemoteTerminalSpec {
  /** Program and arguments; `argv[0]` is the program. */
  argv: readonly string[]
  /** Absolute remote working directory. */
  cwd: string
  /** Complete environment, already scrubbed for the remote world. */
  env: Readonly<Record<string, string>>
  /** Initial terminal geometry. */
  rows: number
  cols: number
  /** Terminal emulation advertised to the child as `TERM`. */
  terminalType: string
  /** TERM-to-KILL cleanup grace for the whole terminal session. */
  graceMs: number
  /** Cancellation of allocation; a published handle owns its later lifetime. */
  signal?: AbortSignal | undefined
}

/** The helper's reply to `pty_spawn`. */
interface PtySpawnReply {
  pid: number
  pgid: number
}

/**
 * One live terminal on the SSH target.
 *
 * Allocation is asynchronous (the helper must open the PTY and fork), but the
 * caller receives the handle synchronously, so the handle owns a lazily
 * resolved allocation: `output` is a stream that starts empty and is fed once
 * the helper answers.
 */
export class RemoteTerminalHandle implements SubprocessTerminalHandle {
  private readonly outputStream: Readable
  private readonly exited: Promise<SubprocessOutcome>
  private resolveExit!: (outcome: SubprocessOutcome) => void
  private rejectExit!: (error: Error) => void
  private registration: { handle: string; release(): void } | undefined
  private remotePid = 0
  private remotePgid = 0
  private terminated = false
  /** Bumped on every observable change so `inspectActivity` can report a revision. */
  private revision = 0

  constructor(private readonly host: HelperHost, private readonly spec: RemoteTerminalSpec) {
    this.outputStream = new Readable({ read() {} })
    this.exited = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.resolveExit = resolve
      this.rejectExit = reject
    })
    void this.allocate()
  }

  /** The remote process id (valid inside the SSH host only). */
  get pid(): number {
    return this.remotePid
  }

  /** The remote process-group id, the unit every signal targets. */
  get pgid(): number {
    return this.remotePgid
  }

  /** Terminal output bytes in delivery order; ends after the exit is reported. */
  get output(): Readable {
    return this.outputStream
  }

  /** Resolves when the target's top-level terminal process exits. */
  get done(): Promise<SubprocessOutcome> {
    return this.exited
  }

  /**
   * Claim the helper's PTY and wire its events to this handle.
   *
   * On failure the allocation rejects `done` instead of throwing into the
   * constructor: the seam returns a handle, and a terminal that could not be
   * allocated is a terminal that failed, not a call that fails.
   */
  private async allocate(): Promise<void> {
    const registration = this.host.registerProcess({
      onData: (_stream, chunk) => {
        this.revision += 1
        this.outputStream.push(chunk)
      },
      onEof: () => {
        this.outputStream.push(null)
      },
      onExit: (exitCode, signal) => {
        this.outputStream.push(null)
        this.registration?.release()
        this.resolveExit({
          exitCode: exitCode ?? 0,
          signal: signal ?? null,
        } as SubprocessOutcome)
      },
      onGone: () => {
        this.outputStream.push(null)
        this.registration?.release()
        this.rejectExit(new Error('subprocess-ssh: the SSH helper session ended with the terminal still running'))
      },
    })
    this.registration = registration
    try {
      const reply = await this.host.send('pty_spawn', {
        handle: registration.handle,
        argv: [...this.spec.argv],
        cwd: this.spec.cwd,
        env: { ...this.spec.env },
        rows: this.spec.rows,
        cols: this.spec.cols,
        term: this.spec.terminalType,
      }) as PtySpawnReply
      this.remotePid = reply.pid
      this.remotePgid = reply.pgid
      if (this.spec.signal?.aborted === true) await this.terminate()
    } catch (error) {
      registration.release()
      this.outputStream.push(null)
      const failure = error instanceof Error ? error : new Error(String(error))
      this.rejectExit(failure)
      // `output` already ended, so a consumer awaiting `done` sees the reason;
      // the rejection is also surfaced through `done` itself.
      this.terminated = true
    }
  }

  /** @param data - text to deliver without newline conversion. */
  async write(data: string): Promise<void> {
    if (this.terminated || this.registration === undefined) return
    await this.host.send('pty_write', {
      handle: this.registration.handle,
      b64: Buffer.from(data, 'utf8').toString('base64'),
    })
  }

  /**
   * @param cols - positive terminal column count.
   * @param rows - positive terminal row count.
   */
  async resize(cols: number, rows: number): Promise<void> {
    if (this.terminated || this.registration === undefined) return
    await this.host.send('pty_resize', {
      handle: this.registration.handle,
      rows: Math.max(2, Math.floor(rows)),
      cols: Math.max(2, Math.floor(cols)),
    })
  }

  /** @returns the remote foreground group and its input-wait fact, or undefined when unresolvable. */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.terminated || this.registration === undefined) return undefined
    try {
      const reply = await this.host.send('pty_foreground', { handle: this.registration.handle }) as {
        foreground: { pgid: number; inputWaiting: boolean } | null
      }
      if (reply.foreground === null) return undefined
      return { processGroupId: reply.foreground.pgid, inputWaiting: reply.foreground.inputWaiting }
    } catch {
      return undefined
    }
  }

  /** @returns the helper's activity verdict; `unknown` when it cannot prove one. */
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    if (this.terminated || this.registration === undefined) {
      return { state: 'unknown', revision: this.revision }
    }
    try {
      const reply = await this.host.send('pty_activity', { handle: this.registration.handle }) as {
        state: 'idle' | 'busy' | 'unknown'
      }
      return { state: reply.state, revision: this.revision }
    } catch {
      return { state: 'unknown', revision: this.revision }
    }
  }

  /**
   * @param signal - permitted terminal signal.
   * @returns the remote process-group id that received it.
   */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (this.terminated || this.registration === undefined) return 0
    const reply = await this.host.send('pty_kill', {
      handle: this.registration.handle,
      signal: signalToNumber(signal),
    }) as { delivered: number }
    return reply.delivered
  }

  /**
   * Terminate the terminal and everything in its group on the target.
   *
   * SIGHUP goes first — the terminal's own hangup semantics, which lets a shell
   * run its exit traps — then SIGKILL after {@link RemoteTerminalSpec.graceMs}
   * so a process that ignores the hangup cannot survive the tab.
   */
  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    const registration = this.registration
    if (registration === undefined) return
    const hard = (): void => {
      void this.host.send('pty_kill', { handle: registration.handle, signal: 9, hard: true }).catch(() => {})
    }
    const timer = setTimeout(hard, Math.max(1, this.spec.graceMs))
    try {
      await this.host.send('pty_kill', { handle: registration.handle, signal: 1 })
      // Give the group a moment to leave on its own before escalating.
      await Promise.race([
        this.exited.then(() => undefined, () => undefined),
        new Promise<void>(resolve => setTimeout(resolve, Math.max(1, this.spec.graceMs))),
      ])
      if (this.outputStream.readableEnded === false) hard()
    } catch {
      hard()
    } finally {
      clearTimeout(timer)
      registration.release()
    }
  }
}

/** Map a permitted terminal signal onto its POSIX number. */
function signalToNumber(signal: SubprocessTerminalSignal): number {
  switch (signal) {
    case 'SIGINT': return 2
    case 'SIGTERM': return 15
    case 'SIGKILL': return 9
    case 'SIGHUP': return 1
    case 'SIGTSTP': return 20
    default: return 15
  }
}
