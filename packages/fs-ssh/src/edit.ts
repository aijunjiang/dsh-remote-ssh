/**
 * Literal text editing and write guards.
 *
 * The ordering here is contract, not preference
 * (`packages/fs/fs/src/index.ts:223-262`, `types.ts:118-122`):
 *
 *  1. **Version check precedes matching.** A stale `expected` version must report
 *     `FS_STALE_VERSION` even when the edit would also have failed to match —
 *     otherwise a caller retries a doomed edit against a file that changed
 *     underneath it, and the diagnostic points at the wrong problem.
 *  2. **A vanished target during edit is `FS_STALE_VERSION`, not
 *     `FS_NOT_FOUND`** (`fs-e2b/src/index.ts:413-415`): the caller's belief about
 *     the file is what went stale.
 *  3. **Guards are two shapes, not three.** `createIfAbsent` meeting an existing
 *     file is `FS_NOT_OBSERVED`; `replaceIfVersion` meeting an absent or
 *     mismatched file is `FS_STALE_VERSION`; omitting a guard is an
 *     unconditional overwrite — not a third behaviour.
 *  4. **Matching happens on LF-normalized text**, while the bytes written keep
 *     the file's own convention.
 *
 * All of it is pure string work, so all of it is verified here rather than on a
 * remote host.
 *
 * @module
 */

/** Error codes this module can raise, all from the seam's vocabulary. */
export type EditErrorCode =
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'

/** A coded failure; mirrors the seam's `FsError`. */
export class FsEditError extends Error {
  readonly code: EditErrorCode

  constructor(message: string, code: EditErrorCode) {
    super(message)
    this.name = 'FsError'
    this.code = code
  }
}

/** One literal replacement request. */
export interface EditRequest {
  /** Literal text to find; empty is refused. */
  oldString: string
  /** Literal replacement. */
  newString: string
  /** Replace every occurrence; otherwise exactly one match is required. */
  replaceAll?: boolean
}

/** A write guard, mirroring the seam's `FsWriteIntent`. */
export type WriteGuard =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }
  | { kind: 'unconditional' }

/**
 * Apply a guard to what the provider observed on the target.
 *
 * @param guard - the caller's intent.
 * @param observed - the target's current version, or `undefined` when absent.
 * @throws {FsEditError} when the guard rejects the observed state.
 */
export function enforceGuard(guard: WriteGuard, observed: string | undefined): void {
  if (guard.kind === 'unconditional') return
  if (guard.kind === 'createIfAbsent') {
    if (observed !== undefined) {
      throw new FsEditError('the file already exists', 'FS_NOT_OBSERVED')
    }
    return
  }
  // replaceIfVersion: absent and mismatched are the same failure, because both
  // mean the caller's belief about the file no longer holds.
  if (observed === undefined) {
    throw new FsEditError('the file no longer exists', 'FS_STALE_VERSION')
  }
  if (observed !== guard.version) {
    throw new FsEditError('the file changed since it was observed', 'FS_STALE_VERSION')
  }
}

/** The result of applying one edit to LF-normalized text. */
export interface EditResult {
  /** LF-normalized text before the edit. */
  before: string
  /** LF-normalized text after the edit. */
  after: string
  /** Occurrences replaced. */
  replacements: number
}

/**
 * Apply one literal edit to normalized text.
 *
 * @param normalized - the file's LF-normalized current text.
 * @param edit - the literal replacement request.
 * @returns the before/after text and the replacement count.
 * @throws {FsEditError} `FS_EDIT_NOT_FOUND` when `oldString` is empty or absent;
 *   `FS_AMBIGUOUS_EDIT` when a single-match edit found several.
 */
export function applyEdit(normalized: string, edit: EditRequest): EditResult {
  // An empty needle would match everywhere; the seam classifies it as
  // not-found rather than replacing at every position.
  if (edit.oldString.length === 0) {
    throw new FsEditError('the text to replace must not be empty', 'FS_EDIT_NOT_FOUND')
  }
  // Callers hand us already-normalized needles in the normal path, but a literal
  // CRLF needle against a normalized haystack would never match; normalizing
  // both sides keeps the comparison honest.
  const needle = edit.oldString.replaceAll('\r\n', '\n')
  const replacement = edit.newString.replaceAll('\r\n', '\n')

  const occurrences = countOccurrences(normalized, needle)
  if (occurrences === 0) {
    throw new FsEditError('the text to replace was not found', 'FS_EDIT_NOT_FOUND')
  }
  if (edit.replaceAll !== true && occurrences > 1) {
    throw new FsEditError(
      `the text to replace appears ${occurrences} times; provide a more specific match or replace all`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  const after = replaceLiteral(normalized, needle, replacement, edit.replaceAll === true)
  return { before: normalized, after, replacements: edit.replaceAll === true ? occurrences : 1 }
}

/**
 * Replace a literal needle without any pattern interpretation.
 *
 * `String.prototype.replace`/`replaceAll` interpret `$&`, `$1`, and `$$` inside
 * the REPLACEMENT even when the pattern is a plain string. Text containing those
 * sequences is ordinary content — sed scripts, regex literals, CI templates — so
 * using the built-ins here would silently corrupt exactly the files most likely
 * to contain them. Index walking plus slicing has no such surface.
 *
 * @param haystack - text to edit.
 * @param needle - non-empty literal to find.
 * @param replacement - literal replacement, inserted verbatim.
 * @param all - replace every occurrence instead of the first.
 * @returns the edited text.
 */
export function replaceLiteral(haystack: string, needle: string, replacement: string, all: boolean): string {
  let result = ''
  let from = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    result += haystack.slice(from, index) + replacement
    from = index + needle.length
    if (!all) break
    index = haystack.indexOf(needle, from)
  }
  return result + haystack.slice(from)
}

/**
 * Count non-overlapping occurrences of a literal needle.
 *
 * `split().length - 1` would be shorter but allocates the whole haystack again;
 * `indexOf` walking keeps a large file's edit from doubling memory.
 * @param haystack - text to search.
 * @param needle - non-empty literal.
 */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
