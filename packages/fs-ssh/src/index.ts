/**
 * `ctx.fs` over SSH, helper-backed.
 *
 * Every operation is one helper round trip, which is the point: the shipped
 * SFTP+exec implementation pays an `exec` (`realpath -mz | base64`) **per
 * directory entry** when listing (`filesystem-final.ts:285-287,367`), so a
 * 500-file directory costs 500 serial round trips. Here `listdir` returns names,
 * types, sizes, and version tokens together.
 *
 * The other three differences from an SFTP-only provider, all forced by the
 * contract:
 *
 *  * **`resolve` needs `realpath -m` semantics** — a path whose last segment does
 *    not exist yet must still canonicalize, because that is where every file
 *    creation starts. SFTP's `realpath` fails there.
 *  * **Atomic publication** — SFTP v3 rename does not overwrite (OpenSSH returns
 *    FAILURE), and unlink+rename is not atomic. The helper uses `os.replace`.
 *    `createIfAbsent` uses `os.link`, whose EEXIST is the race-free proof that
 *    the file already existed.
 *  * **Version tokens carry inode and nanoseconds**
 *    (`dev:ino:size:mode:mtime_ns:ctime_ns`). SFTP v3 exposes only second-grained
 *    mtime and no inode, so a same-size rewrite inside one second is invisible to
 *    it — precisely the case a stale-edit guard exists to catch.
 *
 * Reads are bounded in the helper and streamed: `readBytes` enforces `maxBytes`
 * as a pre-check AND during transfer, so a file that grows after the check still
 * fails with `FS_TOO_LARGE` instead of exhausting host memory.
 *
 * @module
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { FsProviderError, assertNotAborted, mapFsError } from './errors.ts'
import { contains, fileUrl, resolveLexically } from './paths.ts'
import { TextStreamDecoder, decodeText, detectsCrlf, normalizeLineEndings, restoreLineEndings } from './text.ts'
import { applyEdit, enforceGuard } from './edit.ts'
import type { WriteGuard } from './edit.ts'
import { SshHelperRouter } from '../../ssh-gui/src/helper-router.ts'
import type { HelperTransport } from '../../ssh-gui/src/helper-router.ts'
import { parseSshRoute } from '../../ssh-gui/src/registry.ts'

/** Metadata one helper `stat` reports. */
interface HelperStat {
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  version: string
}

/** One directory entry the helper reports, already carrying its metadata. */
interface HelperEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  version: string
}

/** What this provider needs from the connection owner. */
export interface SshFsConnection {
  /** Absolute remote workspace directory. */
  readonly cwd: string
  /**
   * Issue one helper request.
   * @param op - operation name.
   * @param payload - operation fields.
   * @param options - `onData` receives streamed payload chunks.
   */
  request(
    op: string,
    payload: object,
    options?: { onData?: (chunk: Buffer) => void },
  ): Promise<unknown>
}

/** A resolved target, mirroring the seam's `FsTarget`. */
export interface Target {
  targetKey: string
  displayPath: string
}

