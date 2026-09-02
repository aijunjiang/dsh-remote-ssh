/**
 * The child environment, computed in the REMOTE world.
 *
 * The seam's own `scrubbedParentEnv()` reads the host's `process.env`
 * (`packages/subprocess/subprocess/src/index.ts:60-66`). For a remote provider
 * that is the wrong world twice over: it leaks the HOST's ambient environment to
 * a remote child, and it omits the target's real `PATH`, `HOME`, and locale, so
 * remote CLIs misbehave. This module rebuilds the base from the target's own
 * login environment while applying the seam's two scrub predicates verbatim:
 *
 *  * `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` (`index.ts:44`)
 *  * any name whose upper-case form starts with `DSH_` (`index.ts:63`,
 *    `types.ts:13`)
 *
 * Both are case-insensitive for the reason the seam documents: a stray `dsh_*`
 * or `api_key` spelling must not survive.
 *
 * The result is applied with `env -i` semantics — the helper hands `Popen` a
 * complete environment rather than layering onto whatever the SSH login left
 * behind. Anything else lets PAM, `/etc/environment`, or a shell rc file
 * re-inject names the scrub just removed. `SendEnv` is not an option either: it
 * is gated by the server's `AcceptEnv` and can only add names, never remove them.
 *
 * @module
 */

/** Credential-shaped names, matching the seam's pattern exactly. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** The harness's managed namespace, matching the seam's `DSH_ENV_PREFIX`. */
export const DSH_ENV_PREFIX = 'DSH_'

/**
 * Parse `env -0` output: NUL-separated `NAME=VALUE` records.
 *
 * NUL separation is what makes this safe — a value containing newlines (a
 * multi-line `LS_COLORS`, an SSH agent block) would corrupt a line-based parse.
 * A record with no `=` is not a variable and is dropped rather than guessed at.
 *
 * @param raw - the bytes `env -0` wrote, decoded as UTF-8.
 * @returns the target's environment as name → value.
 */
export function parseNulEnvironment(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const record of raw.split('\0')) {
    if (record.length === 0) continue
    const split = record.indexOf('=')
    // A name must be non-empty; `=VALUE` and a bare `NAME` are both malformed.
    if (split <= 0) continue
    env[record.slice(0, split)] = record.slice(split + 1)
  }
  return env
}

/**
 * Whether a name survives the scrub.
 * @param name - environment variable name.
 * @returns true when the name may be inherited implicitly.
 */
export function isInheritable(name: string): boolean {
  return !SENSITIVE_ENV_PATTERN.test(name) && !name.toUpperCase().startsWith(DSH_ENV_PREFIX)
}

/**
 * Scrub a probed remote environment down to the inheritable base.
 * @param probed - the target's login environment.
 * @returns a fresh object holding only inheritable entries.
 */
export function scrubRemoteEnv(probed: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(probed)) {
    if (isInheritable(name)) env[name] = value
  }
  return env
}

/**
 * Layer a spec's explicit environment over the scrubbed base.
 *
 * An explicit entry always wins — that is how a deliberately forwarded
 * credential reaches a child after the scrub removed its ambient twin. An
 * explicit `undefined` is a **tombstone**: it removes the name entirely rather
 * than setting it to the string "undefined"
 * (`packages/subprocess/subprocess/src/types.ts:96-102`).
 *
 * @param base - the scrubbed remote base.
 * @param explicit - the spec's `env`, possibly holding tombstones.
 * @returns the complete environment to hand the helper.
 */
export function mergeEnvironment(
  base: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = { ...base }
  if (explicit === undefined) return env
  for (const [name, value] of Object.entries(explicit)) {
    if (value === undefined) {
      delete env[name]
      continue
    }
    env[name] = value
  }
  return env
}

/**
 * Build the complete child environment for one remote spawn.
 * @param probed - the target's probed login environment.
 * @param explicit - the spec's explicit entries and tombstones.
 * @returns the environment the helper will pass to `execvp`.
 */
export function buildChildEnvironment(
  probed: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return mergeEnvironment(scrubRemoteEnv(probed), explicit)
}

/** The shell command that probes a login environment NUL-safely. */
export const ENV_PROBE_COMMAND = 'env -0'
