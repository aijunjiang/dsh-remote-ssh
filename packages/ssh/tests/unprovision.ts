/**
 * Cleanup-only: remove a dsh-ssh provisioned key from a target's
 * authorized_keys, using the same password that provisioned it.
 *
 * Use after a run whose local key save failed (or any run whose teardown did
 * not reach the unprovision step): a leftover provisioned key is a persistent
 * backdoor nobody remembers.
 *
 *   $env:DSH_SSH_HOST='192.168.10.125'
 *   $env:DSH_SSH_USER='amax'
 *   $env:DSH_SSH_PASSWORD='...'
 *   node .\packages\ssh\tests\unprovision.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { SshRuntime } from '../src/index.ts'

const host = process.env.DSH_SSH_HOST
const username = process.env.DSH_SSH_USER

if (host === undefined || username === undefined) {
  console.log('unprovision: skipped — set DSH_SSH_HOST and DSH_SSH_USER')
  process.exit(0)
}

const ctx = new Context()
const ssh = new SshRuntime(ctx, {
  host,
  username,
  cwd: '/tmp',
  password: process.env.DSH_SSH_PASSWORD,
  port: process.env.DSH_SSH_PORT === undefined ? undefined : Number(process.env.DSH_SSH_PORT),
  provisionKey: false, // this run must not install anything
})

const comment = `dsh@${host}`
try {
  const removed = await ssh.unprovisionPublicKey(comment)
  console.log(`unprovision: removed ${removed} line(s) for ${comment} from ${username}@${host}:~/.ssh/authorized_keys`)
} catch (error: unknown) {
  console.error('unprovision: failed:', error instanceof Error ? error.message : error)
  process.exit(1)
}
process.exit(0)