/**
 * The remote filesystem service.
 *
 * Extends the seam's own `FileSystem` so registration and service identity match
 * the harness exactly.
 */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh']

  private readonly router: SshHelperRouter

  constructor(ctx: Context) {
    super(ctx, 'fs')
    this.router = new SshHelperRouter(ctx)
  }

  /** The transport and remote path one target names, resolved per operation. */
  private routeFor(target: Target): { transport: HelperTransport; path: string; connectionId?: string } {
    return this.router.resolveTargetKey(String(target.targetKey))
  }

  /**
   * Canonicalize a path into a stable target.
   *
   * The same file must always produce the same `targetKey`, because containment
   * and staleness are string comparisons over it. Canonicalization happens here
   * and nowhere else. A caller cwd of `ssh://<id>/<path>` (or its local
   * placeholder twin) routes the target onto that registry connection.
   * @param path - absolute or relative POSIX path.
   * @param opts - `cwd` for relative resolution, plus an abort signal.
   * @returns the resolved target.
   */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<Target> {
    const signal = opts?.signal
    assertNotAborted(signal, 'resolve')
    if (path.trim().length === 0) {
      throw new FsProviderError('cannot resolve an empty path', 'FS_NOT_FOUND')
    }
    const route = this.router.resolveCwd(opts?.cwd)
    const base = route.base
    const displayPath = route.connectionId === undefined ? path : `ssh://${route.connectionId}${base}/${path}`.replaceAll('//', '/')
    try {
      // `realpath -m` semantics: a missing final segment still canonicalizes,
      // which is what makes creating a new file possible.
      const result = (await route.transport.request('realpath', {
        path,
        cwd: base,
      })) as { path: string }
      const targetKey =
        route.connectionId === undefined ? result.path : `ssh://${route.connectionId}${result.path}`
      return {
        targetKey: FsTargetKey(targetKey) as unknown as string,
        displayPath,
      }
    } catch (error: unknown) {
      throw mapFsError(error, 'resolve', displayPath, signal)
    }
  }

  /** The absolute remote path inside this provider's execution world. */
  override processPath(target: Target): string {
    // Synchronous, no I/O: the key is either a plain remote path or an
    // `ssh://<id>/<path>` route whose remote part is extracted by the router.
    return this.routeFor(target).path
  }

  /** A `file:` URL for the target, with provider-owned encoding. */
  override fileUrl(target: Target): string {
    const path = this.processPath(target)
    return fileUrl(path)
  }

  /** Whether `child` is at or below `parent`; reflexive, never re-resolves. */
  override contains(parent: Target, child: Target): boolean {
    // Targets on different connections are never contained in one another.
    const parentRoute = parseSshRoute(String(parent.targetKey))
    const childRoute = parseSshRoute(String(child.targetKey))
    const parentId = parentRoute?.id
    const childId = childRoute?.id
    if (parentId !== childId) return false
    const parentPath = parentRoute?.path ?? String(parent.targetKey)
    const childPath = childRoute?.path ?? String(child.targetKey)
    return contains(parentPath, childPath)
  }

  /**
   * Metadata for a target, following symlinks.
   * @returns the info, or `undefined` when the path does not exist.
   */
  override async stat(target: Target, signal?: AbortSignal): Promise<
    { version: ReturnType<typeof FsVersion>; type: 'file' | 'directory' | 'other'; size?: number } | undefined
  > {
    assertNotAborted(signal, 'stat')
    const route = this.routeFor(target)
    try {
      const result = (await route.transport.request('stat', { path: route.path })) as
        | { present: false }
        | { present: true; info: HelperStat }
      if (!result.present) return undefined
      // The seam's FsInfo has no symlink branch: a followed symlink reports its
      // destination's kind.
      const type = result.info.type === 'symlink' ? 'other' : result.info.type
      const info: { version: ReturnType<typeof FsVersion>; type: 'file' | 'directory' | 'other'; size?: number } = {
        version: FsVersion(result.info.version),
        type,
      }
      if (result.info.size !== undefined) info.size = result.info.size
      return info
    } catch (error: unknown) {
      throw mapFsError(error, 'stat', target.displayPath, signal)
    }
  }

  /**
   * Metadata for a path without following its final symlink.
   *
   * Takes a path rather than a target, and resolves it **lexically**: a
   * `realpath` round trip would follow the very link this must report.
   */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<
    | { version: ReturnType<typeof FsVersion>; type: 'file' | 'directory' | 'symlink' | 'other'; size?: number }
    | undefined
  > {
    assertNotAborted(signal, 'lstat')
    const route = this.router.resolveCwd(opts?.cwd)
    const absolute = resolveLexically(path, route.base)
    try {
      const result = (await route.transport.request('lstat', { path: absolute })) as
        | { present: false }
        | { present: true; info: HelperStat }
      if (!result.present) return undefined
      const info: {
        version: ReturnType<typeof FsVersion>
        type: 'file' | 'directory' | 'symlink' | 'other'
        size?: number
      } = { version: FsVersion(result.info.version), type: result.info.type }
      if (result.info.size !== undefined) info.size = result.info.size
      return info
    } catch (error: unknown) {
      throw mapFsError(error, 'lstat', path, signal)
    }
  }

  /**
   * Direct children of a directory, in stable name order, with metadata.
   *
   * One round trip for the whole directory. The shipped SFTP provider issues one
   * `exec` per entry here, which turns an ordinary listing into hundreds of
   * serial round trips.
   */
  override async listDir(
    target: Target,
    signal?: AbortSignal,
  ): Promise<
    {
      name: string
      type: 'file' | 'directory' | 'symlink' | 'other'
      target: Target
      version?: ReturnType<typeof FsVersion>
      size?: number
    }[]
  > {
    assertNotAborted(signal, 'listDir')
    const route = this.routeFor(target)
    try {
      const result = (await route.transport.request('listdir', { path: route.path })) as { entries: HelperEntry[] }
      return result.entries
        // Stable order is contract; the helper sorts, and sorting again here
        // keeps the guarantee independent of the helper version.
        .slice()
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((entry) => {
          const remoteChild = posix.join(route.path, entry.name)
          const child: {
            name: string
            type: 'file' | 'directory' | 'symlink' | 'other'
            target: Target
            version?: ReturnType<typeof FsVersion>
            size?: number
          } = {
            name: entry.name,
            type: entry.type,
            target: {
              targetKey: FsTargetKey(
                route.connectionId === undefined ? remoteChild : `ssh://${route.connectionId}${remoteChild}`,
              ) as unknown as string,
              displayPath: remoteChild,
            },
          }
          if (entry.version.length > 0) child.version = FsVersion(entry.version)
          if (entry.size !== undefined) child.size = entry.size
          return child
        })
    } catch (error: unknown) {
      throw mapFsError(error, 'listDir', target.displayPath, signal)
    }
  }

  /** Whole-file text, refusing binary and invalid UTF-8. */
  override async readText(target: Target, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readRaw(target, signal, undefined, 'read')
    return normalizeLineEndings(decodeText(bytes, target.displayPath))
  }

  /**
   * Raw bytes with a hard cap.
   *
   * The cap is enforced twice — before transfer from the stat size, and during
   * transfer by the helper — so a file that grows between the two still fails
   * with `FS_TOO_LARGE` rather than exhausting memory. Truncation is never a
   * substitute (`index.ts:202-212`).
   */
  override async readBytes(target: Target, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return await this.readRaw(target, signal, maxBytes, 'read')
  }

  /** Chunked text, decoded across chunk boundaries. */
  override async *streamText(target: Target, signal?: AbortSignal): AsyncIterable<string> {
    assertNotAborted(signal, 'streamText')
    const route = this.routeFor(target)
    const decoder = new TextStreamDecoder(target.displayPath)
    const chunks: string[] = []
    try {
      await route.transport.request(
        'read',
        { path: route.path },
        {
          onData: (chunk) => {
            // Decoding happens in the callback so a binary file is rejected as
            // early as possible rather than after the whole transfer.
            const text = decoder.push(chunk)
            if (text.length > 0) chunks.push(text)
          },
        },
      )
    } catch (error: unknown) {
      throw mapFsError(error, 'streamText', target.displayPath, signal)
    }
    const tail = decoder.end()
    if (tail.length > 0) chunks.push(tail)
    for (const chunk of chunks) {
      assertNotAborted(signal, 'streamText')
      yield normalizeLineEndings(chunk)
    }
  }

  private async readRaw(
    target: Target,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
    operation: string,
  ): Promise<Uint8Array> {
    assertNotAborted(signal, operation)
    const route = this.routeFor(target)
    const parts: Buffer[] = []
    try {
      await route.transport.request(
        'read',
        { path: route.path, ...(maxBytes === undefined ? {} : { maxBytes }) },
        { onData: (chunk) => void parts.push(chunk) },
      )
    } catch (error: unknown) {
      throw mapFsError(error, operation, target.displayPath, signal)
    }
    assertNotAborted(signal, operation)
    return Buffer.concat(parts)
  }

  /**
   * Create or replace a file atomically.
   *
   * Ordering matters: the guard is enforced against observed state, the content
   * is staged, and only then is the target replaced. Abort is checked before the
   * atomic publication, never after — a cancelled write must not have happened
   * (`index.ts:223-241`).
   */
  override async writeText(
    target: Target,
    content: string,
    expected?: WriteGuard,
    signal?: AbortSignal,
  ): Promise<{ operation: 'create' | 'update'; version: ReturnType<typeof FsVersion>; before: string | null; after: string }> {
    assertNotAborted(signal, 'write')
    const route = this.routeFor(target)
    const guard = expected ?? { kind: 'unconditional' as const }
    try {
      const existing = await this.stat(target, signal)
      enforceGuard(guard, existing === undefined ? undefined : String(existing.version))
      assertNotAborted(signal, 'write')

      let before: string | null = null
      // The line-ending convention comes from the CALLER'S content first: a
      // create with CRLF text must land as CRLF, or the write silently rewrites
      // every line on the way in. An update keeps the file's existing convention.
      let crlf = detectsCrlf(content)
      if (existing !== undefined && existing.type === 'file') {
        // The baseline is best-effort: a binary predecessor yields `before: null`,
        // which the contract allows as a documented degradation.
        try {
          const raw = decodeText(await this.readRaw(target, signal, undefined, 'write'), target.displayPath)
          crlf = detectsCrlf(raw)
          before = normalizeLineEndings(raw)
        } catch {
          before = null
        }
      }
      assertNotAborted(signal, 'write')

      const payload = restoreLineEndings(normalizeLineEndings(content), crlf)
      const result = (await route.transport.request('write', {
        path: route.path,
        dataB64: Buffer.from(payload, 'utf8').toString('base64'),
        // Exclusive creation is the race-free implementation of createIfAbsent:
        // its EEXIST is proof, where a stat-then-write would have a window.
        exclusive: guard.kind === 'createIfAbsent',
      })) as { version: string }
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: FsVersion(result.version),
        before,
        after: normalizeLineEndings(content),
      }
    } catch (error: unknown) {
      throw mapFsError(error, 'write', target.displayPath, signal)
    }
  }

  /**
   * Replace literal text atomically.
   *
   * The version check precedes matching, and a target that vanished mid-edit is
   * `FS_STALE_VERSION` rather than `FS_NOT_FOUND`: what went stale is the
   * caller's belief about the file.
   */
  override async editText(
    target: Target,
    edit: { oldString: string; newString: string; replaceAll?: boolean },
    expected?: WriteGuard,
    signal?: AbortSignal,
  ): Promise<{ version: ReturnType<typeof FsVersion>; before: string; after: string }> {
    assertNotAborted(signal, 'edit')
    const route = this.routeFor(target)
    try {
      const existing = await this.stat(target, signal)
      if (existing === undefined) {
        throw new FsProviderError('the file no longer exists', 'FS_STALE_VERSION')
      }
      if (expected !== undefined) {
        enforceGuard(expected, String(existing.version))
      }
      assertNotAborted(signal, 'edit')

      const raw = decodeText(await this.readRaw(target, signal, undefined, 'edit'), target.displayPath)
      const crlf = detectsCrlf(raw)
      const result = applyEdit(normalizeLineEndings(raw), edit)
      assertNotAborted(signal, 'edit')

      const written = (await route.transport.request('write', {
        path: route.path,
        dataB64: Buffer.from(restoreLineEndings(result.after, crlf), 'utf8').toString('base64'),
        exclusive: false,
        // The version the edit was computed against: the helper refuses to
        // publish if the file changed in between, closing the read-modify-write
        // window that a client-side check alone cannot.
        ifVersion: String(existing.version),
      })) as { version: string }
      return { version: FsVersion(written.version), before: result.before, after: result.after }
    } catch (error: unknown) {
      throw mapFsError(error, 'edit', target.displayPath, signal)
    }
  }
}

export default SshFileSystem
