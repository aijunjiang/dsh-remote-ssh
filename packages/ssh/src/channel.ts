/**
 * Helper protocol framing and routing, independent of any transport.
 *
 * Extracted from the connection owner for one reason: this is the only part of
 * the SSH stack whose correctness does not depend on a live target, so it is the
 * only part that can be pinned by unit tests. TCP hands us arbitrary chunk
 * boundaries, and a router that mishandles a split line, a payload frame
 * arriving before its reply, or a channel death mid-flight fails in ways that
 * look like remote bugs.
 *
 * Invariants enforced here:
 *
 *  * A line is dispatched only when its terminating newline has arrived, so a
 *    frame split across chunks — or several frames in one chunk — is handled
 *    identically.
 *  * A malformed line is discarded with a log, never thrown: one corrupt frame
 *    must not tear down a working connection.
 *  * Every pending request settles exactly once. Channel death rejects all of
 *    them and is remembered, so a later request fails immediately instead of
 *    hanging forever.
 *  * Process listeners are registered before the spawn request is sent, because
 *    output can precede the reply and a dropped first chunk is unrecoverable.
 *
 * @module
 */

import { Buffer } from 'node:buffer'
import type { HelperErrorFrame, HelperFrame, HelperResults } from './protocol.ts'

/** Diagnostic severity the channel reports upward. */
export type HelperLogLevel = 'debug' | 'warn' | 'error'

/** Transport hooks the channel needs; a test supplies plain functions. */
export interface HelperChannelHooks {
  /** Write one complete line (newline included) to the helper's stdin. */
  write(line: string, callback: (error?: Error) => void): void
  /** Report a diagnostic. Optional so a transport may ignore them. */
  log?(level: HelperLogLevel, message: string): void
}

/** Listeners one spawned process handle receives. */
export interface SshProcessListeners {
  /** Raw output bytes for one stream, in delivery order. */
  onData(stream: 'out' | 'err', chunk: Buffer): void
  /** That stream reached EOF; both streams always report it. */
  onEof(stream: 'out' | 'err'): void
  /** Direct-child exit facts. `signal` is a POSIX number, not a name. */
  onExit(exitCode: number | null, signal: number | null): void
  /** The whole process group became quiescent — what `waitForExit` observes. */
  onGone(): void
  /**
   * The remote spill was discarded, so its path must stop being reported.
   * Optional: a consumer that never requested a spill cannot receive this.
   */
  onSpillLost?(reason: string): void
}

/** A coded failure reported by the remote helper. */
export class SshHelperError extends Error {
  /** errno name (`ENOENT`), `E2BIG` for a cap overflow, `EHELPER`, or `ENOSYS`. */
  readonly code: string
  /** Numeric errno when the helper had one. */
  readonly errno?: number

  constructor(frame: HelperErrorFrame, operation: string) {
    super(`dsh-ssh: ${operation} failed: ${frame.message}`)
    this.name = 'SshHelperError'
    this.code = frame.code
    this.errno = frame.errno
  }
}

/** Failure of the transport itself, distinct from a remote operation's failure. */
export class SshTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`dsh-ssh: ${message}`, options)
    this.name = 'SshTransportError'
  }
}

interface PendingRequest {
  operation: string
  resolve(value: unknown): void
  reject(error: Error): void
  onData?: (chunk: Buffer) => void
}

/** Routes helper frames between requests, streamed payloads, and process events. */
export class HelperChannel {
  private readonly hooks: HelperChannelHooks
  private readonly pending = new Map<number, PendingRequest>()
  private readonly processes = new Map<string, SshProcessListeners>()
  private buffer = ''
  private nextId = 1
  private failureCause: Error | undefined
  private readySeen = false
  private readyWaiters: { resolve(): void; reject(error: Error): void }[] = []
  private handleCounter = 0

  constructor(hooks: HelperChannelHooks) {
    this.hooks = hooks
  }

  /** The error that killed this channel, if any. */
  get failure(): Error | undefined {
    return this.failureCause
  }

