/**
 * Path identity for the remote filesystem: target keys, display paths,
 * containment, and `file:` URLs.
 *
 * The contract's sharpest requirement is that **the same file always yields the
 * same `targetKey`** (`packages/fs/fs/src/index.ts:108-116`), because containment
 * and staleness comparisons are string comparisons over that key. Canonicality
 * therefore happens once, in `resolve`, using the helper's `realpath -m`
 * semantics — SFTP's own `realpath` fails on a path whose last segment does not
 * exist yet, which is exactly the case every file creation starts from.
 *
 * `contains` must not re-resolve anything (`index.ts:150-157`): it is a pure
 * comparison, and it is **reflexive** — a target contains itself.
 *
 * @module
 */

import { posix } from 'node:path'

/**
 * Whether `child` is inside `parent`, or is `parent` itself.
 *
 * @param parentKey - canonical remote path of the container.
 * @param childKey - canonical remote path of the candidate.
 * @returns true when the child is at or below the parent.
 */
export function contains(parentKey: string, childKey: string): boolean {
  if (parentKey === childKey) return true
  const relative = posix.relative(parentKey, childKey)
  // An empty result means identity (already handled); a leading `..` means the
  // child escapes upward; an absolute result means they share no root.
  if (relative.length === 0) return true
  if (relative === '..' || relative.startsWith('../')) return false
  return !posix.isAbsolute(relative)
}

/**
 * Build a `file:` URL for a remote path.
 *
 * Encoding is the provider's responsibility (`index.ts:143-148`). Each segment is
 * encoded separately so the separators survive while spaces, `#`, `?`, and
 * non-ASCII names are escaped.
 * @param remotePath - absolute POSIX path on the target.
 * @returns a `file:` URI.
 */
export function fileUrl(remotePath: string): string {
  const encoded = remotePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `file://${encoded}`
}

/**
 * Resolve a caller path lexically against a working directory.
 *
 * Used for `lstat`, which takes a path rather than a target and must NOT follow
 * the final symlink — so it must also not pay for a `realpath` round trip
 * (`index.ts:181`). Purely lexical: `..` is collapsed textually.
 * @param path - absolute or relative POSIX path.
 * @param cwd - absolute remote working directory.
 */
export function resolveLexically(path: string, cwd: string): string {
  return posix.resolve(cwd, path)
}

/**
 * The display path shown to the model and UI.
 *
 * Relative to the workspace root when inside it, absolute otherwise: a path
 * outside the workspace must not be dressed up as a workspace-relative one.
 * @param remotePath - canonical remote path.
 * @param root - the connection's workspace root.
 */
export function displayPathFor(remotePath: string, root: string): string {
  if (remotePath === root) return '.'
  const relative = posix.relative(root, remotePath)
  if (relative.length === 0) return '.'
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return remotePath
  return relative
}
