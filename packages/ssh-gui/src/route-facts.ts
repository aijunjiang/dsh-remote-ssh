/**
 * Session-route facts: turn a session working directory into the registry
 * connection and remote path it names, plus the human-readable identity text
 * the runtime context and environment variables carry.
 *
 * Pure functions — no ctx, no network — so the agent-facing surface can be
 * unit-tested without a target.
 * @module dsh-ssh-gui/route-facts
 */

import { parseSshRoute } from './registry.ts'
import { routeFromPlaceholder } from './transport.ts'
import type { SshConnection } from './connection.ts'

/** A working directory that names one registry route. */
export interface RoutedCwd {
  /** Registry connection id (`c1`, `c2`, …). */
  id: string
  /** Absolute POSIX path on the remote host. */
  path: string
}

/**
 * Parse a caller working directory into a route, or null when it does not
 * name one. Accepts both spellings: `ssh://<id>/<abs>` and its local
 * placeholder twin (`<dsh home>/dsh-ssh-routes/<id>/<remote path…>`).
 */
export function parseRoutedCwd(cwd: string | undefined): RoutedCwd | null {
  if (cwd === undefined) return null
  const parsed = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : routeFromPlaceholder(cwd)
  if (parsed === null) return null
  return { id: parsed.id, path: parsed.path }
}

/** Route facts enriched with the registry connection's identity. */
export interface RouteFacts extends RoutedCwd {
  host: string
  port: number
  username: string
  /** `username@host` (no port) — the connection's own spelling. */
  endpoint: string
  label: string
}

/** Resolve route facts against one registry connection (null when unknown). */
export function routeFactsFor(
  connection: SshConnection | undefined,
  routed: RoutedCwd,
): RouteFacts | null {
  if (connection === undefined) return null
  return {
    id: routed.id,
    path: routed.path,
    host: connection.spec.host,
    port: connection.spec.port,
    username: connection.spec.username,
    endpoint: connection.endpoint,
    label: connection.label,
  }
}

/**
 * The one-sentence routing identity the runtime context and ssh_exec tool
 * surface. Bilingual: English first (the harness prompt language), one Chinese
 * line for the operator-facing certainty.
 */
export function routeIdentityText(facts: RouteFacts): string {
  const port = facts.port !== 22 ? `:${facts.port}` : ''
  return [
    `This session's working directory is on SSH route \`${facts.id}\` (${facts.username}@${facts.host}${port});`
      + ` its remote absolute path is ${facts.path}.`,
    `当前会话经 SSH 路由 \`${facts.id}\` 指向远端主机 ${facts.endpoint}${port}，远端工作目录 ${facts.path}。`,
  ].join('\n')
}

/** Environment variables P1-5 exposes for one routed session. */
export interface RouteEnvironment {
  DSH_SSH_ROUTE_ID: string
  DSH_SSH_HOST: string
  DSH_SSH_PORT: string
  DSH_SSH_USER: string
  DSH_SSH_ENDPOINT: string
  DSH_SSH_REMOTE_CWD: string
}

/**
 * The degraded warning for a working directory that SPELLS a route the host
 * cannot resolve (registry service absent, or the entry was removed while a
 * session kept pointing at it). Rendered instead of silence so a model never
 * reads the offline mirror as an empty project. Bilingual, English first.
 */
export function degradedRouteText(id: string, path: string, detail: string): string {
  return [
    `This session's working directory spells SSH route \`${id}\` (remote path ${path}), but that route is NOT resolvable right now: ${detail}.`
      + ' The mirrored directory may exist but its contents are NOT authoritative — treat it as empty-looking because it is offline, not because the project is empty.',
    `当前会话的 cwd 拼写指向 SSH 路由 \`${id}\`（远端路径 ${path}），但该路由当前不可解析：${detail}。镜像目录内容不可信，请勿把"读不到"当作"项目为空"。`,
  ].join('\n')
}

/** Build the trusted `DSH_SSH_*` snapshot for one routed session. */
export function routeEnvironment(facts: RouteFacts): RouteEnvironment {
  return {
    DSH_SSH_ROUTE_ID: facts.id,
    DSH_SSH_HOST: facts.host,
    DSH_SSH_PORT: String(facts.port),
    DSH_SSH_USER: facts.username,
    DSH_SSH_ENDPOINT: facts.endpoint,
    DSH_SSH_REMOTE_CWD: facts.path,
  }
}
