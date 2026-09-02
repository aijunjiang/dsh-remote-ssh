/**
 * Resolving ripgrep ON THE TARGET.
 *
 * `isPackagedRipgrep` only detects that a spawn wants ripgrep; something must
 * still say where ripgrep is in the remote world. The ladder here is ordered by
 * decreasing operator intent, and every candidate is proven by EXECUTING it
 * rather than by a permission bit: a staged binary of the wrong architecture
 * passes `test -x` and then dies with ENOEXEC, which would surface as an
 * unexplained search failure much later.
 *
 * The module takes an `exec` callback instead of a transport, so the ladder is
 * testable with no connection.
 *
 * @module
 */

/** One remote command execution, as the SSH runtime exposes it. */
export interface RemoteExec {
  (command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/** Where a resolved ripgrep came from, for diagnostics and cache reporting. */
export type RipgrepSource = 'configured' | 'path' | 'staged' | 'staged-now'

/** A resolved remote ripgrep. */
export interface ResolvedRipgrep {
  /** Absolute POSIX path on the target. */
  readonly path: string
  readonly source: RipgrepSource
  /** First line of `rg --version`, recorded so a mismatch is diagnosable. */
  readonly version: string
}

/** Inputs to one resolution attempt. */
export interface RipgrepResolveOptions {
  /** Runs one command on the target and reports its exit facts. */
  readonly exec: RemoteExec
  /** Operator-configured absolute remote path; tried first and never guessed past. */
  readonly configuredPath?: string
  /** Provider-owned staging location, e.g. `<runtimeRoot>/bin/rg`. */
  readonly stagedPath?: string
  /**
   * Performs staging (download on the host, upload to the target, make
   * executable) and returns the remote path. Only called when every cheaper
   * rung failed, so a deployment that forbids uploads simply omits it.
   */
  readonly stage?: () => Promise<string>
}

/** Single-quote one argument for a remote `sh -c` string. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/**
 * Prove a candidate is a working ripgrep by running it.
 * @param exec - remote command runner.
 * @param path - candidate absolute remote path.
 * @returns the version line when the candidate executes as ripgrep.
 */
async function probe(exec: RemoteExec, path: string): Promise<string | undefined> {
  if (!path.startsWith('/')) return undefined
  const result = await exec(`${quote(path)} --version`)
  if (result.exitCode !== 0) return undefined
  const first = result.stdout.split('\n', 1)[0]?.trim() ?? ''
  // `rg --version` prints "ripgrep 14.1.0 …"; anything else is not ripgrep,
  // however executable it was.
  if (!/^ripgrep\s/i.test(first)) return undefined
  return first
}

/**
 * Resolve ripgrep on the target, trying operator intent before convention.
 *
 * Order: configured path → `command -v rg` on the login PATH → an existing
 * staged binary → staging one now. A configured path that fails to run is a
 * hard error rather than a silent fallthrough, because falling back would hide
 * exactly the misconfiguration the operator needs to see.
 *
 * @param options - the ladder's inputs.
 * @returns the resolved ripgrep, or `undefined` when every rung failed.
 * @throws when `configuredPath` is set but does not execute as ripgrep.
 */
export async function resolveRemoteRipgrep(options: RipgrepResolveOptions): Promise<ResolvedRipgrep | undefined> {
  const { exec, configuredPath, stagedPath, stage } = options

  if (configuredPath !== undefined && configuredPath.length > 0) {
    if (!configuredPath.startsWith('/')) {
      throw new Error(`remote-argv: ripgrepPath must be an absolute remote path, got ${JSON.stringify(configuredPath)}`)
    }
    const version = await probe(exec, configuredPath)
    if (version === undefined) {
      throw new Error(
        `remote-argv: configured ripgrepPath ${JSON.stringify(configuredPath)} did not run as ripgrep on the target `
          + '(wrong path, wrong architecture, or not executable)',
      )
    }
    return { path: configuredPath, source: 'configured', version }
  }

  // `command -v` is a POSIX shell builtin, so this needs no coreutils.
  const onPath = await exec('command -v rg')
  const candidate = onPath.stdout.trim()
  if (onPath.exitCode === 0 && candidate.startsWith('/') && !candidate.includes('\n')) {
    const version = await probe(exec, candidate)
    if (version !== undefined) return { path: candidate, source: 'path', version }
  }

  if (stagedPath !== undefined && stagedPath.length > 0) {
    const version = await probe(exec, stagedPath)
    if (version !== undefined) return { path: stagedPath, source: 'staged', version }
  }

  if (stage !== undefined) {
    const stagedNow = await stage()
    const version = await probe(exec, stagedNow)
    if (version === undefined) {
      throw new Error(
        `remote-argv: staged ripgrep at ${JSON.stringify(stagedNow)} did not run on the target `
          + '(architecture mismatch is the usual cause)',
      )
    }
    return { path: stagedNow, source: 'staged-now', version }
  }

  return undefined
}

/**
 * Select the ripgrep release asset matching a target's `uname` output.
 *
 * Kept beside the resolver because a staging implementation must not guess: the
 * musl/gnu distinction and the arm64 spelling are the two things that silently
 * produce an unrunnable binary.
 *
 * @param unameMachine - `uname -m` from the target, e.g. `x86_64` or `aarch64`.
 * @param libc - `gnu` or `musl`; musl hosts must use the static build.
 * @returns the ripgrep release triple, or `undefined` when unsupported.
 */
export function ripgrepAssetTriple(unameMachine: string, libc: 'gnu' | 'musl'): string | undefined {
  const machine = unameMachine.trim().toLowerCase()
  if (machine === 'x86_64' || machine === 'amd64') {
    return libc === 'musl' ? 'x86_64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
  }
  if (machine === 'aarch64' || machine === 'arm64') {
    // Upstream publishes only a gnu aarch64 build; a musl arm64 target must
    // install ripgrep itself rather than receive a binary that cannot run.
    return libc === 'musl' ? undefined : 'aarch64-unknown-linux-gnu'
  }
  return undefined
}
