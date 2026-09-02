/**
 * Shared ownership of one SSH connection and its remote helper daemon.
 *
 * This is the `dsh-e2b` of the SSH world: the filesystem and subprocess
 * providers inject it, so both inhabit **one** remote world with one cwd, one
 * environment base, and one process table. Nothing here implements a capability
 * seam — it owns connection lifetime, authentication, helper provisioning, and
 * the request/event router over the helper's control channel.
 *
 * Deliberate divergences from `dsh-e2b`:
 *
 *   * Runtime state lives under the helper directory in `$HOME`, not under the
 *     workspace cwd. A remote workspace is usually a git checkout, and E2B's
 *     `<cwd>/.dsh-e2b` convention would dirty it.
 *   * Authentication has a ladder rather than a single API key, because the
 *     operator's first contact is a password and every later one should not be.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join as joinLocal } from 'node:path'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import ssh2 from 'ssh2'
import { HELPER_PROTOCOL_VERSION, type HelperRequest, type HelperResults } from './protocol.ts'
import { HelperChannel, SshHelperError, SshTransportError } from './channel.ts'
import type { SshProcessListeners } from './channel.ts'
import { generateEd25519Identity } from './keys.ts'

// Framing, request correlation, and process-event routing live in ./channel.ts,
// which is transport-free and therefore unit-tested; this module owns only
// connection lifetime, authentication, and helper provisioning.
export { HelperChannel, SshHelperError, SshTransportError } from './channel.ts'
export type { SshProcessListeners, HelperLogLevel } from './channel.ts'

const { Client } = ssh2

/** Minimal structural view of the `ssh2` surface we use, so no `@types/ssh2` is required. */
interface SshClient {
  on(event: string, listener: (...args: never[]) => void): SshClient
  connect(options: Record<string, unknown>): void
  end(): void
  destroy(): void
  exec(command: string, callback: (error: Error | undefined, channel: SshChannel) => void): void
  sftp(callback: (error: Error | undefined, sftp: SshSftp) => void): void
}

/** Minimal structural view of one `ssh2` channel. */
interface SshChannel {
  on(event: string, listener: (...args: never[]) => void): SshChannel
  write(data: string | Buffer, callback?: (error?: Error) => void): boolean
  end(data?: string | Buffer): void
  close(): void
  stderr: { on(event: string, listener: (...args: never[]) => void): unknown }
}

/** Minimal structural view of the `ssh2` SFTP client. */
interface SshSftp {
  readFile(path: string, callback: (error: Error | undefined, data: Buffer) => void): void
  writeFile(
    path: string,
    data: string | Buffer,
    options: { mode?: number },
    callback: (error: Error | undefined) => void,
  ): void
  mkdir(path: string, attributes: { mode?: number }, callback: (error: Error | undefined) => void): void
  end(): void
}

/** Configuration for the shared SSH connection owner. */
export interface Config {
  /** Hostname or address of the SSH target. */
  host: string
  /** TCP port; defaults to 22. */
  port?: number
  /** Remote account name. */
  username?: string
  /**
   * Password for the FIRST connection only. When `provisionKey` is on, a key is
   * installed immediately and later connections stop using it.
   */
  password?: string
  /**
   * Directory holding harness-generated private keys. Point it at
   * `!!js dshHomePath('remote-ssh')` so identities live with the other local
   * credentials and never inside a workspace.
   */
  identityDir?: string
  /** Explicit private key file, bypassing the generated-identity ladder. */
  identityPath?: string
  /** Passphrase for `identityPath`, when it is encrypted. */
  passphrase?: string
  /** Remote absolute workspace directory. Must equal `sandbox-policy.workspaceRoot`. */
  cwd: string
  /** Remote directory for the helper and its runtime state, relative to `$HOME`. */
  helperDir?: string
  /** Remote interpreter for the helper. */
  python?: string
  /** Append the generated public key to `~/.ssh/authorized_keys` after a password login. */
  provisionKey?: boolean
  /** Milliseconds to wait for the helper's `ready` frame. */
  readyTimeoutMs?: number
  /** SSH keepalive interval; 0 disables. A dead TCP must not look like a hang. */
  keepaliveMs?: number
}

