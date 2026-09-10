/**
 * Web-facing RPC channel of dsh-ssh: mounts the connection registry and
 * registers the `/dsh-ssh` unary channel on the shared web transport with the
 * loopback trust fence. The client half drives connection management and
 * remote directory browsing through it; endpoints are plain JSON.
 * @module dsh-ssh/web
 */

import { mkdir, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { pickNativeDirectory } from '@deepseek-ai/dsh-host-directory-picker-native'
import SshRegistry from './registry.ts'
import type { ConnectionInput, RegistryConfig } from './registry.ts'
import type { SshConnection } from './connection.ts'
import { sshRoutePlaceholder } from './transport.ts'
import { installAgentExperience } from './agent-experience.ts'
import { writeRoutesManifest, type RoutesManifestEntry } from './routes-manifest.ts'

/** Channel config. */
export interface WebChannelConfig extends RegistryConfig {
  /** Complete-result bound of one remote listing level. */
  maxEntries?: number
}

/** The unary RPC result shape the shared transport expects. */
export type ChannelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/** One wire directory row / crumb. */
interface WireEntry {
  name: string
  path: string
  hidden: boolean
}

/** One remote listing level for the client browser. */
interface WireListing {
  path: string
  home: string
  crumbs: WireEntry[]
  entries: WireEntry[]
  truncated: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host connection transport (DSH >= 0.1.5): the auth fence is public. */
    connection: {
      requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
    }
    /** Host web server, for registering the `/dsh-ssh` route directly. */
    webServer: {
      register(route: {
        kind: 'prefix' | 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
  }
}

/** Required host services: the Connection transport (for its auth fence) and
 * the web server (for registering the `/dsh-ssh` route directly, since
 * `connection.rpc.handle` regressed on DSH 0.1.5). */
export const inject = ['connection', 'webServer']

/** Validated channel config. */
export const Config: z<WebChannelConfig> = z.object({
  stateFile: z.string().default(undefined),
  maxEntries: z.number().min(1).default(1000),
})

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Await a value, failing with a `bad-request` error when the guard rejects. */
function requirePayload<T>(payload: unknown, guard: (value: unknown) => value is T, what: string): T {
  if (!guard(payload)) {
    throw new Error(`bad-request: ${what} payload is invalid`)
  }
  return payload
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/** `ssh://<id>` route payload. */
function isIdPayload(value: unknown): value is { id: string } {
  return isRecord(value) && isString(value.id) && value.id.trim() !== ''
}

/** Browse payload: `{ id, path? }`. */
function isBrowsePayload(value: unknown): value is { id: string; path?: string } {
  return isRecord(value) && isString(value.id) && value.id.trim() !== ''
    && (value.path === undefined || isString(value.path))
}

/** Session-route payload: `{ id, path }` with an absolute POSIX remote path. */
function isSessionRoutePayload(value: unknown): value is { id: string; path: string } {
  return isRecord(value) && isString(value.id) && value.id.trim() !== ''
    && isString(value.path) && posix.isAbsolute(value.path)
}

/** Connection input payload (subset keys, all strings/numbers/arrays). */
function isConnectionInput(value: unknown): value is ConnectionInput {
  if (!isRecord(value)) return false
  if (!isString(value.host) || value.host.trim() === '') return false
  for (const key of ['label', 'username', 'password', 'privateKeyPath', 'passphrase', 'agent', 'cwd']) {
    const field = value[key]
    if (field !== undefined && !isString(field)) return false
  }
  if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isInteger(value.port))) return false
  if (value.jump !== undefined) {
    if (!Array.isArray(value.jump)) return false
    for (const hop of value.jump) {
      if (!isRecord(hop) || !isString(hop.host) || hop.host.trim() === '') return false
      if (hop.port !== undefined && (typeof hop.port !== 'number' || !Number.isInteger(hop.port))) return false
      for (const key of ['username', 'privateKeyPath', 'agent']) {
        if (hop[key] !== undefined && !isString(hop[key])) return false
      }
    }
  }
  return true
}

/**
 * Map a channel failure onto the HOST's closed rpc error vocabulary — the
 * client transport validates `code` against its discriminated union and
 * per-code `details` shapes, so an off-vocabulary code surfaces as a raw zod
 * dump instead of the business message.
 */
const wireError = (code: string, message: string): ChannelResult => {
  if (code === 'bad-request') {
    return { ok: false, error: { code, message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** One valid endpoint path segment. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Extract the endpoint from a request pathname under `channel`, or undefined. */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

/**
 * Serve one unary RPC request against `dispatch`, mirroring Connection's
 * `rpcFetchHandler` (JSON envelope, endpoint/method match, `server-response`
 * wrap) but writing directly to the node:http response. Used only because
 * `connection.rpc.handle` regressed on DSH 0.1.5.
 */
async function serveRpcChannel(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string,
  dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ChannelResult>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const endpoint = endpointFromPath(channel, url.pathname)
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  let body: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
    res.writeHead(400)
    res.end(JSON.stringify({
      type: 'server-response',
      rpcId: typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).rpcId === 'string' ? (body as Record<string, unknown>).rpcId : 'invalid-request',
      result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } },
    }))
    return
  }
  if (body.method !== endpoint) {
    res.writeHead(400)
    res.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } } },
    }))
    return
  }
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  let result: ChannelResult
  try {
    result = await dispatch(endpoint, body.payload, abort.signal)
  } catch (error) {
    result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

/** Ancestor chain from the remote root to `target` inclusive. */
function ancestryCrumbs(target: string): WireEntry[] {
  const crumbs: WireEntry[] = []
  let current = target
  for (;;) {
    const parent = posix.dirname(current)
    crumbs.unshift({ name: parent === current ? current : posix.basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * Mount the connection registry and the `/dsh-ssh` channel.
 * @param ctx - the mounting Cordis context.
 * @param config - state file and listing bound.
 */
export function apply(ctx: Context, config: WebChannelConfig): void {
  ctx.plugin(SshRegistry, { ...(config.stateFile !== undefined ? { stateFile: config.stateFile } : {}) })
  const maxEntries = config.maxEntries ?? 1000
  const registry = (): SshRegistry => {
    const value = ctx.get('sshRegistry')
    if (value === undefined) throw new Error('dsh-ssh: the connection registry is not mounted')
    return value
  }
  const requireConnection = (id: string): SshConnection => {
    const connection = registry().get(id)
    if (connection === undefined) throw new Error(`dsh-ssh: unknown connection id ${JSON.stringify(id)}`)
    return connection
  }

  /**
   * Refresh the human-readable route manifest beside the connection state so
   * an agent can learn route → host even while a route is offline.
   */
  const refreshRoutesManifest = (): void => {
    // The registry is mounted through `ctx.plugin` and only becomes visible once
    // its fiber activates, which may not have happened at the scheduled tick. The
    // manifest is auxiliary (each connection write refreshes it), so skip quietly
    // instead of failing the boot when the service is not mounted yet.
    const reg = ctx.get('sshRegistry') as SshRegistry | undefined
    if (reg === undefined) return
    writeRoutesManifest(
      reg.stateFilePath,
      reg.list() as unknown as RoutesManifestEntry[],
      (message) => void ctx.logger.warn(message),
    )
  }
  setTimeout(() => refreshRoutesManifest(), 0)

  /** The remote home directory: the login environment's HOME, else the spec cwd. */
  const remoteHome = async (id: string, signal?: AbortSignal): Promise<string> => {
    const connection = requireConnection(id)
    try {
      const environment = await connection.getRemoteEnvironment(signal)
      const home = environment.HOME
      if (isString(home) && home.trim() !== '') return home
    } catch {
      // A dead connection falls back below; the listing itself still surfaces it.
    }
    return connection.spec.cwd ?? '/root'
  }

  /** List one remote level over the connection's shared SFTP channel. */
  const listRemote = async (id: string, target: string | undefined, signal?: AbortSignal): Promise<WireListing> => {
    const connection = requireConnection(id)
    const resolvedTarget = target ?? await remoteHome(id, signal)
    if (!posix.isAbsolute(resolvedTarget)) {
      throw new Error(`dsh-ssh: cannot list ${resolvedTarget}: not a fully qualified path`)
    }
    const home = await remoteHome(id, signal)
    const sftp: SFTPWrapper = await connection.getSftp(signal)
    const listed = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolvePromise, reject) => {
      sftp.readdir(resolvedTarget, (error, entries) => {
        if (error !== undefined) reject(error)
        else resolvePromise(entries)
      })
    })
    const entries: WireEntry[] = []
    let truncated = false
    for (const entry of listed) {
      signal?.throwIfAborted()
      const candidate = entry.filename
      if (!entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) continue
      let enterable = entry.attrs.isDirectory()
      if (!enterable) {
        try {
          const stats = await new Promise<Stats>((resolvePromise, reject) => {
            sftp.stat(posix.join(resolvedTarget, candidate), (error, value) => {
              if (error !== undefined) reject(error)
              else resolvePromise(value)
            })
          })
          enterable = stats.isDirectory()
        } catch {
          if (signal?.aborted === true) throw signal.reason
          continue
        }
      }
      if (!enterable) continue
      if (entries.length === maxEntries) {
        truncated = true
        break
      }
      entries.push({ name: candidate, path: posix.join(resolvedTarget, candidate), hidden: candidate.startsWith('.') })
    }
    return {
      path: resolvedTarget,
      home,
      crumbs: ancestryCrumbs(resolvedTarget),
      entries,
      truncated,
    }
  }

  /** Create one child directory on the remote host (SFTP mkdir, non-recursive). */
  const createRemoteDirectory = async (id: string, path: string, name: string, signal?: AbortSignal): Promise<string> => {
    if (!posix.isAbsolute(path)) throw new Error(`dsh-ssh: cannot create under ${JSON.stringify(path)}: not a fully qualified path`)
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new Error(`dsh-ssh: ${JSON.stringify(name)} is not a single path segment`)
    }
    const target = posix.join(path, name)
    const connection = requireConnection(id)
    const sftp = await connection.getSftp(signal)
    const existing = await new Promise<Stats | undefined>((resolvePromise) => {
      sftp.lstat(target, (error, value) => { resolvePromise(error === undefined ? value : undefined) })
    })
    if (existing !== undefined) throw new Error(`dsh-ssh: ${target} already exists`)
    await new Promise<void>((resolvePromise, reject) => {
      sftp.mkdir(target, (error) => { if (error !== undefined) reject(error); else resolvePromise() })
    })
    return target
  }

  const dispatch = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ChannelResult> => {
    try {
      switch (endpoint) {
        case 'connections.list': return { ok: true, value: registry().list() }
        case 'config.hosts': {
          // Re-reads ~/.ssh/config on every call; wildcards stay hidden.
          return { ok: true, value: registry().listConfigHosts() }
        }
        case 'connections.resolve': {
          const input = requirePayload(payload, isRecord, 'connections.resolve')
          const host = input.host
          if (!isString(host) || host.trim() === '') throw new Error('bad-request: host must be a non-empty string')
          const resolved = registry().resolveSshConfig(host.trim())
          return { ok: true, value: { ...resolved, alias: host.trim() } }
        }
        case 'connections.add': {
          const input = requirePayload(payload, isConnectionInput, 'connections.add')
          const added = registry().add(input)
          refreshRoutesManifest()
          return { ok: true, value: added }
        }
        case 'connections.remove': {
          const input = requirePayload(payload, isIdPayload, 'connections.remove')
          const removed = registry().remove(input.id.trim())
          if (removed) {
            // Drop the connection's local route placeholders; stale ones would
            // route to a dead registry id on the next session resume.
            void rm(sshRoutePlaceholder(input.id.trim(), '/'), { recursive: true, force: true })
              .catch(() => undefined)
            refreshRoutesManifest()
          }
          return { ok: true, value: { removed } }
        }
        case 'connections.test': {
          const input = requirePayload(payload, isConnectionInput, 'connections.test')
          const outcome = await registry().test(input)
          return outcome.ok ? { ok: true, value: { ok: true } } : wireError('connection-failed', outcome.message)
        }
        case 'browse.home': {
          const input = requirePayload(payload, isIdPayload, 'browse.home')
          return { ok: true, value: { path: await remoteHome(input.id.trim(), signal) } }
        }
        case 'browse.list': {
          const input = requirePayload(payload, isBrowsePayload, 'browse.list')
          return { ok: true, value: await listRemote(input.id.trim(), input.path, signal) }
        }
        case 'browse.mkdir': {
          const input = requirePayload(payload, isRecord, 'browse.mkdir')
          if (!isString(input.id) || !isString(input.path) || !isString(input.name)) {
            throw new Error('bad-request: browse.mkdir needs id, path, and name')
          }
          const created = await createRemoteDirectory(input.id.trim(), input.path, input.name, signal)
          return { ok: true, value: { path: created } }
        }
        case 'session.route': {
          // The host's session service `mkdir`s the project directory through
          // `node:fs`, so an `ssh://` cwd can never pass; hand the client a
          // LOCAL placeholder instead, which both sides translate back into
          // the registry route (see transport.ts).
          const input = requirePayload(payload, isSessionRoutePayload, 'session.route')
          requireConnection(input.id.trim())
          const placeholder = sshRoutePlaceholder(input.id.trim(), input.path)
          await mkdir(placeholder, { recursive: true })
          return { ok: true, value: { cwd: placeholder } }
        }
        case 'local.pickNative': {
          // One OS folder chooser on the host display — faster than walking
          // the browse list for local workspaces. Null means the operator
          // cancelled.
          const path = await pickNativeDirectory(signal)
          return { ok: true, value: { path } }
        }
        default:
          throw new Error(`bad-request: unknown endpoint ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      const message = messageOf(error)
      const code = message.startsWith('bad-request:') ? 'bad-request' : 'connection-failed'
      return wireError(code, message.replace(/^bad-request: /u, ''))
    }
  }

  // DSH 0.1.5 regression workaround: `ctx.connection.rpc.handle` broke when
  // `dsh-client-connection` dropped `webServer` from its `inject` (commit
  // 2ef85b1e17). Register the `/dsh-ssh` route directly against the web server
  // and reuse Connection's public `requestRejection` fence so the channel keeps
  // the same Host/Origin + browser authentication as before.
  const CHANNEL = '/dsh-ssh'
  const route = {
    kind: 'prefix' as const,
    path: CHANNEL,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const rejection = ctx.connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await serveRpcChannel(req, res, CHANNEL, dispatch)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsh-ssh: /dsh-ssh rpc channel')

  // Agent-facing surface: routing identity in the runtime context, DSH_SSH_*
  // shell environment, and the ssh_exec model tool. Each registration is
  // optional and no-ops for non-routed sessions (see agent-experience.ts).
  installAgentExperience(ctx)
}
