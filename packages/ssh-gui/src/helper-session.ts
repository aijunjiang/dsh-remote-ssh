/**
 * A helper session attached to one registry connection.
 *
 * The GUI layer's `SshConnection` is a plain ssh2 client (jump chain + shared
 * SFTP). The capability providers (fs-ssh / subprocess-ssh) need the helper
 * protocol — real pids, tree-scoped killpg, atomic publication, nanosecond
 * version tokens — which plain SSH cannot express. This class deploys and
 * supervises the helper daemon ON the registry connection's own transport, so
 * one connection serves both the browser (SFTP listing) and the providers
 * (helper channel), and the two never open a second TCP connection.
 *
 * Interface note: `exec` is delegated to the connection's own (control-plane,
 * collected-output) exec, while `request`/`registerProcess`/`runtimePath` ride
 * the helper channel — exactly the surface `dsh-subprocess-ssh` and `dsh-fs-ssh`
 * consume.
 *
 * @module dsh-ssh-gui/helper-session
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'
import { Buffer } from 'node:buffer'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import { HelperChannel, SshHelperError, SshTransportError } from '../../ssh/src/channel.ts'
import { HELPER_PROTOCOL_VERSION } from '../../ssh/src/protocol.ts'
import type { HelperResults } from '../../ssh/src/protocol.ts'
import type { SshProcessListeners } from '../../ssh/src/channel.ts'
import type { SshConnection } from './connection.ts'

/** Options for one helper session. */
export interface HelperSessionOptions {
  /** Directory under `$HOME` holding the helper and its runtime state. */
  helperDir?: string
  /** Interpreter used to run the helper. */
  python?: string
  /** Upper bound on the helper's `ready` frame. */
  readyTimeoutMs?: number
  /** Diagnostic sink; defaults to nothing. */
  logger?: { debug?(message: string): void; warn?(message: string): void; error?(message: string): void }
}

/** Facts about the connected remote world, resolved once at open. */
export interface HelperSessionFacts {
  /** The account's home directory (absolute). */
  home: string
  /** Absolute runtime directory for provider state (spills, staged binaries). */
  runtimeRoot: string
  /** The interpreter the helper runs under. */
  python: string
}

/** A process registration handle, as the providers consume it. */
export interface ProcessRegistration {
  handle: string
  release(): void
}

/**
 * The helper daemon attached to one registry connection.
 *
 * Everything is lazy: `open()` (deploy + start + ping) runs on the first
 * request, and is cached afterwards. The connection's own exec channel carries
 * the daemon; the browser's SFTP listing keeps working throughout.
 */
export class SshHelperSession {
  private readonly connection: SshConnection
  private readonly options: Required<HelperSessionOptions>
  private readonly channel: HelperChannel
  private client: Client | undefined
  private helperChannel: ClientChannel | undefined
  private sftp: SFTPWrapper | undefined
  private facts: HelperSessionFacts | undefined
  private loginEnv: Record<string, string> | undefined
  private opened: Promise<void> | undefined
  private disposed = false
  /** Connection transport generation this session's daemon was started on. */
  private generation: number | undefined

  constructor(connection: SshConnection, options: HelperSessionOptions = {}) {
    this.connection = connection
    this.options = {
      helperDir: options.helperDir ?? '.dsh-remote',
      python: options.python ?? 'python3',
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      logger: options.logger,
    }
    this.channel = new HelperChannel({
      write: (line, callback) => {
        const channel = this.helperChannel
        if (channel === undefined) {
          callback(new SshTransportError('the helper channel is not open'))
          return
        }
        channel.write(line, callback)
      },
      log: (level, message) => void this.options.logger?.[level]?.(`dsh-ssh-gui ${message}`),
    })
  }

  /** The remote workspace directory this connection was registered with. */
  get cwd(): string {
    return this.connection.cwd
  }

  /** Absolute path of a provider-owned runtime file (spills, staged binaries). */
  runtimePath(...segments: readonly string[]): string {
    if (this.facts === undefined) throw new SshTransportError('connection is not open yet')
    return posix.join(this.facts.runtimeRoot, ...segments)
  }