  /** Number of requests awaiting a reply. Exposed for tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Await the helper's `ready` frame.
   *
   * A frame that already arrived resolves immediately, so the caller may attach
   * the transport first and await afterwards without a race.
   * @param timeoutMs - upper bound; a non-positive value waits forever.
   * @returns a promise settled by the frame, the timeout, or channel death.
   */
  async waitForReady(timeoutMs: number): Promise<void> {
    if (this.readySeen) return
    if (this.failureCause !== undefined) throw this.failureCause
    return await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.readyWaiters.push(waiter)
      if (timeoutMs <= 0) return
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((entry) => entry !== waiter)
        reject(new SshTransportError(`the remote helper did not report ready within ${timeoutMs}ms`))
      }, timeoutMs)
      // Settling through either path must clear the timer.
      const settle = (action: () => void) => () => {
        clearTimeout(timer)
        action()
      }
      waiter.resolve = settle(resolve)
      waiter.reject = settle(() => reject(this.failureCause ?? new SshTransportError('channel closed')))
    })
  }

  /**
   * Feed transport bytes in. Chunk boundaries are irrelevant.
   * @param chunk - bytes or text as they arrived.
   */
  consume(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /**
   * Send one request and await its terminal reply.
   * @param op - operation name from the helper protocol.
   * @param payload - operation fields, without `id` and `op`.
   * @param options - `onData` receives streamed payload chunks for `read`.
   * @returns the operation's result payload.
   * @throws {SshHelperError} when the helper reported a coded failure.
   * @throws {SshTransportError} when the channel is or becomes dead.
   */
  send<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options: { onData?: (chunk: Buffer) => void } = {},
  ): Promise<HelperResults[K]> {
    if (this.failureCause !== undefined) return Promise.reject(this.failureCause)
    const id = this.nextId
    this.nextId += 1
    return new Promise<HelperResults[K]>((resolve, reject) => {
      this.pending.set(id, {
        operation: String(op),
        resolve: resolve as (value: unknown) => void,
        reject,
        onData: options.onData,
      })
      // `op` is written last so a caller-supplied payload cannot shadow it.
      const line = `${JSON.stringify({ ...payload, id, op })}\n`
      this.hooks.write(line, (error?: Error | null) => {
        // Node's Writable callback convention is `undefined` on success; ssh2's
        // channel write uses `null`. Treating only `undefined` as success made
        // every ping "fail" with cause null — the write had actually succeeded.
        if (error === undefined || error === null) return
        this.pending.delete(id)
        reject(new SshTransportError(`failed to write the ${String(op)} request`, { cause: error }))
      })
    })
  }

  /**
   * Register listeners for one spawned process before spawning it.
   * @param listeners - per-handle event sink.
   * @returns the handle id to pass to `spawn`, and its disposer.
   */
  registerProcess(listeners: SshProcessListeners): { handle: string; release(): void } {
    this.handleCounter += 1
    const handle = `p${this.handleCounter}`
    this.processes.set(handle, listeners)
    return { handle, release: () => void this.processes.delete(handle) }
  }

  /**
   * Kill the channel: reject every pending request, remember why, and tell every
   * registered process that its tree is unobservable from now on.
   *
   * Idempotent, and safe to call from a transport `close` handler.
   * @param error - the cause to report.
   */
  fail(error: Error): void {
    this.failureCause ??= error
    for (const [id, request] of this.pending) {
      this.pending.delete(id)
      request.reject(error)
    }
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) waiter.reject(error)
    // A dead channel can no longer observe quiescence; reporting `gone` is the
    // honest terminal state, and it unblocks anything awaiting exit.
    for (const listeners of [...this.processes.values()]) listeners.onGone()
  }

  private dispatch(line: string): void {
    let frame: HelperFrame
    try {
      frame = JSON.parse(line) as HelperFrame
    } catch {
      this.hooks.log?.('warn', 'discarded a malformed helper frame')
      return
    }
    if (frame === null || typeof frame !== 'object') {
      this.hooks.log?.('warn', 'discarded a helper frame that was not an object')
      return
    }
    if ('ev' in frame) {
      this.dispatchEvent(frame)
      return
    }
    if (typeof frame.id !== 'number') {
      this.hooks.log?.('warn', 'discarded a helper reply with no request id')
      return
    }
    const request = this.pending.get(frame.id)
    // An unknown id is not an error: a cancelled or timed-out request may still
    // draw its reply, and dropping it is the correct response.
    if (request === undefined) return
    this.pending.delete(frame.id)
    if (frame.ok) {
      request.resolve(frame.result)
      return
    }
    request.reject(new SshHelperError(frame.error, request.operation))
  }

  private dispatchEvent(frame: Extract<HelperFrame, { ev: string }>): void {
    switch (frame.ev) {
      case 'ready': {
        this.readySeen = true
        const waiters = this.readyWaiters
        this.readyWaiters = []
        for (const waiter of waiters) waiter.resolve()
        return
      }
      case 'log': {
        const level: HelperLogLevel = frame.level === 'error' ? 'error' : frame.level === 'warn' ? 'warn' : 'debug'
        this.hooks.log?.(level, `helper: ${frame.message}`)
        return
      }
      case 'data': {
        if ('id' in frame) {
          // Payload for a streamed read; an absent request means it was dropped.
          this.pending.get(frame.id)?.onData?.(Buffer.from(frame.b64, 'base64'))
          return
        }
        this.processes.get(frame.h)?.onData(frame.s, Buffer.from(frame.b64, 'base64'))
        return
      }
      case 'eof': {
        this.processes.get(frame.h)?.onEof(frame.s)
        return
      }
      case 'exit': {
        this.processes.get(frame.h)?.onExit(frame.code, frame.signal)
        return
      }
      case 'gone': {
        this.processes.get(frame.h)?.onGone()
        return
      }
      case 'spill': {
        this.processes.get(frame.h)?.onSpillLost?.(frame.reason)
        return
      }
      default: {
        // An unknown event from a newer helper is ignored rather than fatal, so
        // a protocol addition cannot break an older client.
        return
      }
    }
  }
}