interface ResolvedConfig extends Config {
  port: number
  username: string
  helperDir: string
  python: string
  provisionKey: boolean
  readyTimeoutMs: number
  keepaliveMs: number
}

/** Facts about the connected remote world, resolved once at open. */
export interface SshRemoteFacts {
  /** The account's home directory. */
  home: string
  /** Absolute helper directory. */
  helperRoot: string
  /** Absolute directory for provider-owned runtime state (spill files, staged binaries). */
  runtimeRoot: string
  /** Login-shell environment, before any harness scrub. */
  loginEnv: Readonly<Record<string, string>>
  /** Helper interpreter version, for diagnostics. */
  python: string
  /** `uname` fields, for staged-binary architecture selection. */
  uname: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshRuntime
  }
}

/**
 * Owns one SSH connection, provisions and supervises the remote helper daemon,
 * and routes helper requests and events for the capability providers above it.
 */
export class SshRuntime extends Service {
  static Config: z<Config> = z.object({
    host: z.string().required(),
    port: z.number().default(22),
    username: z.string(),
    password: z.string(),
    identityDir: z.string(),
    identityPath: z.string(),
    passphrase: z.string(),
    cwd: z.string().required(),
    helperDir: z.string().default('.dsh-remote'),
    python: z.string().default('python3'),
    provisionKey: z.boolean().default(true),
    readyTimeoutMs: z.number().default(30_000),
    keepaliveMs: z.number().default(15_000),
  })

  /** Remote absolute workspace directory shared by every provider above. */
  readonly cwd: string

  private readonly config: ResolvedConfig
  private readonly ready: Promise<SshRemoteFacts>
  /** Framing and routing; owns request correlation and process events. */
  private readonly helper: HelperChannel
  private client: SshClient | undefined
  private channel: SshChannel | undefined
  private facts: SshRemoteFacts | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    // Apply the schema's defaults here, not just through `SshRuntime.Config(...)`:
    // an out-of-tree caller constructing this class directly with a plain object
    // would otherwise hand `helperDir === undefined` to the deployer. The e2e
    // suite passed `Config({...})` and masked exactly that.
    this.config = SshRuntime.Config(config) as ResolvedConfig
    validateSshConfig(this.config)
    // The channel exists before the transport does: `open()` attaches the exec
    // channel later, and a request issued in between must fail with a clear
    // transport error rather than a TypeError.
    this.helper = new HelperChannel({
      write: (line, callback) => {
        const channel = this.channel
        if (channel === undefined) {
          callback(new SshTransportError('the helper channel is not open'))
          return
        }
        channel.write(line, callback)
      },
      log: (level, message) => void this.ctx.logger?.[level]?.(`dsh-ssh ${message}`),
    })
    this.cwd = posix.normalize(this.config.cwd)
    this.ready = this.open()
    // A deployment may load the owner before any provider uses it; keep the
    // eager failure observed while still surfacing it from getFacts().
    void this.ready.catch(() => {})

