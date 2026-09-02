/**
 * Load-and-shape smoke test for the connection owner. No SSH target involved:
 * it proves the module graph resolves inside the harness's package realm, that
 * the config schema applies the documented defaults, and that argument quoting
 * cannot be escaped.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import {
  SshRuntime,
  SshHelperError,
  SshTransportError,
  shellQuote,
  validateSshConfig,
} from '../src/index.ts'
import { HELPER_PROTOCOL_VERSION } from '../src/protocol.ts'

// The service must be constructible as a cordis Service subclass and expose the
// schema the composition layer validates rows against.
assert.equal(typeof SshRuntime, 'function')
assert.ok(SshRuntime.Config, 'SshRuntime.Config must exist for row validation')

const applied = SshRuntime.Config({ host: 'example.invalid', cwd: '/home/dev/proj' })
assert.equal(applied.port, 22)
assert.equal(applied.helperDir, '.dsh-remote')
assert.equal(applied.python, 'python3')
assert.equal(applied.provisionKey, true)
assert.equal(applied.readyTimeoutMs, 30_000)
assert.equal(applied.keepaliveMs, 15_000)

// One-world rules are enforced by validateSshConfig, which the constructor
// calls, so they are testable without a live context.
const base = { host: 'h', username: 'dev', cwd: '/home/dev/proj', identityPath: '/k' }
validateSshConfig(base)
assert.throws(() => validateSshConfig({ ...base, cwd: 'relative/path' }), /absolute POSIX path/)
assert.throws(() => validateSshConfig({ ...base, cwd: 'C:\\work' }), /absolute POSIX path/)
assert.throws(() => validateSshConfig({ ...base, cwd: '/ok/but\\bad' }), /POSIX separators/)
assert.throws(() => validateSshConfig({ ...base, username: '' }), /username is required/)
assert.throws(() => validateSshConfig({ ...base, host: '' }), /host is required/)
assert.throws(
  () => validateSshConfig({ host: 'h', username: 'dev', cwd: '/w' }),
  /identityPath/,
  'a configuration with no credential at all must be rejected',
)
assert.throws(
  () => validateSshConfig({ ...base, helperDir: '/absolute' }),
  /must be relative/,
)

// Quoting must survive every character a shell would otherwise interpret.
assert.equal(shellQuote('plain'), "'plain'")
assert.equal(shellQuote("it's"), `'it'"'"'s'`)
assert.equal(shellQuote('a b; rm -rf /'), "'a b; rm -rf /'")
assert.equal(shellQuote('$(whoami)'), "'$(whoami)'")
assert.equal(shellQuote('`id`'), "'`id`'")

// Error classes must carry machine-readable codes, not just messages.
const helperError = new SshHelperError({ code: 'ENOENT', message: 'no such file', errno: 2 }, 'stat')
assert.equal(helperError.code, 'ENOENT')
assert.equal(helperError.errno, 2)
assert.match(helperError.message, /stat failed/)
assert.equal(new SshTransportError('gone').name, 'SshTransportError')

assert.equal(HELPER_PROTOCOL_VERSION, 1)

console.log('runtime.smoke: ok — module graph resolves, schema defaults applied, quoting is inescapable')
