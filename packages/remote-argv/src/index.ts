/**
 * Argv translation for a remote execution world.
 *
 * Two host-world leaks reach a remote `ctx.subprocess` through argv, and both
 * are invisible to the tool that produced them:
 *
 *  1. **The packaged ripgrep binary.** `tool-fs-search` spawns search with
 *     `argv: [await resolveRgPath(), '--no-config', ...]`
 *     (`packages/fs/tool-fs-search/src/search-core.ts:234-236`). `resolveRgPath()`
 *     returns the HOST path of the `@vscode/ripgrep` executable, so a remote
 *     spawn tries to execute a Windows path — or a host-only `/…/node_modules/…`
 *     path — on the target and dies with 127. `glob` and `grep` are therefore
 *     broken in every remote session, even though every other seam-backed tool
 *     works.
 *  2. **Host placeholder paths.** A remote session's `cwd` is a LOCAL
 *     placeholder directory, because the session service `mkdir`s the project
 *     directory through `node:fs`. Tools that pass a resolved path as an argv
 *     element hand the remote command that host path.
 *
 * `cwd` itself is not our problem — the SSH provider routes it. Argv is, because
 * nothing else in the stack looks inside it. Both translations are pure string
 * work, so they live here and are tested without a connection.
 *
 * @module
 */

/** One host-prefix → remote-prefix mapping for a routed remote workspace. */
export interface RouteMapping {
  /** Local placeholder directory, in host spelling (either separator). */
  readonly hostPrefix: string
  /** Remote absolute POSIX directory the placeholder stands for. */
  readonly remotePrefix: string
}

/** Options controlling one argv translation. */
export interface TranslateOptions {
  /**
   * Absolute POSIX path of ripgrep ON THE TARGET. Omitted means no remote
   * ripgrep is known yet, which turns a search spawn into a loud, actionable
   * failure instead of a bare exit 127.
   */
  readonly remoteRipgrep?: string
  /** Placeholder mappings for the connection this spawn is routed to. */
  readonly routes?: readonly RouteMapping[]
  /**
   * Compare host prefixes case-insensitively. Defaults to the host platform's
   * own rule, so a `C:\Users` vs `c:\users` spelling difference cannot silently
   * skip a translation.
   */
  readonly caseInsensitiveHostPaths?: boolean
}

/** The outcome of translating one argument vector. */
export interface TranslatedArgv {
  /** The vector to hand the remote spawn. */
  readonly argv: readonly string[]
  /** True when argv[0] was recognized as the packaged ripgrep and replaced. */
  readonly ripgrepReplaced: boolean
  /** Indices whose value was rewritten from a host path to a remote path. */
  readonly rewrittenIndices: readonly number[]
}

/** A translation that cannot proceed, with a code the caller can branch on. */
export class RemoteArgvError extends Error {
  readonly code: 'REMOTE_RIPGREP_MISSING'

  constructor(message: string, code: 'REMOTE_RIPGREP_MISSING') {
    super(message)
    this.name = 'RemoteArgvError'
    this.code = code
  }
}

/** Normalize separators so one comparison covers both host spellings. */
function toSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

/** The last path segment of a value written with either separator. */
function basenameOf(value: string): string {
  const slashed = toSlashes(value)
  const cut = slashed.lastIndexOf('/')
  return cut < 0 ? slashed : slashed.slice(cut + 1)
}

/** Whether a value is an absolute path in HOST (Windows) spelling. */
function isWindowsAbsolute(value: string): boolean {
  const slashed = toSlashes(value)
  return /^[a-z]:\//i.test(slashed) || slashed.startsWith('//')
}

/**
 * Whether argv[0] names the harness's own packaged ripgrep rather than a
 * program that exists on the target.
 *
 * The test is deliberately narrow: a bare `rg`, or an absolute POSIX path such
 * as `/usr/bin/rg`, is a legitimate remote program and must pass through
 * untouched. Only a host-only spelling is translated.
 *
 * @param argv0 - the program element of an argument vector.
 * @returns true when the value can only name a host binary.
 */
