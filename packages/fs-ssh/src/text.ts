/**
 * Text handling for the filesystem provider: binary rejection, strict UTF-8
 * decoding, and line-ending fidelity.
 *
 * Three contract facts drive this module:
 *
 *  * `FS_NOT_TEXT` covers both a NUL byte and invalid UTF-8
 *    (`packages/fs/fs/src/types.ts` error vocabulary), so decoding is **fatal**
 *    rather than lossy — a mangled replacement character silently corrupts an
 *    `editText` round trip, which is the one operation that writes the decoded
 *    text back.
 *  * Outcome text (`before`/`after`) is **LF-normalized**
 *    (`types.ts:137-142,148,161`), while what lands on disk must keep the file's
 *    own convention. A CRLF file edited through an LF-normalized match must be
 *    written back as CRLF, or a one-line edit rewrites every line of the file.
 *  * `streamText` decodes across chunk boundaries, so a multi-byte character
 *    split by the transport must not become two errors — and the NUL sample must
 *    span chunks too, since a binary file's first NUL may arrive in chunk two.
 *
 * @module
 */

import { Buffer } from 'node:buffer'

/** Bytes sampled for a NUL before a file is accepted as text. */
export const BINARY_SAMPLE_BYTES = 8192

/** Characters sampled when deciding a file's dominant line ending. */
const CRLF_SAMPLE_CHARS = 4096

/** A coded filesystem failure; mirrors the seam's `FsError` shape. */
export class FsTextError extends Error {
  readonly code: 'FS_NOT_TEXT'

  constructor(message: string) {
    super(message)
    this.name = 'FsError'
    this.code = 'FS_NOT_TEXT'
  }
}

/**
 * Decode complete file bytes as text, refusing binary and invalid UTF-8.
 * @param bytes - the whole file.
 * @param displayPath - path as the model sees it, for the message.
 * @returns the decoded text, exactly as stored (line endings untouched).
 * @throws {FsTextError} for a NUL in the sample window or invalid UTF-8.
 */
export function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsTextError(`cannot read "${displayPath}": binary file`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsTextError(`cannot read "${displayPath}": invalid UTF-8 text`)
  }
}

/** Replace every CRLF with LF. */
export function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

/**
 * Whether CRLF is the file's dominant line ending.
 *
 * A majority vote over a sample, not an all-or-nothing test: real files are
 * mixed, and rewriting the minority convention is the lesser evil compared with
 * rewriting every line.
 * @param value - the file's text as stored.
 */
export function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, CRLF_SAMPLE_CHARS)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

/**
 * Re-apply a file's line-ending convention to normalized text.
 * @param value - LF-normalized text.
 * @param crlf - whether to restore CRLF.
 */
export function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

/**
 * Streaming counterpart of {@link decodeText}, for `streamText`.
 *
 * Holds two pieces of cross-chunk state the naive per-chunk version gets wrong:
 * the incremental UTF-8 decoder (so a character split across chunks survives)
 * and the remaining NUL-sample budget (so a binary file is still rejected when
 * its first NUL lands in a later chunk).
 */
export class TextStreamDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly displayPath: string
  private sampleRemaining = BINARY_SAMPLE_BYTES

  constructor(displayPath: string) {
    this.displayPath = displayPath
  }

  /**
   * Decode one chunk.
   * @param chunk - transport bytes, at any boundary.
   * @returns the text decodable so far; may be empty mid-character.
   * @throws {FsTextError} on a sampled NUL or invalid UTF-8.
   */
  push(chunk: Uint8Array): string {
    if (this.sampleRemaining > 0) {
      const window = chunk.subarray(0, this.sampleRemaining)
      if (window.includes(0)) {
        throw new FsTextError(`cannot read "${this.displayPath}": binary file`)
      }
      this.sampleRemaining -= window.length
    }
    try {
      return this.decoder.decode(chunk, { stream: true })
    } catch {
      throw new FsTextError(`cannot read "${this.displayPath}": invalid UTF-8 text`)
    }
  }

  /**
   * Finish decoding.
   * @returns any trailing text.
   * @throws {FsTextError} when the stream ended mid-character — a truncated
   *   character is invalid UTF-8, not a partial success.
   */
  end(): string {
    try {
      return this.decoder.decode(Buffer.alloc(0))
    } catch {
      throw new FsTextError(`cannot read "${this.displayPath}": invalid UTF-8 text`)
    }
  }
}
