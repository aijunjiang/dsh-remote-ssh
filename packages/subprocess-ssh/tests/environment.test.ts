/**
 * Environment tests. The scrub is a security boundary — a leak here sends the
 * harness's own credentials to someone else's machine — so the predicates are
 * checked against the seam's definitions
 * (`packages/subprocess/subprocess/src/index.ts:44,60-66`, `types.ts:13,96-102`)
 * rather than against intent.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import {
  DSH_ENV_PREFIX,
  ENV_PROBE_COMMAND,
  SENSITIVE_ENV_PATTERN,
  buildChildEnvironment,
  isInheritable,
  mergeEnvironment,
  parseNulEnvironment,
  scrubRemoteEnv,
} from '../src/environment.ts'

// The predicates must stay identical to the seam's, or the two worlds diverge.
assert.equal(String(SENSITIVE_ENV_PATTERN), String(/KEY|PASSWORD|SECRET|TOKEN/i))
assert.equal(DSH_ENV_PREFIX, 'DSH_')
assert.equal(ENV_PROBE_COMMAND, 'env -0', 'a line-based probe would corrupt multi-line values')

// -- parsing `env -0` -------------------------------------------------------

{
  const parsed = parseNulEnvironment('PATH=/usr/bin:/bin\0HOME=/home/dev\0LANG=en_US.UTF-8\0')
  assert.deepEqual(parsed, { PATH: '/usr/bin:/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8' })
}

{
  // A value containing newlines is exactly why the probe is NUL-separated.
  const parsed = parseNulEnvironment('LS_COLORS=rs=0:\ndi=01;34\0PATH=/bin\0')
  assert.equal(parsed.LS_COLORS, 'rs=0:\ndi=01;34', 'a multi-line value must survive intact')
  assert.equal(parsed.PATH, '/bin')
}

{
  // `=` inside a value is ordinary; only the FIRST one separates.
  const parsed = parseNulEnvironment('OPTS=--flag=1 --other=2\0')
  assert.equal(parsed.OPTS, '--flag=1 --other=2')
}

{
  // Malformed records are dropped, never guessed at.
  const parsed = parseNulEnvironment('NOEQUALS\0=novalue\0\0GOOD=1\0')
  assert.deepEqual(parsed, { GOOD: '1' })
}

{
  // An empty value is legitimate and must be preserved.
  assert.deepEqual(parseNulEnvironment('EMPTY=\0'), { EMPTY: '' })
  assert.deepEqual(parseNulEnvironment(''), {})
}

// -- the scrub --------------------------------------------------------------

{
  const probed = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    HTTPS_PROXY: 'http://proxy:3128',
    // Credential-shaped names must not be inherited implicitly.
    DEEPSEEK_API_KEY: 'sk-must-not-leak',
    AWS_SECRET_ACCESS_KEY: 'nope',
    GITHUB_TOKEN: 'ghp_nope',
    DB_PASSWORD: 'hunter2',
    // The harness's own namespace must not leak either.
    DSH_SESSION_ID: 's-1',
    dsh_home: '/root/.dsh',
    // Lower-case credential spellings must be caught too.
    my_api_key: 'nope',
  }
  const scrubbed = scrubRemoteEnv(probed)

  assert.deepEqual(Object.keys(scrubbed).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'PATH', 'TERM'])
  assert.equal(scrubbed.PATH, '/usr/local/bin:/usr/bin:/bin', 'the TARGET\'s PATH must survive, not the host\'s')
  assert.equal(scrubbed.HOME, '/home/dev')
  assert.equal(scrubbed.HTTPS_PROXY, 'http://proxy:3128', 'proxy settings are needed for remote builds')
  for (const leaked of [
    'DEEPSEEK_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'DSH_SESSION_ID',
    'dsh_home',
    'my_api_key',
  ]) {
    assert.ok(!(leaked in scrubbed), `${leaked} must never be inherited implicitly`)
  }
  // The input must not be mutated.
  assert.equal(probed.DEEPSEEK_API_KEY, 'sk-must-not-leak')
}

// Predicate spot checks, including the case-insensitivity the seam requires.
assert.equal(isInheritable('PATH'), true)
assert.equal(isInheritable('MONKEY'), false, 'the seam matches KEY as a substring; parity matters more than taste')
assert.equal(isInheritable('DSH_X'), false)
assert.equal(isInheritable('dsh_x'), false)
assert.equal(isInheritable('DSHX'), true, 'the prefix is DSH_, not DSH')
assert.equal(isInheritable('token'), false)
assert.equal(isInheritable('SSH_AUTH_SOCK'), true)

// -- explicit layering and tombstones -------------------------------------

{
  const base = { PATH: '/usr/bin', HOME: '/home/dev', LANG: 'C' }

  // An explicit entry wins — this is how a deliberately forwarded credential
  // reaches a child after the scrub removed its ambient twin.
  const merged = mergeEnvironment(base, { PATH: '/opt/bin:/usr/bin', GITHUB_TOKEN: 'ghp_deliberate' })
  assert.equal(merged.PATH, '/opt/bin:/usr/bin')
  assert.equal(merged.GITHUB_TOKEN, 'ghp_deliberate', 'the scrub must not veto an explicit forward')

  // An explicit undefined is a tombstone: the name is removed, not stringified.
  const tombstoned = mergeEnvironment(base, { LANG: undefined })
  assert.ok(!('LANG' in tombstoned), 'a tombstone must delete the entry')
  assert.notEqual(tombstoned.LANG, 'undefined')

  // A tombstone for an absent name is a harmless no-op.
  assert.deepEqual(mergeEnvironment(base, { NOPE: undefined }), base)

  // The base must not be mutated by merging.
  assert.equal(base.PATH, '/usr/bin')
}

// -- the whole pipeline ---------------------------------------------------

{
  const env = buildChildEnvironment(
    { PATH: '/usr/bin', HOME: '/home/dev', DEEPSEEK_API_KEY: 'leak', DSH_TRACE: '1' },
    { CI: 'true', GIT_AUTHOR_NAME: 'dsh' },
  )
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/dev', CI: 'true', GIT_AUTHOR_NAME: 'dsh' })
}

{
  // No explicit env at all still yields a usable base.
  const env = buildChildEnvironment({ PATH: '/bin', SECRET_X: 'x' })
  assert.deepEqual(env, { PATH: '/bin' })
}

console.log('subprocess-ssh/environment: ok — NUL parsing, remote-world scrub parity, tombstones, and layering verified')
