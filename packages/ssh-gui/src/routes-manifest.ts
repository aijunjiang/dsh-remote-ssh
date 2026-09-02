/**
 * Human-readable route manifest (P1-5): a plain JSON file beside the
 * connection state that maps route ids to their targets, so an agent (or an
 * operator) can learn "which host is c1" even when the connection registry
 * service is not answering and the mirrored directories are offline.
 *
 * Deliberately secret-free: only the registry's `list()` views (id/label/
 * host/port/username/cwd/auth/jumpHosts) are written — never passwords or key
 * material. Refreshed on every add/remove and once at mount.
 * @module dsh-ssh-gui/routes-manifest
 */

import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

/** One manifest entry; the secret-free registry view plus nothing else. */
export interface RoutesManifestEntry {
  id: string
  label: string
  host: string
  port: number
  username: string
  cwd?: string
  auth: string
  jumpHosts: string[]
}

/** The manifest document. */
export interface RoutesManifest {
  updatedAt: number
  connections: RoutesManifestEntry[]
}

/** Sibling file name of the connection state. */
export const ROUTES_MANIFEST_FILE = 'dsh-ssh-routes.json'

/**
 * The manifest path: the connection state's own directory (default
 * `<dsh home>/dsh-ssh-connections.json`, so the manifest lands at
 * `<dsh home>/dsh-ssh-routes.json`).
 */
export function routesManifestPath(stateFilePath: string): string {
  return join(dirname(stateFilePath), ROUTES_MANIFEST_FILE)
}

/** Build the manifest from registry views. */
export function buildRoutesManifest(views: RoutesManifestEntry[]): RoutesManifest {
  return { updatedAt: Date.now(), connections: views }
}

/**
 * Write the manifest beside the connection state. Failures are logged to the
 * caller and never throw — the manifest is a convenience, not authority.
 * @returns the written path, or undefined when the write failed.
 */
export function writeRoutesManifest(
  stateFilePath: string,
  views: RoutesManifestEntry[],
  log?: (message: string) => void,
): string | undefined {
  const path = routesManifestPath(stateFilePath)
  try {
    writeFileSync(path, JSON.stringify(buildRoutesManifest(views), null, 2) + '\n', 'utf8')
    return path
  } catch (error) {
    log?.(`dsh-ssh: cannot write route manifest to ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
