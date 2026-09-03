/**
 * A remote LONG-RUNNING task exposed as a DSH background job.
 *
 * ssh_exec with `background: true` registers the command with `ctx.jobs`; the
 * jobs registry calls `run()` to obtain this hook set and drives the UI: the
 * task appears in the session-header background-job indicator, can be stopped
 * there (cancel -> remote process-group kill), reports completion when the
 * remote process actually exits, and exposes a bounded rolling log.
 *
 * Unlike `runRemoteCommand`, nothing here times out, kills on output volume,
 * or appends an end sentinel: a job lives until its remote process exits and
 * only the LAST ~256 KiB of output are kept for reading.
 * @module dsh-ssh-gui/remote-job
 */

import type { SshHelperSession } from './helper-session.ts'
import { SshHelperError, SshTransportError } from '../../ssh/src/channel.ts'

/** The outcome shape `ctx.jobs` records on settlement. */
export interface RemoteJobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}

/** The hook set `ctx.jobs` expects from `JobStart.run()`. */
export interface RemoteJobHooks {
  cancel(reason?: string): void
  done: Promise<RemoteJobOutcome>
  readOutput?(): string
}

/** Options for one background task. */
export interface RemoteJobSpec {
  command: string
  cwd: string
  /** Rolling tail cap for readOutput (default 256 KiB). */
  maxTailBytes?: number
}

/** Fallback PATH when the login environment has none. */
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** Grace between TERM and KILL when stopping a job from the UI. */
const KILL_GRACE_MS = 2_000

/** A bounded rolling tail: keeps only the last `cap` characters of text. */
export class TailBuffer {
  private readonly chunks: string[] = []
  private bytes = 0
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  push(text: string): void {
    if (text === '') return
    this.chunks.push(text)
    this.bytes += text.length
    let over = this.bytes - this.cap
    while (over > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]
      if (head === undefined) break
      if (head.length <= over) {
        // The oldest chunk is fully beyond the cap: drop it whole.
        this.chunks.shift()
        this.bytes -= head.length
        over -= head.length
      } else {
        // Drop only the oldest part of the head chunk.
        this.chunks[0] = head.slice(over)
        this.bytes -= over
        over = 0
      }
    }
  }

  text(): string {
    return this.chunks.join('')
  }
}

/**
 * Start one background remote task on a helper session. Spawning is env-first
 * (the helper never merges an environment) and begins lazily: registering the
 * job returns immediately; the network is only touched when the spawn path
 * runs. `cancel` before spawn only queues the group kill.
 * @param session - the attached helper session for the route.
 * @param spec - command and remote cwd.
 * @returns the hook set the jobs registry drives (cancel/done/readOutput).
 */
export function backgroundJobHooks(session: SshHelperSession, spec: RemoteJobSpec): RemoteJobHooks {
  const tail = new TailBuffer(spec.maxTailBytes ?? 256 * 1024)
  let exitCode: number | null = null
  let signal: number | null = null
  let pid = -1
  let pgid = -1
  let settled = false
  let killed = false
  let killReason: string | undefined
  let killQueued = false
  let timedKill: ReturnType<typeof setTimeout> | undefined

  // Function-scope killers: shared by the spawn path (after pid/pgid arrive)
  // and by cancel() from the jobs registry.
  const sendKill = (signalName: 'TERM' | 'KILL'): void => {
    if (pgid < 0) {
      killQueued = true
      return
    }
    void session.request('kill', { pgid, signal: signalName }).catch(() => undefined)
  }
  const scheduleHardKill = (): void => {
    if (timedKill === undefined) timedKill = setTimeout(() => sendKill('KILL'), KILL_GRACE_MS)
  }

  const done = new Promise<RemoteJobOutcome>((resolvePromise) => {
    const holder: { release(): void } = { release: () => undefined }
    const settle = (outcome: RemoteJobOutcome): void => {
      if (settled) return
      settled = true
      if (timedKill !== undefined) clearTimeout(timedKill)
      holder.release()
      resolvePromise(outcome)
    }

    // Env first, then register listeners and spawn. Events can only arrive
    // after the spawn request, so registering here cannot miss output.
    void (async () => {
      try {
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
        }

        const registration = session.registerProcess({
          onData(_stream, chunk) {
            tail.push(chunk.toString('utf8'))
          },
          onEof() { /* exit/gone carry the terminal facts */ },
          onExit(code, sig) {
            exitCode = code
            signal = sig
          },
          onGone() {
            const status = killed ? 'killed' as const : exitCode === 0 ? 'completed' as const : 'failed' as const
            const detail = killed
              ? killReason ?? 'stopped by the user'
              : signal !== null ? `terminated by signal ${signal}` : undefined
            settle({ status, ...(detail === undefined ? {} : { detail }), output: tail.text() })
          },
        })
        holder.release = (): void => registration.release()

        const spawned = await session.request('spawn', {
          handle: registration.handle,
          argv: ['bash', '-c', spec.command],
          cwd: spec.cwd,
          env,
          stdin: 'ignore',
        })
        pid = spawned.pid
        pgid = spawned.pgid
        if (killQueued) {
          killQueued = false
          sendKill('TERM')
          scheduleHardKill()
        }
      } catch (error) {
        const message = error instanceof SshHelperError || error instanceof SshTransportError
          ? error.message.replace(/^dsh-ssh: /u, '')
          : error instanceof Error ? error.message : String(error)
        settle({ status: 'failed', detail: message })
      }
    })()
  })

  return {
    cancel(reason?: string) {
      if (settled) return
      killed = true
      killReason = reason
      sendKill('TERM')
      scheduleHardKill()
    },
    done,
    readOutput: () => tail.text(),
  }
}