    ctx.effect(() => async () => {
      this.disposed = true
      // Helper stdin EOF is the documented shutdown: the daemon SIGKILLs every
      // tree it still owns, so no orphan survives the connection.
      try {
        this.channel?.end()
      } catch {
        // The channel may already be gone; teardown continues regardless.
      }
      this.failAll(new SshTransportError('connection disposed'))
      try {
        this.client?.end()
      } catch {
        this.client?.destroy()
      }
    }, 'ssh connection teardown')
  }

  /**
   * Await the connected remote world.
   * @returns facts resolved once, after the helper answered `ping`.
   * @throws when connection, authentication, or helper startup failed.
   */
  async getFacts(): Promise<SshRemoteFacts> {
    if (this.disposed) throw new SshTransportError('connection is disposing')
    const facts = await this.ready
    if (this.disposed) throw new SshTransportError('connection is disposing')
    return facts
  }

  /**
   * Issue one helper request.
   * @param op - operation name from the helper protocol.
   * @param payload - operation fields, without `id`.
   * @param options - `onData` receives streamed payload chunks for `read`.
   * @returns the operation's result payload.
   * @throws {SshHelperError} when the helper reported a coded failure.
   * @throws {SshTransportError} when the channel died first.
   */
  async request<K extends keyof HelperResults>(
    op: K,
    payload: Omit<Extract<HelperRequest, { op: K }>, 'id' | 'op'>,
    options: { onData?: (chunk: Buffer) => void } = {},
  ): Promise<HelperResults[K]> {
    await this.getFacts()
    return await this.send(op, payload, options)
  }

  /**
   * Register listeners for one spawned process handle before spawning it.
   *
   * Registration must precede the `spawn` request: the helper may emit output
   * before the reply arrives, and a dropped first chunk is unrecoverable.
   * @param listeners - per-handle event sink.
   * @returns the handle id to pass to `spawn`, and its disposer.
   */
  registerProcess(listeners: SshProcessListeners): { handle: string; release(): void } {
    return this.helper.registerProcess(listeners)
  }

  /** Absolute path of a provider-owned runtime file, e.g. an output spill. */
  runtimePath(...segments: readonly string[]): string {
    if (this.facts === undefined) throw new SshTransportError('connection is not open yet')
    return posix.join(this.facts.runtimeRoot, ...segments)
  }

  /**
   * Run one command on the target and report its exit facts.
   *
   * The command runs through the helper, so it shares the same execution world
   * as everything else on this connection — never a second SSH channel. Output
   * is collected into bounded buffers; the timeout-mandating callers (the
   * ripgrep ladder, environment probing) pass short commands.
   * @param command - a shell command string; interpreted by `sh -c`.
   * @returns exit code plus bounded stdout/stderr.
   */
  async exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.getFacts()
    const out: Buffer[] = []
    const err: Buffer[] = []
    const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      const registration = this.registerProcess({
        onData: (stream, chunk) => void (stream === 'out' ? out : err).push(chunk),
        onEof: () => {},
        onExit: (exitCode, signal) => resolve({ exitCode, signal }),
        onGone: () => {},
      })
      this.send('spawn', {
        handle: registration.handle,
        argv: ['/bin/sh', '-c', command],
        cwd: this.cwd,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        stdin: 'ignore',
      }).then(
        () => {},
        (error: unknown) => {
          registration.release()
          reject(error)
        },
      )
    })
    return {
      exitCode: outcome.exitCode,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }
  }

  // -- open sequence ------------------------------------------------------

  private async open(): Promise<SshRemoteFacts> {
    const identity = await this.resolveIdentity()
    this.client = await this.connect(identity)
    const sftp = await this.openSftp()
    try {
      const helperRoot = await this.deployHelper(sftp)
      if (identity.provisionAfterConnect !== undefined) {
        await this.installPublicKey(sftp, identity.provisionAfterConnect.authorizedKeysLine)
        await this.saveIdentity(identity.provisionAfterConnect.privateKeyPem)
      }
      this.channel = await this.startHelper(helperRoot)
      const ping = await this.send('ping', {})
      if (ping.protocol !== HELPER_PROTOCOL_VERSION) {
        throw new SshTransportError(
          `helper protocol ${ping.protocol} does not match expected ${HELPER_PROTOCOL_VERSION}`,
        )
      }
      const env = await this.send('env', { login: true })
      const runtimeRoot = posix.join(helperRoot, 'run')
      await this.send('mkdir', { path: runtimeRoot, parents: true, okIfExists: true })
      await this.send('mkdir', { path: this.cwd, parents: true, okIfExists: true })
      const facts: SshRemoteFacts = {
        home: env.home,
        helperRoot,
        runtimeRoot,
        loginEnv: env.env,
        python: ping.python,
        uname: ping.uname,
      }
      this.facts = facts
      return facts
    } finally {
      // Deliberately NOT ending the sftp session here. In ssh2, an SFTP session
      // is a channel on the shared connection, and `sftp.end()` on the last
      // remaining channel closes the CONNECTION — which delivers EOF to the
      // helper's stdin, and the helper's stdin-EOF contract SIGKILLs every tree
      // it owns, including itself. The helper channel died exactly this way:
      // `startHelper` resolved, then the ping write failed with cause null
      // because the channel was already gone. Keeping the sftp channel open
      // costs one idle channel on a long-lived connection.
    }
  }

  /**
   * Decide which credential to authenticate with.
   *
   * The ladder mirrors Remote-SSH: an existing harness identity wins, an
   * operator-supplied key file is next, and a password is accepted only as the
   * bootstrap that provisions a key.
   */
  private async resolveIdentity(): Promise<{
    privateKey?: string
    passphrase?: string
    password?: string
    provisionAfterConnect?: { privateKeyPem: string; authorizedKeysLine: string }
  }> {
    if (this.config.identityPath !== undefined) {
      const privateKey = await readFile(this.config.identityPath, 'utf8')
      return { privateKey, passphrase: this.config.passphrase }
    }
    const generatedPath = this.identityFilePath()
    if (generatedPath !== undefined) {
      try {
        return { privateKey: await readFile(generatedPath, 'utf8') }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (this.config.password === undefined) {
      throw new Error(
        'dsh-ssh: no credential available — supply password (first connection), identityPath, or a provisioned identityDir',
      )
    }
    if (!this.config.provisionKey) return { password: this.config.password }
    const identity = generateEd25519Identity(`dsh@${this.config.host}`)
    return {
      password: this.config.password,
      provisionAfterConnect: {
        privateKeyPem: identity.privateKeyPem,
        authorizedKeysLine: identity.authorizedKeysLine,
      },
    }
  }

  private identityFilePath(): string | undefined {
    if (this.config.identityDir === undefined) return undefined
    const safe = `${this.config.username}@${this.config.host}`.replace(/[^\w.@-]/g, '_')
    return joinLocal(this.config.identityDir, `${safe}.key`)
  }

  private async saveIdentity(privateKeyPem: string): Promise<void> {
    const path = this.identityFilePath()
    if (path === undefined) {
      this.ctx.logger?.warn?.(
        'dsh-ssh: provisioned a remote key but identityDir is unset, so the next connection will need the password again',
      )
      return
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, privateKeyPem, { mode: 0o600 })
    // Windows ignores the create mode, so restate it; on POSIX this is a no-op.
    await chmod(path, 0o600).catch(() => {})
  }

  private connect(identity: {
    privateKey?: string
    passphrase?: string
    password?: string
  }): Promise<SshClient> {
    return new Promise<SshClient>((resolve, reject) => {
      const client = new Client() as unknown as SshClient
      const onError = (error: Error): void => {
        this.failAll(new SshTransportError(`connection to ${this.config.host} failed`, { cause: error }))
        reject(new SshTransportError(`connection to ${this.config.host} failed`, { cause: error }))
      }
      client.on('ready', (() => resolve(client)) as never)
      client.on('error', onError as never)
      client.on('end', (() => this.failAll(new SshTransportError('connection ended'))) as never)
      client.on('close', (() => this.failAll(new SshTransportError('connection closed'))) as never)
      // Some servers only offer keyboard-interactive for password auth.
      client.on('keyboard-interactive', ((
        _name: string,
        _instructions: string,
        _lang: string,
        prompts: readonly unknown[],
        finish: (responses: readonly string[]) => void,
      ) => {
        finish(prompts.map(() => identity.password ?? ''))
      }) as never)
      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: identity.password,
        privateKey: identity.privateKey,
        passphrase: identity.passphrase,
        tryKeyboard: identity.password !== undefined,
        keepaliveInterval: this.config.keepaliveMs,
      })
    })
  }

  private openSftp(): Promise<SshSftp> {
    const client = this.client
    if (client === undefined) throw new SshTransportError('no client')
    return new Promise<SshSftp>((resolve, reject) => {
      client.sftp(((error: Error | undefined, sftp: SshSftp) => {
        if (error !== undefined) {
          reject(new SshTransportError('SFTP subsystem unavailable', { cause: error }))
          return
        }
        resolve(sftp)
      }) as never)
    })
  }

  /**
   * Upload the helper when its content differs, and return its absolute root.
   *
   * The directory is created through SFTP with a relative path so it lands in
   * the account's home without needing to know `$HOME` yet — the helper itself
   * is what reports `$HOME`.
   */
  private async deployHelper(sftp: SshSftp): Promise<string> {
    const source = fileURLToPath(new URL('../helper/dsh_helper.py', import.meta.url))
    const content = await readFile(source)
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
    const dir = this.config.helperDir
    await this.sftpMkdir(sftp, dir, 0o700)
    // Content-addressed name: a stale daemon from an older harness build can
    // never be reused, and two harness versions can coexist on one account.
    const remote = posix.join(dir, `dsh_helper.${digest}.py`)
    const existing = await this.sftpRead(sftp, remote)
    if (existing === undefined || !existing.equals(content)) {
      await this.sftpWrite(sftp, remote, content, 0o700)
    }
    return dir === '' ? '.' : dir
  }

  private async installPublicKey(sftp: SshSftp, line: string): Promise<void> {
    await this.sftpMkdir(sftp, '.ssh', 0o700)
    const path = '.ssh/authorized_keys'
    const existing = (await this.sftpRead(sftp, path)) ?? Buffer.alloc(0)
    const text = existing.toString('utf8')
    if (text.includes(line)) return
    const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    await this.sftpWrite(sftp, path, `${text}${separator}${line}\n`, 0o600)
  }

  /**
   * Remove a provisioned public key from the target.
   *
   * The harness provisions a key on first connection; when a test or a
   * deployment tears down, the matching line must leave `authorized_keys` too —
   * a persistent key nobody remembers is exactly the backdoor a remote account
   * does not need.
   * @param comment - the identity comment (`dsh@<host>`) whose line to remove.
   * @returns the number of lines removed (0 means the key was never there).
   */
  async unprovisionPublicKey(comment: string): Promise<number> {
    const client = await this.connect({ password: this.config.password })
    try {
      const sftp = await new Promise<SshSftp>((resolve, reject) => {
        client.sftp(((error: Error | undefined, value: SshSftp) => {
          if (error !== undefined) reject(new SshTransportError('SFTP subsystem unavailable', { cause: error }))
          else resolve(value)
        }) as never)
      })
      const path = '.ssh/authorized_keys'
      const existing = (await this.sftpRead(sftp, path)) ?? Buffer.alloc(0)
      const lines = existing.toString('utf8').split('\n')
      const kept = lines.filter((line) => !line.includes(comment))
      if (kept.length === lines.length) return 0
      await this.sftpWrite(sftp, path, kept.join('\n'), 0o600)
      return lines.length - kept.length
    } finally {
      client.end()
    }
  }

  private sftpMkdir(sftp: SshSftp, path: string, mode: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, { mode }, ((error: (Error & { code?: number }) | undefined) => {
        // SFTP status 4 (FAILURE) is what OpenSSH returns for an existing
        // directory, so an existence check would only add a round-trip.
        if (error !== undefined && error.code !== 4 && error.code !== 11) {
          reject(new SshTransportError(`mkdir ${path} failed`, { cause: error }))
          return
        }
        resolve()
      }) as never)
    })
  }

  private sftpRead(sftp: SshSftp, path: string): Promise<Buffer | undefined> {
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

  private sftpWrite(sftp: SshSftp, path: string, data: string | Buffer, mode: number): Promise<void> {
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

  /** Start the daemon on its own exec channel and await its `ready` frame. */
  private startHelper(helperRoot: string): Promise<SshChannel> {
    const client = this.client
    if (client === undefined) throw new SshTransportError('no client')
    const source = fileURLToPath(new URL('../helper/dsh_helper.py', import.meta.url))
    return readFile(source).then(
      (content) =>
        new Promise<SshChannel>((resolve, reject) => {
          const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
          const script = posix.join(helperRoot, `dsh_helper.${digest}.py`)
          // -u keeps the daemon's stdout unbuffered so a reply is never held
          // back waiting for a buffer to fill.
          const command = `${this.config.python} -u ${shellQuote(script)}`
          client.exec(command, ((error: Error | undefined, channel: SshChannel) => {
            if (error !== undefined) {
              reject(new SshTransportError('failed to start the remote helper', { cause: error }))
              return
            }
            // Helper stderr is the first witness when startup fails (a missing
            // interpreter, a syntax error in the uploaded script); keep the tail
            // so the failure names the actual cause instead of a bare write error.
            const stderrTail: string[] = []
            channel.on('data', ((chunk: Buffer) => this.consume(chunk)) as never)
            channel.stderr.on('data', ((chunk: Buffer) => {
              const text = chunk.toString('utf8')
              stderrTail.push(text)
              this.ctx.logger?.warn?.(`dsh-ssh helper: ${text.trimEnd()}`)
            }) as never)
            // Channel death rejects every pending request and reports `gone` to
            // every registered process, both handled inside HelperChannel.
            channel.on('close', (() => {
              const tail = stderrTail.join('').trimEnd()
              this.failAll(
                new SshTransportError(
                  `the remote helper exited${tail.length === 0 ? '' : `: ${tail.slice(-400)}`}`,
                ),
              )
            }) as never)
            this.helper.waitForReady(this.config.readyTimeoutMs).then(
              () => resolve(channel),
              (cause: unknown) => {
                // A ready timeout almost always means the interpreter is absent,
                // so name it here rather than leaving a bare timeout.
                const detail = cause instanceof Error ? cause.message : String(cause)
                reject(
                  /did not report ready/.test(detail)
                    ? new SshTransportError(`${detail} (is ${this.config.python} present on the target?)`)
                    : (cause as Error),
                )
              },
            )
          }) as never)
        }),
    )
  }

  // -- frame routing ------------------------------------------------------
  //
  // Delegated to HelperChannel. Only the transport glue stays here.

  private consume(chunk: Buffer): void {
    this.helper.consume(chunk)
  }

  private send<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options: { onData?: (chunk: Buffer) => void } = {},
  ): Promise<HelperResults[K]> {
    return this.helper.send(op, payload, options)
  }

  private failAll(error: Error): void {
    this.helper.fail(error)
  }
}

