/**
 * Model-facing remote command execution over one helper session.
 *
 * Uses the helper `spawn` machinery (not the connection's control-plane exec)
 * so an `ssh_exec` call gets the same guarantees the capability providers
 * built: a REAL remote pid/pgid, tree-scoped termination, and a quiescence
 * proof — never a guessed exit. Output is collected in memory under a hard cap
 * per stream; crossing the cap terminates the group and reports the loss
 * instead of silently truncating.
 * @module dsh-ssh-gui/remote-exec
 */

import { Buffer } from 'node:buffer'
import type { SshHelperSession } from './helper-session.ts'
import { SshHelperError, SshTransportError } from '../../ssh/src/channel.ts'

/** One completed remote command. */
export interface RemoteExecResult {
  /** Remote exit code, or null when the group was signalled. */
  exitCode: number | null
  /** POSIX signal number that ended the direct child, if any. */
  signal: number | null
  stdout: string
  stderr: string
  /** True when stdout hit the cap and was cut short (group terminated). */
  truncatedOut: boolean
  /** True when stderr hit the cap and was cut short (group terminated). */
  truncatedErr: boolean
  /** True when the caller's signal or the timeout ended the group. */
  timedOut: boolean
  /** The direct child's real remote pid and process-group id. */
  pid: number
  pgid: number
  /** Whether the end sentinel was observed on stdout (output integrity proof). */
  sentinelSeen: boolean
  /**
   * exit 0 with ZERO captured output on both streams, no truncation/timeout,
   * and NO end sentinel: the dangerous "looks like a legitimately empty
   * result" loss mode. Never treat that as an authoritative empty answer.
   */
  silentLoss: boolean
}

/** Options for one remote command. */
export interface RemoteExecOptions {
  /** The command string, run by the remote `bash -c`. */
  command: string
  /** Absolute POSIX working directory on the target. */
  cwd: string
  /** Upper bound per stream in bytes (default 256 KiB). */
  maxBytes?: number
  /** Extra environment entries layered over the remote login environment. */
  env?: Record<string, string>
  /** Kill the group when the caller aborts. */
  signal?: AbortSignal
}

/** Fallback PATH when the login environment has none. */
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** Grace between TERM and KILL when stopping an over-cap or cancelled group. */
const KILL_GRACE_MS = 2_000

/**
 * Wrap a caller command with an end sentinel so an empty result can be told
 * apart from a lost one: bash prints `<token>=<rc>` as its last stdout line.
 * The sentinel also survives pipes (`cmd | head`) — when head closes early,
 * bash dies on SIGPIPE BEFORE the sentinel, which is itself the signal that
 * the captured output is intentionally partial.
 */
export function buildWrappedCommand(command: string): { wrapped: string; token: string } {
  const token = `__DSHX_${Math.random().toString(36).slice(2, 10)}`
  const wrapped = [
    command,
    `__DSHX_RC=$?`,
    `printf '\\n${token}=%s\\n' "$__DSHX_RC"`,
    'exit "$__DSHX_RC"',
  ].join('\n')
  return { wrapped, token }
}

/**
 * Parse the sentinel out of captured stdout. The sentinel line is removed so
 * command output is returned unchanged when it is present.
 */
export function parseSentinelExit(
  output: string,
  token: string,
): { seen: boolean; exit: number | null; stdout: string } {
  const pattern = new RegExp(`\\n${token}=(\\d+)\\r?\\n?$`)
  const match = pattern.exec(output)
  if (match === null) return { seen: false, exit: null, stdout: output }
  return { seen: true, exit: Number(match[1]), stdout: output.slice(0, output.length - match[0].length) }
}

/**
 * Run one command to completion on the session's target.
 * @param session - the attached helper session for the route.
 * @param options - command, remote cwd, caps, and cancellation.
 * @returns collected output and process facts; the promise settles only after
 *   the whole process group is quiescent.
 * @throws {SshHelperError | SshTransportError} for transport/helper failures.
 */