export function isPackagedRipgrep(argv0: string): boolean {
  const slashed = toSlashes(argv0).toLowerCase()
  // The @vscode/ripgrep package and its per-platform payloads are unambiguous.
  if (slashed.includes('vscode/ripgrep') || slashed.includes('vscode-ripgrep')) return true
  const base = basenameOf(slashed)
  if (base !== 'rg' && base !== 'rg.exe') return false
  // `rg.exe` cannot run on a POSIX target however it is spelled.
  if (base === 'rg.exe') return true
  if (isWindowsAbsolute(argv0)) return true
  return slashed.includes('/node_modules/')
}

/**
 * Map one host placeholder path onto its remote path.
 * @param value - a candidate argv element.
 * @param routes - placeholder mappings to try, longest prefix first.
 * @param caseInsensitive - whether host prefixes compare case-insensitively.
 * @returns the remote path, or `undefined` when no mapping applies.
 */
export function translateHostPath(
  value: string,
  routes: readonly RouteMapping[],
  caseInsensitive: boolean,
): string | undefined {
  const candidate = toSlashes(value)
  const comparable = caseInsensitive ? candidate.toLowerCase() : candidate
  // Longest prefix wins, so nested placeholders cannot shadow each other.
  const ordered = [...routes].sort((left, right) => right.hostPrefix.length - left.hostPrefix.length)
  for (const route of ordered) {
    const prefix = toSlashes(route.hostPrefix).replace(/\/+$/, '')
    if (prefix.length === 0) continue
    const comparablePrefix = caseInsensitive ? prefix.toLowerCase() : prefix
    if (comparable === comparablePrefix) return route.remotePrefix
    if (!comparable.startsWith(`${comparablePrefix}/`)) continue
    const rest = candidate.slice(prefix.length + 1)
    const base = route.remotePrefix.replace(/\/+$/, '')
    return rest.length === 0 ? base : `${base}/${rest}`
  }
  return undefined
}

/**
 * Translate one argument vector for execution on a remote target.
 *
 * argv[0] is resolved first: a packaged-ripgrep spelling is replaced with the
 * target's ripgrep, and its absence is reported as a coded error rather than
 * being passed through to fail as exit 127 with no explanation. Every remaining
 * element is then checked against the placeholder mappings; a non-path argument
 * cannot match, because a mapping prefix is an absolute host directory.
 *
 * @param argv - the vector a tool produced in the host world.
 * @param options - remote ripgrep path and placeholder mappings.
 * @returns the translated vector plus what changed.
 * @throws {RemoteArgvError} when argv[0] needs a remote ripgrep and none is known.
 */
export function translateArgv(argv: readonly string[], options: TranslateOptions = {}): TranslatedArgv {
  if (argv.length === 0) throw new Error('remote-argv: argv must not be empty')
  const program = argv[0]
  if (program === undefined || program.length === 0) {
    throw new Error('remote-argv: argv[0] must be a non-empty program name')
  }
  const routes = options.routes ?? []
  const caseInsensitive = options.caseInsensitiveHostPaths ?? process.platform === 'win32'

  let ripgrepReplaced = false
  let head = program
  if (isPackagedRipgrep(program)) {
    if (options.remoteRipgrep === undefined || options.remoteRipgrep.length === 0) {
      throw new RemoteArgvError(
        'remote-argv: this session searches on a remote target, but no remote ripgrep is known. '
          + 'Install ripgrep on the target (so `command -v rg` resolves), set the provider\'s '
          + 'ripgrepPath to an absolute remote path, or enable binary staging.',
        'REMOTE_RIPGREP_MISSING',
      )
    }
    head = options.remoteRipgrep
    ripgrepReplaced = true
  }

  const translated: string[] = [head]
  const rewrittenIndices: number[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] as string
    const remote = routes.length === 0 ? undefined : translateHostPath(value, routes, caseInsensitive)
    if (remote === undefined) {
      translated.push(value)
      continue
    }
    translated.push(remote)
    rewrittenIndices.push(index)
  }
  return { argv: translated, ripgrepReplaced, rewrittenIndices }
}
