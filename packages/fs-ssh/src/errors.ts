/**
 * The single error funnel for the filesystem provider.
 *
 * Every operation routes failures through {@link mapFsError} in the order the
 * only shipped remote provider uses (`packages/e2b/fs-e2b/src/index.ts:135-147`):
 *
 *  1. an already-coded `FsError` passes through untouched — an inner layer that
 *     already classified precisely must not be reclassified by an outer catch;
 *  2. **abort is checked before anything else** — a cancelled operation reports
 *     `FS_ABORTED` even when the transport also produced an I/O error, because
 *     the cancellation is the cause and the I/O error is its symptom;
 *  3. a helper errno maps to its coded equivalent;
 *  4. everything unrecognized becomes `FS_IO_ERROR` rather than leaking a raw
 *     transport error to a tool.
 *
 * @module
 */

/** The seam's error vocabulary. */
export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/** A coded filesystem failure. */
export class FsProviderError extends Error {
  readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FsError'
    this.code = code
  }
}

/** Whether a value already carries a filesystem error code. */
function isCoded(error: unknown): error is { code: FsErrorCode } {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('FS_')
  )
}

/**
 * Map a helper errno name to the seam's vocabulary.
 * @param code - errno name such as `ENOENT`, or a helper code such as `E2BIG`.
 * @returns the coded equivalent, or `undefined` when unrecognized.
 */
export function codeForErrno(code: string): FsErrorCode | undefined {
  switch (code) {
    case 'ENOENT': {
      return 'FS_NOT_FOUND'
    }
    case 'ENOTDIR': {
      return 'FS_NOT_DIRECTORY'
    }
    case 'EISDIR': {
      return 'FS_NOT_REGULAR_FILE'
    }
    case 'EACCES':
    case 'EPERM': {
      return 'FS_PERMISSION_DENIED'
    }
    case 'E2BIG': {
      return 'FS_TOO_LARGE'
    }
    case 'EEXIST': {
      // Exclusive creation lost the race, which is the guard's failure, not an
      // I/O error: `createIfAbsent` reports FS_NOT_OBSERVED.
      return 'FS_NOT_OBSERVED'
    }
    case 'ESTALE': {
      // The helper's compare-and-swap refused to publish because the file
      // changed between the client's read and its write.
      return 'FS_STALE_VERSION'
    }
    default: {
      return undefined
    }
  }
}

/**
 * Funnel any thrown value into a coded filesystem error.
 *
 * @param error - whatever was thrown.
 * @param operation - operation name for the message (`read`, `write`, …).
 * @param displayPath - path as the model sees it.
 * @param signal - the operation's signal, checked before classifying.
 * @returns a coded error, ready to throw.
 */
export function mapFsError(
  error: unknown,
  operation: string,
  displayPath: string,
  signal?: AbortSignal,
): FsProviderError {
  if (error instanceof FsProviderError) return error
  if (isCoded(error)) {
    const message = error instanceof Error ? error.message : String(error)
    return new FsProviderError(message, error.code, { cause: error })
  }
  // Abort first: a cancelled round trip usually ALSO produces a transport error,
  // and reporting that symptom would hide the cause.
  if (signal?.aborted === true) {
    return new FsProviderError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const errno = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  const mapped = codeForErrno(errno)
  if (mapped !== undefined) {
    return new FsProviderError(`cannot ${operation} "${displayPath}": ${errno}`, mapped, { cause: error })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new FsProviderError(`cannot ${operation} "${displayPath}": ${detail}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Throw `FS_ABORTED` when a signal already fired.
 *
 * Called between every round trip: a multi-step operation (read, edit, publish)
 * must not continue after cancellation just because the current step succeeded.
 * @param signal - the operation's signal.
 * @param operation - operation name for the message.
 */
export function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsProviderError(`${operation} aborted`, 'FS_ABORTED')
}
