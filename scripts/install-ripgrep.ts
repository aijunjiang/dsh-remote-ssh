/**
 * Install ripgrep on the target via apt (the target's own network), so the
 * search-translation section of connect.e2e.ts can run for real.
 */

import { Context } from '@deepseek-ai/cordis'
import { SshRuntime } from '../packages/ssh/src/index.ts'

const host = process.env.DSH_SSH_HOST ?? ''
const username = process.env.DSH_SSH_USER ?? ''

const ctx = new Context()
// The e2e run unprovisions its key, so any identity saved in the scratch dir is
// stale; delete it so the ladder falls through to the password.
const stale = process.env.DSH_SSH_IDENTITY_DIR
if (stale !== undefined) {
  const { rmSync, readdirSync } = await import('node:fs')
  try {
    for (const entry of readdirSync(stale)) rmSync(`${stale}/${entry}`, { recursive: true, force: true })
  } catch {
    // No stale identity; the password is used directly.
  }
}
const ssh = new SshRuntime(ctx, {
  host,
  username,
  cwd: '/home/amax',
  port: 22,
  password: process.env.DSH_SSH_PASSWORD,
  identityDir: process.env.DSH_SSH_IDENTITY_DIR,
})

await ssh.getFacts()

const probe = await ssh.exec('command -v rg')
if (probe.exitCode === 0) {
  console.log('rg already present:', probe.stdout.trim())
  process.exit(0)
}

// No passwordless sudo on this box, so install into the user's own bin via pip
// (user installs need no privileges).
console.log('installing ripgrep via pip --user...')
const install = await ssh.exec(
  'python3 -m pip install --user --quiet ripgrep 2>&1 | tail -2; export PATH="$HOME/.local/bin:$PATH"; command -v rg',
)
console.log('exit:', install.exitCode)
console.log('output:', install.stdout.trim().slice(-300))
if (install.exitCode !== 0 || !install.stdout.trim().includes('/')) {
  console.log('pip install failed; the remote-argv e2e section will stay skipped')
  process.exit(1)
}
console.log('rg installed at:', install.stdout.trim().split('\n').at(-1))
process.exit(0)