/** Quote one argument for the single remote command string `exec` accepts. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/**
 * Reject a configuration that cannot describe one coherent remote world.
 *
 * Kept separate from the constructor so the rules are testable without a live
 * context, and so the failure text names the offending field rather than
 * surfacing as a mount-time schema error with no remedy.
 * @param config - a schema-applied configuration.
 * @throws when the world it describes is ambiguous.
 */
export function validateSshConfig(config: Config): void {
  if (!posix.isAbsolute(config.cwd)) {
    throw new Error(
      `dsh-ssh: cwd must be an absolute POSIX path naming the remote workspace: ${config.cwd}`,
    )
  }
  if (config.cwd.includes('\\')) {
    throw new Error(`dsh-ssh: cwd must use POSIX separators; the remote is not Windows: ${config.cwd}`)
  }
  if (config.username === undefined || config.username.length === 0) {
    throw new Error('dsh-ssh: username is required')
  }
  if (config.host.length === 0) {
    throw new Error('dsh-ssh: host is required')
  }
  if (config.identityPath === undefined && config.identityDir === undefined && config.password === undefined) {
    throw new Error(
      'dsh-ssh: configure identityPath, or identityDir plus a first-connection password, or a password with provisionKey disabled',
    )
  }
  if (config.helperDir !== undefined && posix.isAbsolute(config.helperDir)) {
    throw new Error(
      `dsh-ssh: helperDir is resolved against the account home and must be relative: ${config.helperDir}`,
    )
  }
}

export default SshRuntime