export async function runRemoteCommand(
  session: SshHelperSession,
  options: RemoteExecOptions,
): Promise<RemoteExecResult> {
  await session.open()

  let login = session.loginEnvironment
  if (login === undefined) {
    const probe = await session.request('env', { login: true })
    login = probe.env
  }
  const env: Record<string, string> = {
    ...login,
    LC_ALL: 'C',
    PATH: login.PATH ?? DEFAULT_PATH,
    ...(options.env ?? {}),
  }

  const cap = options.maxBytes ?? 256 * 1024
  // End-sentinel wrapper: an exit-0 empty result is only trustworthy when the
  // sentinel line came back with it.
  const { wrapped, token } = buildWrappedCommand(options.command)
  const argv = ['bash', '-c', wrapped]
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let outBytes = 0
  let errBytes = 0
  let truncatedOut = false
  let truncatedErr = false
  let timedOut = false
  let exitCode: number | null = null
  let signal: number | null = null
  let pid = -1
  let pgid = -1
  let settled = false
  let killQueued = false
  let timedKill: ReturnType<typeof setTimeout> | undefined

  return await new Promise<RemoteExecResult>((resolvePromise, rejectPromise) => {
    // Holder indirection: listeners are defined before the registration exists,
    // but only settle paths read it, which always run after registration.
    const holder: { release(): void } = { release: () => undefined }
    const cleanup = (): void => {
      if (timedKill !== undefined) clearTimeout(timedKill)
      options.signal?.removeEventListener('abort', onAbort)
      holder.release()
    }
    const settle = (result: RemoteExecResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(result)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const sendKill = (signalName: 'TERM' | 'KILL'): void => {
      if (pgid < 0) {
        // Spawn has not answered yet; remember to kill as soon as it has.
        killQueued = true
        return
      }
      void session.request('kill', { pgid, signal: signalName }).catch(() => undefined)
    }
    const stopGroup = (): void => {
      if (settled) return
      sendKill('TERM')
      if (timedKill === undefined) {
        timedKill = setTimeout(() => sendKill('KILL'), KILL_GRACE_MS)
      }
    }
    const onAbort = (): void => {
      timedOut = true
      stopGroup()
    }
    if (options.signal?.aborted === true) onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const registration = session.registerProcess({
      onData(stream, chunk) {
        const truncated = stream === 'out' ? truncatedOut : truncatedErr
        if (truncated) return // The group is already being stopped.
        const used = stream === 'out' ? outBytes : errBytes
        const room = cap - used
        if (room <= 0) {
          if (stream === 'out') truncatedOut = true
          else truncatedErr = true
          stopGroup()
          return
        }
        const kept = chunk.length <= room ? chunk : chunk.subarray(0, room)
        ;(stream === 'out' ? stdoutChunks : stderrChunks).push(kept)
        if (stream === 'out') outBytes += kept.length
        else errBytes += kept.length
        if (outBytes >= cap || errBytes >= cap) {
          if (stream === 'out') truncatedOut = true
          else truncatedErr = true
          stopGroup()
        }
      },
      onEof() {
        // Both streams report EOF; exit and gone carry the terminal facts.
      },
      onExit(code, sig) {
        exitCode = code
        signal = sig
      },
      onGone() {
        const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8')
        const parsed = parseSentinelExit(stdoutRaw, token)
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        // When the sentinel came back, treat ITS rc as authoritative (it is the
        // shell's own last word); a bash killed by SIGPIPE after a `| head`
        // reports no sentinel and a signal/exit the caller already sees.
        const code = parsed.seen && parsed.exit !== null ? parsed.exit : exitCode
        const silentLoss = code === 0
          && parsed.seen === false
          && !truncatedOut && !truncatedErr && !timedOut
          && parsed.stdout.length === 0 && stderr.length === 0
        settle({
          exitCode: code,
          signal,
          stdout: parsed.stdout,
          stderr,
          truncatedOut,
          truncatedErr,
          timedOut,
          pid,
          pgid,
          sentinelSeen: parsed.seen,
          silentLoss,
        })
      },
    })
    holder.release = (): void => registration.release()

    void session
      .request('spawn', {
        handle: registration.handle,
        argv,
        cwd: options.cwd,
        env,
        stdin: 'ignore',
      })
      .then((spawned) => {
        pid = spawned.pid
        pgid = spawned.pgid
        if (killQueued) {
          killQueued = false
          stopGroup()
        }
      }, (error: unknown) => {
        fail(error instanceof SshHelperError || error instanceof SshTransportError
          ? error
          : new SshTransportError('failed to start the remote command', { cause: error }))
      })
  })
}
