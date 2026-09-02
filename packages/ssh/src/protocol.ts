/**
 * Wire protocol between `dsh-ssh` and the remote helper daemon.
 *
 * The helper (`../helper/dsh_helper.py`) is the authoritative implementation;
 * these types must be changed together with it. Framing: one JSON object per
 * line on the helper's stdin/stdout. Payload bytes are base64 inside the frame,
 * chunked so no single transfer starves an interactive terminal sharing the
 * channel.
 *
 * Every request carries an `id` and produces exactly one terminal reply.
 * Unsolicited frames carry `ev` instead of `id`.
 *
 * @module
 */

/** Protocol version the helper announces in its `ready` frame and `ping` result. */
export const HELPER_PROTOCOL_VERSION = 1

/** File kind as the helper reports it; `symlink` appears only from `lstat`/`listdir`. */
export type HelperFileType = 'file' | 'directory' | 'symlink' | 'other'

/** Metadata for one path, carrying the freshness token the fs contract guards on. */
export interface HelperFileInfo {
  type: HelperFileType
  /** SHA-256 over dev:ino:size:mode:mtime_ns:ctime_ns — inode and nanosecond fidelity. */
  version: string
  /** Permission bits only (`S_IMODE`), so a write can preserve them. */
  mode: number
  /** Present for regular files only. */
  size?: number
}

/** One direct child from `listdir`, with metadata already resolved. */
export interface HelperDirEntry extends Partial<HelperFileInfo> {
  name: string
  /** Canonical target of a symlink child, when it resolved. */
  target?: string
  /** True when the entry itself is a symlink, whatever its followed type is. */
  symlink?: boolean
}

/** Requests, discriminated by `op`. `id` is caller-assigned and strictly increasing. */
export type HelperRequest =
  | { id: number; op: 'ping' }
  | { id: number; op: 'stat'; path: string }
  | { id: number; op: 'lstat'; path: string }
  /** `realpath -m` semantics: canonicalize the deepest existing ancestor. */
  | { id: number; op: 'realpath'; path: string; cwd?: string }
  | { id: number; op: 'listdir'; path: string }
  /** Streams `data` events keyed by this `id`, then replies with the total. */
  | { id: number; op: 'read'; path: string; maxBytes?: number }
  | {
      id: number
      op: 'write'
      path: string
      dataB64: string
      /** `os.link` publication that fails with EEXIST instead of overwriting. */
      exclusive?: boolean
      /** Permission bits for the staged file; omitted preserves the target's, else 0600. */
      mode?: number
    }
  | { id: number; op: 'mkdir'; path: string; parents?: boolean; okIfExists?: boolean }
  | { id: number; op: 'remove'; path: string; dir?: boolean }
  /** `login: true` probes through the account's login shell (PAM, profile, rc). */
  | { id: number; op: 'env'; login?: boolean }
  | { id: number; op: 'which'; name: string; path?: string }
  | {
      id: number
      op: 'spawn'
      /** Caller-assigned handle that later `stdin`/event frames refer to. */
      handle: string
      /** Passed to execvp verbatim — no shell, so no quoting layer can be wrong. */
      argv: readonly string[]
      cwd: string
      /** The complete environment; the helper never merges its own. */
      env: Readonly<Record<string, string>>
      stdin: 'ignore' | 'pipe'
      /**
       * Bounded full-stream records written ON THE TARGET, one file per stream.
       *
       * The client names each path because the client is what reports
       * `spillPath` upward; deriving names in the helper would put the
       * authoritative name in two places. Absent disables spilling.
       */
      spill?: {
        /** Whole-stream cap; passing it discards the file and emits `spill.lost`. */
        maxBytes: number
        /** Absolute remote path per collected stream. */
        streams: Partial<Record<'out' | 'err', string>>
      }
    }
  /** `dataB64` writes to the child's fd 0; `close` shuts that fd, not the channel. */
  | { id: number; op: 'stdin'; handle: string; dataB64?: string; close?: boolean }
  /**
   * Signal a process GROUP. Takes a pgid rather than a handle because the group
   * outlives the direct child, and signalling the group is what makes
   * termination tree-scoped.
   */
  | { id: number; op: 'kill'; pgid: number; signal: 'TERM' | 'KILL' | 'INT' | 'HUP' | 'TSTP' }
  | { id: number; op: 'alive'; pgid: number }

/** Result payloads, keyed by the `op` that produced them. */
export interface HelperResults {
  ping: {
    protocol: number
    python: string
    pid: number
    platform: string
    uname: readonly string[]
  }
  stat: { present: boolean; info?: HelperFileInfo }
  lstat: { present: boolean; info?: HelperFileInfo }
  realpath: { path: string }
  listdir: { entries: readonly HelperDirEntry[] }
  read: { bytes: number; version: string }
  write: { version: string; size: number }
  mkdir: { created: boolean }
  remove: { removed: boolean }
  env: { env: Record<string, string>; home: string; login?: boolean }
  which: { path: string }
  /** `spill` echoes the accepted per-stream remote paths, empty when none. */
  spawn: { pid: number; pgid: number; spill: Partial<Record<'out' | 'err', string>> }
  stdin: { written: number }
  /**
   * `delivered` reports only whether the signal call itself succeeded. Only
   * `alive` proves quiescence, so a false `delivered` is never authoritative.
   */
  kill: { delivered: boolean; alive: boolean; code?: string }
  alive: { alive: boolean }
}

/** A coded failure. `code` is an errno name (`ENOENT`) or a helper code. */
export interface HelperErrorFrame {
  /** errno name, `E2BIG` for a cap overflow, `EHELPER` for an internal fault, `ENOSYS` for an unknown op. */
  code: string
  message: string
  errno?: number
  /** Tail of a Python traceback; present only for `EHELPER`. */
  trace?: string
}

/** Terminal reply to one request. */
export type HelperReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: HelperErrorFrame }

/** Unsolicited frames. */
export type HelperEvent =
  | { ev: 'ready'; protocol: number; pid: number }
  | { ev: 'log'; level: 'debug' | 'warn' | 'error'; message: string }
  /** File-read payload, correlated by request `id`. */
  | { ev: 'data'; id: number; b64: string }
  /** Process output, correlated by spawn `handle`. */
  | { ev: 'data'; h: string; s: 'out' | 'err'; b64: string }
  | { ev: 'eof'; h: string; s: 'out' | 'err' }
  /** Direct-child exit facts; `signal` is a POSIX number, not a name. */
  | { ev: 'exit'; h: string; code: number | null; signal: number | null }
  /** The whole process group became quiescent — the fact `waitForExit` needs. */
  | { ev: 'gone'; h: string }
  /**
   * The remote spill was discarded and its path must stop being reported: the
   * whole-stream cap was passed, or a write failed. A partial file presented as
   * a complete record is worse than no file, so loss is a first-class event.
   */
  | { ev: 'spill'; h: string; lost: true; reason: string }

/** Any frame the helper can emit. */
export type HelperFrame = HelperReply | HelperEvent

/**
 * Narrow a decoded frame to an event.
 * @param frame - one decoded helper frame.
 * @returns true when the frame is unsolicited.
 */
export function isHelperEvent(frame: HelperFrame): frame is HelperEvent {
  return 'ev' in frame
}
