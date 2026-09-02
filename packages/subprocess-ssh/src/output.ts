/**
 * Bounded output collection for a remote process.
 *
 * This is the one part of a subprocess provider that needs no remote code at
 * all, and the contract it must satisfy is unusually specific
 * (`packages/subprocess/subprocess/src/types.ts:44-52,120-148`):
 *
 *  * Offsets are **whole-stream byte** coordinates, and reads are
 *    **non-consuming** — two independent readers must not steal each other's
 *    output, and the same offset may be read repeatedly with the same answer.
 *  * The in-memory cap keeps the **tail**. A read from an offset that has slid
 *    out of that window returns the whole retained tail with `lossy: true`.
 *  * `SubprocessOutputRead.text` is a **string** while offsets are bytes, so the
 *    window is retained as bytes and decoded per read. A multi-byte character
 *    straddling a chunk boundary must not be mangled, which a naive
 *    `chunk.toString()` per chunk would do.
 *  * `spill` is optional; omitting it disables spilling entirely. Exceeding the
 *    spill cap **discards the now-incomplete spill** and stops reporting
 *    `spillPath`, because a partial file presented as the full stream is worse
 *    than no file.
 *
 * The spill file itself lives **on the target**, not on the host: `spillPath` is
 * handed to the model, whose world is the remote one. (Upstream `dsh-ssh` writes
 * it into the host `tmpdir` — `output.ts:20`, `subprocess.ts:43` — so the path it
 * reports cannot be opened by the tools that receive it.) This class therefore
 * only accounts for spill state; the helper does the writing and reports loss.
 *
 * @module
 */

import { Buffer } from 'node:buffer'

/** One incremental read, mirroring the seam's `SubprocessOutputRead`. */
export interface OutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Remote path of the full-stream spill, while one exists and is intact. */
  spillPath?: string
}

/** Collection limits for one stream, mirroring the seam's `SubprocessCollect`. */
export interface CollectLimits {
  /** In-memory cap in bytes; overflow keeps the tail. */
  maxBytes: number
  /** Full-stream spill; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
    /** Absolute path ON THE TARGET where the helper writes the spill. */
    path: string
  }
}

/**
 * A bounded tail window over one output stream, with remote spill accounting.
 */
export class OutputCollector {
  private readonly limits: CollectLimits
  /** Retained tail, as bytes: decoding happens at read time. */
  private window: Buffer = Buffer.alloc(0)
  /** Whole-stream byte offset of `window[0]`. */
  private windowStart = 0
  /** Total bytes ever appended. */
  private total = 0
  /** Remote spill path while the spill is intact; cleared once it is discarded. */
  private spillPath: string | undefined
  private spillLost = false

  constructor(limits: CollectLimits) {
    if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 0) {
      throw new Error('output: collect maxBytes must be a non-negative integer')
    }
    if (limits.spill !== undefined) {
      if (!Number.isInteger(limits.spill.maxBytes) || limits.spill.maxBytes < 0) {
        throw new Error('output: spill maxBytes must be a non-negative integer')
      }
      if (!limits.spill.path.startsWith('/')) {
        throw new Error('output: spill path must be an absolute remote path')
      }
      this.spillPath = limits.spill.path
    }
    this.limits = limits
  }

  /** Total bytes observed on this stream, regardless of retention. */
  get byteLength(): number {
    return this.total
  }

  /** True once the tail window has dropped bytes from the head. */
  get truncated(): boolean {
    return this.windowStart > 0
  }

  /**
   * Append bytes as they arrive from the remote stream.
   *
   * Overflow trims from the head, so the retained window is always the tail.
   * Spill state is advanced too: once the stream passes the spill cap the file
   * is unusable as a full-stream record and stops being reported.
   * @param chunk - the bytes exactly as the helper relayed them.
   */
  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.total += chunk.length
    if (this.limits.spill !== undefined && !this.spillLost && this.total > this.limits.spill.maxBytes) {
      // The helper deletes the file; locally we must stop advertising it.
      this.spillLost = true
      this.spillPath = undefined
    }
    if (this.limits.maxBytes === 0) {
      // Nothing is retained, but the offsets must still advance so a reader sees
      // a consistent (fully lossy) view rather than a rewinding stream.
      this.windowStart = this.total
      return
    }
    const combined = this.window.length === 0 ? chunk : Buffer.concat([this.window, chunk])
    if (combined.length <= this.limits.maxBytes) {
      this.window = combined
      return
    }
    const dropped = combined.length - this.limits.maxBytes
    this.window = combined.subarray(dropped)
    this.windowStart += dropped
  }

  /** Record that the helper discarded the remote spill (cap hit or write error). */
  markSpillLost(): void {
    this.spillLost = true
    this.spillPath = undefined
  }

  /**
   * Read everything captured since `fromByte`.
   *
   * @param fromByte - whole-stream offset (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, the lossy flag, and the spill path.
   */
  readFrom(fromByte: number): OutputRead {
    if (!Number.isInteger(fromByte) || fromByte < 0) {
      throw new Error('output: read offset must be a non-negative integer')
    }
    const windowEnd = this.windowStart + this.window.length
    // An offset past the end is not an error: a reader that already consumed
    // everything asks again with the same offset and must simply see nothing.
    if (fromByte >= windowEnd) {
      return this.read('', windowEnd, fromByte > this.total)
    }
    if (fromByte < this.windowStart) {
      // The requested start is gone; the contract returns the whole retained
      // tail and marks the read lossy rather than pretending the gap is empty.
      return this.read(this.decode(this.window), windowEnd, true)
    }
    const slice = this.window.subarray(fromByte - this.windowStart)
    return this.read(this.decode(slice), windowEnd, false)
  }

  private read(text: string, nextOffset: number, lossy: boolean): OutputRead {
    const result: OutputRead = { text, nextOffset, lossy }
    // An absent spillPath must be absent, not `undefined`-valued, so a consumer
    // spreading the object cannot advertise a spill that does not exist.
    if (this.spillPath !== undefined) return { ...result, spillPath: this.spillPath }
    return result
  }

  /**
   * Decode retained bytes to text.
   *
   * Non-fatal decoding is deliberate: process output is not required to be valid
   * UTF-8, and a diagnostic tail must survive a byte sequence cut mid-character
   * by the window trim. The replacement character is the honest rendering.
   * @param bytes - the slice to decode.
   */
  private decode(bytes: Buffer): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}
