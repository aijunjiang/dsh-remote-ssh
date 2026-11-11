/**
 * Mark each SSH-routed Workspace with the host it actually lives on.
 *
 * Why a title and not a badge: DSH 0.2.x stores only `path` / `title` /
 * `sessionIds` per Workspace and exposes no remote field, and the workspace
 * header row has no slot a plugin could draw into (the sidebar slots cover
 * session rows). A Workspace title, on the other hand, is user-editable and
 * survives restarts, so writing the host into it is the one place this
 * information can persist and stay visible without patching the host.
 *
 * The information is already here: a routed workspace's path spells its
 * connection id (`<dsh home>/dsh-ssh-routes/<connId>/<path>` or
 * `ssh://<connId>/<path>`), and the registry holds that connection's
 * `username@host`.
 *
 * Two rules keep this idempotent and non-destructive:
 *
 *  - A title that already carries the marker is rewritten from its BASE, never
 *    appended to, so repeated runs cannot stack prefixes.
 *  - A title the person annotated by hand ("name · user@host") is recognised
 *    and that manual suffix is dropped instead of duplicated.
 *
 * @module dsh-remote-ssh/workspace-labels
 */

import { parseSshRoute } from './registry.ts'

/** The marker that identifies a label this module wrote. */
export const REMOTE_MARK = '🌐'

/** `<connId>` inside a placeholder path or an `ssh://` URL. */
const ROUTE_IN_PATH = /(?:dsh-ssh-routes|ssh:)\/*([^/]+)\//

/**
 * Extract the connection id a workspace path routes through.
 * @param path - the Workspace's directory path.
 * @returns the id, or undefined for a local workspace.
 */
export function routedConnectionId(path: string | undefined): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined
  const parsed = path.startsWith('ssh://') ? parseSshRoute(path) : null
  if (parsed !== null) return parsed.id
  const match = path.match(ROUTE_IN_PATH)
  return match === null ? undefined : match[1]
}

/**
 * Strip every label this module could have written, plus any trailing manual
 * ` · user@host`, until the title is stable.
 *
 * Loops rather than peeling once: a title that already accumulated prefixes
 * (from a version that trusted the stale record, say) must come back to its
 * real base instead of keeping the damage. Every pass removes at least one
 * marker or stops, so this terminates.
 */
function baseTitle(title: string, label: string): string {
  let base = title
  for (let guard = 0; guard < 8; guard += 1) {
    const before = base
    // This module writes `🌐 <label> · <base>`, so the prefix to remove is the
    // marker AND the label that follows it — peeling only the marker leaves the
    // label behind, which is what produced `🌐 host · host · name` on a second
    // boot.
    const written = `${REMOTE_MARK} ${label} · `
    if (base.startsWith(written)) base = base.slice(written.length)
    else if (base.startsWith(`${REMOTE_MARK} `)) base = base.slice(REMOTE_MARK.length + 1)
    const locked = `🔒 ${label} · `
    if (base.startsWith(locked)) base = base.slice(locked.length)
    else if (base.startsWith('🔒 ')) base = base.slice(3)
    // A hand-written `name · user@host` carries the label at the END.
    const manual = ` · ${label}`
    // A title equal to the label alone is all prefix and no name; leave it be.
    if (base.endsWith(manual) && base.length > manual.length) base = base.slice(0, -manual.length)
    if (base === before) return base
  }
  return base
}

/** One workspace this module would relabel. */
export interface WorkspaceLabelPlan {
  readonly id: string
  readonly before: string
  readonly after: string
}

/** The Workspace shape this module reads. */
interface WorkspaceLike {
  readonly id?: unknown
  /** Projection convenience fields; the authoritative record sits below. */
  readonly title?: unknown
  readonly path?: unknown
  readonly record?: { path?: unknown; title?: unknown }
  setTitle?(title: string): unknown
}

/** The connection shape `sshRegistry.list()` returns: flat, not nested under `spec`. */
interface ConnectionLike {
  readonly id?: unknown
  readonly host?: unknown
  readonly username?: unknown
  readonly spec?: { host?: unknown; username?: unknown }
}

/**
 * Plan (and optionally apply) the labels for every routed Workspace.
 *
 * Nothing is written unless a title actually changes, so a deployment whose
 * titles are already correct costs one pass and no writes.
 *
 * @param ctx - cordis context; `workspaceRegistry` and `sshRegistry` are read lazily.
 * @param options.apply - write the new titles; false returns the plan only.
 * @returns the plan, plus how many workspaces were written.
 */
export async function labelRoutedWorkspaces(
  ctx: { get?: (name: string) => unknown },
  options: { apply: boolean },
): Promise<{ plan: WorkspaceLabelPlan[]; written: number }> {
  const registry = ctx.get?.('workspaceRegistry') as
    | { list?: () => WorkspaceLike[] }
    | undefined
  const connections = ctx.get?.('sshRegistry') as
    | { list?: () => ConnectionLike[] }
    | undefined
  if (registry?.list === undefined) return { plan: [], written: 0 }

  /** connection id → `user@host`, so the title names a machine, not an id. */
  const labelOf = new Map<string, string>()
  for (const connection of connections?.list?.() ?? []) {
    const id = typeof connection.id === 'string' ? connection.id : undefined
    // Accept both spellings: the registry's list() flattens host/username, while
    // an older shape nested them under `spec`.
    const host = connection.host ?? connection.spec?.host
    const username = connection.username ?? connection.spec?.username
    if (id === undefined || typeof host !== 'string') continue
    labelOf.set(id, typeof username === 'string' && username !== '' ? `${username}@${host}` : host)
  }

  const plan: WorkspaceLabelPlan[] = []
  let written = 0
  for (const workspace of registry.list()) {
    const id = typeof workspace.id === 'string' ? workspace.id : undefined
    // The projection can serve a STALE title right after `setTitle` (the entity
    // updated, the snapshot the list returned did not). Because the label is
    // rebuilt from whatever string is read here, a stale read stacks another
    // prefix on every boot — so `baseTitle` strips REPEATEDLY and both spellings
    // are considered.
    const stored = typeof workspace.record?.title === 'string' ? workspace.record.title : undefined
    const live = typeof workspace.title === 'string' ? workspace.title : undefined
    const title = live ?? stored
    const path = typeof workspace.path === 'string'
      ? workspace.path
      : typeof workspace.record?.path === 'string' ? workspace.record.path : undefined
    if (id === undefined || title === undefined) continue

    const connectionId = routedConnectionId(path)
    if (connectionId === undefined) continue
    const label = labelOf.get(connectionId) ?? connectionId
    const after = `${REMOTE_MARK} ${label} · ${baseTitle(title, label)}`
    if (after === title) continue
    plan.push({ id, before: title, after })
    if (options.apply && typeof workspace.setTitle === 'function') {
      try {
        await workspace.setTitle(after)
        written += 1
      } catch {
        // A refused rename (a title another workspace already holds, a race
        // with the user) must not take the plugin down: it is a cosmetic label.
      }
    }
  }
  return { plan, written }
}
