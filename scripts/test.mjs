/**
 * Run every local (no-target-required) test file and report a summary.
 *
 * Child processes inherit stdio deliberately: this sandbox denies piped stdio to
 * spawned programs, so capturing output would fail with EPERM.
 *
 * Usage: node scripts/test.mjs
 */

import { spawnSync } from 'node:child_process'

const suites = [
  'packages/ssh/tests/keys.smoke.ts',
  'packages/ssh/tests/runtime.smoke.ts',
  'packages/ssh/tests/channel.test.ts',
  'packages/remote-argv/tests/translate.test.ts',
  'packages/remote-argv/tests/ripgrep.test.ts',
  'packages/subprocess-ssh/tests/output.test.ts',
  'packages/subprocess-ssh/tests/process.test.ts',
  'packages/subprocess-ssh/tests/environment.test.ts',
  'packages/subprocess-ssh/tests/resolve.test.ts',
  'packages/subprocess-ssh/tests/service.test.ts',
  'packages/fs-ssh/tests/core.test.ts',
  'packages/fs-ssh/tests/provider.test.ts',
  'packages/ssh-gui/tests/smoke.ts',
  'packages/ssh-gui/tests/backend.test.ts',
  'packages/ssh-gui/tests/helper-session.test.ts',
  'packages/ssh-gui/tests/routing.test.ts',
  'tests/client-bundle.smoke.ts',
  'tests/composition.test.ts',
]

/** Python suites for the helper daemon, run only when an interpreter exists. */
const pythonSuites = ['packages/ssh/helper/tests/test_spill.py']

let failed = 0
for (const suite of suites) {
  process.stdout.write(`\n── ${suite}\n`)
  const result = spawnSync(process.execPath, [suite], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

for (const suite of pythonSuites) {
  process.stdout.write(`\n── ${suite}\n`)
  const result = spawnSync('python', [suite], { stdio: 'inherit', shell: false })
  if (result.error !== undefined) {
    process.stdout.write('   skipped: no python interpreter on PATH\n')
    continue
  }
  if (result.status !== 0) failed += 1
}

const total = suites.length + pythonSuites.length
process.stdout.write(
  failed === 0 ? `\nall ${total} local suites passed\n` : `\n${failed} of ${total} local suites FAILED\n`,
)
// The e2e suite is excluded: it needs DSH_SSH_HOST and a real Linux target.
process.exit(failed === 0 ? 0 : 1)
