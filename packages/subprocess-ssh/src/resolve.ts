/**
 * Executable resolution in the remote world.
 *
 * The seam requires that "executable paths belong to one execution world shared
 * with the mounted filesystem provider"
 * (`packages/subprocess/subprocess/src/index.ts:81-83`), and that a relative path
 * is refused rather than silently resolved against some directory
 * (`index.ts:111-112`). Resolution therefore has three cases and one refusal:
 *
 *  * an absolute POSIX path → verified to exist and be executable,
 *  * a bare name → looked up on the child's own `PATH`,
 *  * a path containing `/` but not absolute → **refused**, because "relative to
 *    what" has no single answer once the caller's cwd and the connection's cwd
 *    can differ,
 *  * a host-only spelling of the packaged ripgrep → translated before it ever
 *    reaches here (see `packages/remote-argv`).
 *
 * The lookup is done with `command -v`, a POSIX shell builtin, so the target
 * needs no coreutils. Its answer is validated: a shell function or alias is not
 * an executable path, and a multi-line answer means the name was ambiguous.
 *
 * @module
 */

/** One remote command execution, as the connection owner exposes it. */
export interface RemoteExec {
  (command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/** Single-quote one argument for a remote `sh -c` string, inescapably. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/**
 * Resolve one command to an absolute path on the target.
 *
 * @param exec - runs a command on the target.
 * @param command - the program name or path from the spawn spec.
 * @param options - the child's `PATH` (so lookup matches what the child sees)
 *   and an optional abort signal.
 * @returns the absolute remote path of the executable.
 * @throws when the command is empty, relative, missing, or not executable.
 */
export async function resolveRemoteExecutable(
  exec: RemoteExec,
  command: string,
  options: { path?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  if (command.length === 0) throw new Error('subprocess-ssh: executable name must be non-empty')
  options.signal?.throwIfAborted()

  if (command.startsWith('/')) {
    // `test -f` before `test -x`: a directory with the execute bit set is not an
    // executable, and the resulting error message should say which fact failed.
    const quoted = shellQuote(command)
    const result = await exec(`test -f ${quoted} && test -x ${quoted}`)
    options.signal?.throwIfAborted()
    if (result.exitCode !== 0) {
      throw new Error(`subprocess-ssh: ${JSON.stringify(command)} is not an executable file on the target`)
    }
    return command
  }

  if (command.includes('/')) {
    throw new Error(
      `subprocess-ssh: ${JSON.stringify(command)} is a relative path; use an absolute remote path or a bare PATH name`,
    )
  }

  // The lookup must use the same PATH the child will get, or resolution and
  // execution can disagree.
  const prefix = options.path === undefined ? '' : `PATH=${shellQuote(options.path)} `
  const result = await exec(`${prefix}command -v -- ${shellQuote(command)}`)
  options.signal?.throwIfAborted()
  const answer = result.stdout.trim()
  if (result.exitCode !== 0 || answer.length === 0) {
    throw new Error(`subprocess-ssh: ${JSON.stringify(command)} was not found on the target's PATH`)
  }
  if (answer.includes('\n')) {
    throw new Error(`subprocess-ssh: ${JSON.stringify(command)} resolved ambiguously on the target`)
  }
  if (!answer.startsWith('/')) {
    // `command -v` prints the name itself for a builtin, and a definition for a
    // shell function; neither is something execvp can run.
    throw new Error(
      `subprocess-ssh: ${JSON.stringify(command)} resolved to ${JSON.stringify(answer)}, which is not an executable path `
        + '(a shell builtin, alias, or function cannot be spawned directly)',
    )
  }
  return answer
}
