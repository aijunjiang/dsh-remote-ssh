/**
 * Session router: turns a caller working directory into the helper-backed
 * transport that owns it, lazily attaching a helper session to each registry
 * connection it names.
 *
 * This is the session-level multi-remote switch. A session created against a
 * registry connection has a `ssh://<id>/<path>` cwd (or its local placeholder
 * twin); the providers route every operation through here, so two sessions on
 * one harness can execute on two different machines at once — each with its own
 * helper daemon on its own connection.
 *
 * Routing rules mirror the upstream transport:
 *
 *  * `ssh://<id>/<path>` → registry connection `id`, helper session attached,
 *    remote base `<path>`;
 *  * a local placeholder path (contains `dsh-ssh-routes`) → the same route;
 *  * anything else (POSIX absolute, undefined, host-only) → the default
 *    session, which is the `ctx.ssh` connection owner when one is mounted.
 *
 * @module dsh-ssh-gui/helper-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseSshRoute } from './registry.ts'
import { routeFromPlaceholder, sshRoutePlaceholder } from './transport.ts'
import { SshHelperSession } from './helper-session.ts'
import type { SshConnection } from './connection.ts'
import type { SshRegistry } from './registry.ts'
import type { HelperResults } from '../../ssh/src/protocol.ts'
import type { SshProcessListeners } from '../../ssh/src/channel.ts'
import { Buffer } from 'node:buffer'

/** The helper surface both capability providers consume. */
export interface HelperTransport {
  /** The transport's default remote working directory. */
  readonly cwd: string
  /** Issue one helper request. */
  request<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options?: { onData?: (chunk: Buffer) => void },
  ): Promise<HelperResults[K]>
  /** Same surface under the subprocess provider's `HelperHost` name. */
  send<K extends keyof HelperResults>(
    op: K,
    payload: object,
    options?: { onData?: (chunk: Buffer) => void },
  ): Promise<HelperResults[K]>
  /** Register listeners for one spawned process before requesting the spawn. */
  registerProcess(listeners: SshProcessListeners): { handle: string; release(): void }
  /** Run one control-plane command. */
  exec(command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }>
  /** Absolute path of a provider-owned runtime file on the target. */
  runtimePath(...segments: readonly string[]): string
}

/** One resolved route. */
export interface HelperRoute {
  /** The helper transport owning the resolved directory. */
  transport: HelperTransport
  /** Absolute remote POSIX directory to execute in. */
  base: string
  /** Registry connection id when the caller supplied an `ssh://` route. */
  connectionId?: string
}

/**
 * Routes caller cwds onto helper transports.
 *
 * The default transport is read from `ctx.ssh` lazily (the connection owner);
 * registry connections are looked up in `ctx.sshRegistry` when a route names
 * one. `SshHelperSession` and the owner both satisfy `HelperTransport`, so one
 * router serves the GUI-connection world and the single-owner world alike.
 */
export class SshHelperRouter {
  private readonly ctx: Context
  private readonly sessions = new Map<string, SshHelperSession>()
  private readonly defaultProvider: () => HelperTransport | undefined

  constructor(ctx: Context, options: { defaultSession?: () => HelperTransport | undefined } = {}) {
    this.ctx = ctx
    this.defaultProvider = options.defaultSession ?? (() => {
      const ssh = (ctx as unknown as { ssh?: HelperTransport }).ssh
      return ssh
    })
  }

  /** The registry service, when the GUI layer is mounted. */
  private registry(): SshRegistry | undefined {
    return this.ctx.get('sshRegistry') as SshRegistry | undefined
  }

  /** The helper transport for one registry connection, attached once. */
  sessionFor(connection: SshConnection): SshHelperSession {
    let session = this.sessions.get(connection.id)
    if (session === undefined) {
      session = new SshHelperSession(connection)
      this.sessions.set(connection.id, session)
    }
    return session
  }

  /** The helper transport for one registry connection id. */
  sessionForId(id: string): SshHelperSession {
    const registry = this.registry()
    const connection = registry?.get(id)
    if (connection === undefined) {
      throw new Error(`ssh-remote: route names unknown connection "${id}" (is dsh-ssh-gui/web mounted?)`)
    }
    return this.sessionFor(connection)
  }

  /**
   * Resolve one caller cwd onto a helper transport.
   * @param cwd - the caller's working directory: an `ssh://` route, a local
   *   placeholder, a POSIX absolute path, or undefined.
   * @returns the transport and the absolute remote base directory.
   */
  resolveCwd(cwd: string | undefined): HelperRoute {
    if (cwd !== undefined) {
      const parsed = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : routeFromPlaceholder(cwd)
      if (parsed === null && cwd.startsWith('ssh://')) {
        throw new Error(`ssh-remote: invalid remote working directory ${JSON.stringify(cwd)}`)
      }
      if (parsed !== null) {
        return {
          transport: this.sessionForId(parsed.id),
          base: parsed.path,
          connectionId: parsed.id,
        }
      }
    }
    const fallback = this.defaultProvider()
    if (fallback === undefined) {
      throw new Error('ssh-remote: no default connection is mounted (ctx.ssh); use an ssh://<id>/<path> cwd or mount the connection owner')
    }
    return { transport: fallback, base: fallback.cwd }
  }

  /**
   * Resolve an encoded filesystem target key against its owning transport.
   * @param targetKey - `ssh://<id>/<path>` when routed, a plain POSIX path otherwise.
   * @returns the transport, the absolute remote path, and the route id when set.
   */
  resolveTargetKey(targetKey: string): HelperRoute & { path: string } {
    const parsed = parseSshRoute(targetKey)
    if (parsed !== null) {
      return {
        transport: this.sessionForId(parsed.id),
        base: parsed.path,
        path: parsed.path,
        connectionId: parsed.id,
      }
    }
    const fallback = this.defaultProvider()
    if (fallback === undefined) {
      throw new Error('ssh-remote: no default connection is mounted (ctx.ssh); use an ssh://<id>/<path> target or mount the connection owner')
    }
    return { transport: fallback, base: fallback.cwd, path: targetKey }
  }

  /** Release every attached helper session. */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map(async (session) => await session.dispose()))
  }
}

/** The local placeholder path standing in for one remote route. */
export function placeholderFor(connectionId: string, remotePath: string): string {
  return sshRoutePlaceholder(connectionId, remotePath)
}