  /** Run one control-plane command; delegated to the connection's own exec. */
  async exec(command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    await this.open()
    const outcome = await this.connection.exec(command)
    return { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
  }

  /** Issue one helper request; opens the session on first use. */
  async request<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options: { onData?: (chunk: Buffer) => void } = {},
  ): Promise<HelperResults[K]> {
    await this.open()
    return await this.channel.send(op, payload, options)
  }

  /**
   * Same request surface under the subprocess provider's `HelperHost` name
   * (`send`), so one session serves both capability providers unchanged.
   */
  async send<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options: { onData?: (chunk: Buffer) => void } = {},
  ): Promise<HelperResults[K]> {
    return await this.request(op, payload, options)
  }

  /** Register listeners for one spawned process BEFORE requesting the spawn. */
  registerProcess(listeners: SshProcessListeners): ProcessRegistration {
    return this.channel.registerProcess(listeners)
  }

  /** Resolved facts, after the helper answered ping and the environment probe. */
  get factsValue(): HelperSessionFacts | undefined {
    return this.facts
  }

  /**
   * The remote login environment (from the helper's `env` probe), cached once
   * at open. Spawned children need a complete environment map because the
   * helper never merges its own.
   */
  get loginEnvironment(): Record<string, string> | undefined {
    return this.loginEnv
  }

  /**
   * Deploy, start, and verify the helper daemon. Idempotent and cached.
   *
   * The cache is keyed to the connection's transport *generation*: a disconnect
   * (manual, or the guard invalidating a dropped link) bumps it, so this
   * session bootstraps a fresh daemon instead of holding a channel that died
   * with the previous transport.
   * @returns the resolved remote facts.
   */
  async open(): Promise<HelperSessionFacts> {
    if (this.disposed) throw new SshTransportError('the helper session is disposed')
    if (this.opened !== undefined && this.generation !== this.connection.generation) {
      // The transport was replaced under us: the old helper channel is dead.
      this.reset()
    }
    this.opened ??= this.bootstrap()
    await this.opened
    return this.facts!
  }

  /** Drop cached daemon state so the next `open()` bootstraps again. */
  private reset(): void {
    this.opened = undefined
    this.facts = undefined
    this.loginEnv = undefined
    this.client = undefined
    this.sftp = undefined
    this.generation = undefined
    const channel = this.helperChannel
    this.helperChannel = undefined
    if (channel !== undefined) {
      try { channel.close() } catch { /* already gone with the transport */ }
    }
  }

  private async bootstrap(): Promise<void> {
    const client = await this.connection.getClient()
    this.client = client
    const sftp = await this.connection.getSftp()
    this.sftp = sftp

    const content = await readFile(fileURLToPath(new URL('../../ssh/helper/dsh_helper.py', import.meta.url)))
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
    const script = posix.join(this.options.helperDir, `dsh_helper.${digest}.py`)

    await this.sftpMkdir(sftp, this.options.helperDir, 0o700)
    const existing = await this.sftpRead(sftp, script)
    if (existing === undefined || !existing.equals(content)) {
      await this.sftpWrite(sftp, script, content, 0o700)
    }

    const command = `${this.options.python} -u ${this.shellQuote(script)}`
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, ((error: Error | undefined, execChannel: ClientChannel) => {
        if (error !== undefined) {
          reject(new SshTransportError('failed to start the remote helper', { cause: error }))
          return
        }
        resolve(execChannel)
      }) as never)
    })
    this.helperChannel = channel
    const stderrTail: string[] = []
    channel.on('data', ((chunk: Buffer) => this.channel.consume(chunk)) as never)
    channel.stderr.on('data', ((chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderrTail.push(text)
      this.options.logger?.warn?.(`dsh-ssh-gui helper: ${text.trimEnd()}`)
    }) as never)
    channel.on('close', (() => {
      const tail = stderrTail.join('').trimEnd()
      this.channel.fail(
        new SshTransportError(`the remote helper exited${tail.length === 0 ? '' : `: ${tail.slice(-400)}`}`),
      )
    }) as never)
    channel.on('error', ((error: Error) => {
      this.options.logger?.error?.(`dsh-ssh-gui helper channel error: ${error.message}`)
      this.channel.fail(new SshTransportError(`the remote helper channel errored: ${error.message}`, { cause: error }))
    }) as never)
    channel.stderr.on('error', (() => {
      // A stderr stream error only stops diagnostics; the channel-level guard
      // above still settles the session on real transport failure.
    }) as never)

    await this.channel.waitForReady(this.options.readyTimeoutMs)
    const ping = await this.channel.send('ping', {})
    if (ping.protocol !== HELPER_PROTOCOL_VERSION) {
      throw new SshTransportError(`helper protocol ${ping.protocol} does not match expected ${HELPER_PROTOCOL_VERSION}`)
    }
    const env = await this.channel.send('env', { login: true })
    this.loginEnv = env.env
    const home = env.home
    const runtimeRoot = posix.join(home, this.options.helperDir, 'run')
    await this.channel.send('mkdir', { path: runtimeRoot, parents: true, okIfExists: true })
    // The connection's `cwd` is only a convenience default for callers that
    // give no directory of their own — never a precondition for the transport.
    // It used to be created unconditionally, so one stale value (the form fills
    // `/home/<user>` and does not update it when the username changes) made
    // every command on the connection fail with EACCES before anything ran.
    await this.ensureDefaultCwd()
    this.facts = { home, runtimeRoot, python: ping.python }
    // Remember which transport this daemon lives on, so a later disconnect
    // (which bumps the generation) is noticed by open().
    this.generation = this.connection.generation
  }

  /**
   * Create the connection's default remote directory if it is missing.
   *
   * Best-effort by design. The value is only a fallback for callers that name
   * no directory, so a path this account cannot create must not fail the
   * bootstrap: before this guard, one stale `cwd` (a username edited after the
   * form pre-filled `/home/<old-user>`) made every command on the connection
   * fail before it ran. A failure is logged and the connection still works for
   * every caller that supplies its own absolute directory.
   */
  private async ensureDefaultCwd(): Promise<void> {
    const cwd = this.connection.cwd
    try {
      await this.channel.send('mkdir', { path: cwd, parents: true, okIfExists: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.connection.warn(
        `dsh-ssh: cannot create the default remote directory ${JSON.stringify(cwd)} (${reason}); `
        + 'commands that name their own directory still work. Clear or fix this connection\'s '
        + '"cwd" if no-directory callers should work too.',
      )
    }
  }

  /**
   * Shut the daemon down: stdin EOF is its documented kill-switch (every owned
   * tree is SIGKILLed), then the channel is failed so pending requests settle.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      this.helperChannel?.end()
    } catch {
      // The channel may already be gone.
    }
    this.channel.fail(new SshTransportError('helper session disposed'))
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`
  }

  private sftpMkdir(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, { mode }, ((error: (Error & { code?: number }) | undefined) => {
        if (error !== undefined && error.code !== 4 && error.code !== 11) {
          reject(new SshTransportError(`mkdir ${path} failed`, { cause: error }))
          return
        }
        resolve()
      }) as never)
    })
  }

  private sftpRead(sftp: SFTPWrapper, path: string): Promise<Buffer | undefined> {
    return new Promise<Buffer | undefined>((resolve, reject) => {
      sftp.readFile(path, ((error: (Error & { code?: number }) | undefined, data: Buffer) => {
        if (error !== undefined) {
          if (error.code === 2) {
            resolve(undefined)
            return
          }
          reject(new SshTransportError(`read ${path} failed`, { cause: error }))
          return
        }
        resolve(data)
      }) as never)
    })
  }

  private sftpWrite(sftp: SFTPWrapper, path: string, data: string | Buffer, mode: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, data, { mode }, ((error: Error | undefined) => {
        if (error !== undefined) {
          reject(new SshTransportError(`write ${path} failed`, { cause: error }))
          return
        }
        resolve()
      }) as never)
    })
  }
}
