/**
 * Real-target proof of session routing: ONE harness process, TWO registry
 * connections to the same host with different working directories, and every
 * operation landing in the directory its `ssh://<id>/<path>` cwd names.
 *
 * Two helper daemons run side by side on the target — the same shape as two
 * different machines, minus the second hostname.
 *
 *   $env:DSH_SSH_HOST='192.168.10.125'   # required
 *   $env:DSH_SSH_USER='amax'             # required
 *   $env:DSH_SSH_CWD='/home/amax'        # required (first connection's cwd)
 *   $env:DSH_SSH_PASSWORD='...'          # required
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SshRegistry } from '../src/registry.ts'
import { SshHelperSession } from '../src/helper-session.ts'
import { SshHelperRouter } from '../src/helper-router.ts'
import { SshFileSystem } from '../../fs-ssh/src/index.ts'
import { SshSubprocessRuntime } from '../../subprocess-ssh/src/index.ts'

const host = process.env.DSH_SSH_HOST
const username = process.env.DSH_SSH_USER
const cwd = process.env.DSH_SSH_CWD

if (host === undefined || username === undefined || cwd === undefined || process.env.DSH_SSH_PASSWORD === undefined) {
  console.log('routing-connect.e2e: skipped — set DSH_SSH_HOST, DSH_SSH_USER, DSH_SSH_CWD and DSH_SSH_PASSWORD')
  process.exit(0)
}

const stateFile = join(process.cwd(), '.scratch-routing-e2e.json')
// A previous run's state file would advance the registry's ids past c1/c2.
rmSync(stateFile, { force: true })
const ctx = new Context()
const registry = new SshRegistry(ctx, { stateFile })

// Two connections to the SAME host, different working directories: the routing
// claim is that cwd decides the machine, so this must hold even when the
// machine is identical.
const c1 = registry.add({
  label: 'route-one',
  host,
  port: 22,
  username,
  cwd: `${cwd}/.dsh-routing-e2e/one`,
  auth: 'password',
  password: process.env.DSH_SSH_PASSWORD,
  jumpHosts: [],
})
const c2 = registry.add({
  label: 'route-two',
  host,
  port: 22,
  username,
  cwd: `${cwd}/.dsh-routing-e2e/two`,
  auth: 'password',
  password: process.env.DSH_SSH_PASSWORD,
  jumpHosts: [],
})

const router = new SshHelperRouter(ctx)
// The providers' default transport is never hit by this test (every operation
// carries an explicit ssh:// cwd), but it must exist for construction; use c1's
// session. Its lazily-opened session is the same object the router returns.
const defaultTransport = router.sessionForId(c1.id)
const fsCtx = new Context()
fsCtx.provide('ssh')
fsCtx.provide('sshRegistry')
;(fsCtx as unknown as { ssh: unknown }).ssh = defaultTransport
;(fsCtx as unknown as { sshRegistry: unknown }).sshRegistry = registry
const fs = new SshFileSystem(fsCtx)

// -- writes land in the directory their route names --------------------------
const stamp = Date.now()
const oneTarget = await fs.resolve(`file-${stamp}.txt`, { cwd: `ssh://${c1.id}${cwd}/.dsh-routing-e2e/one` })
const twoTarget = await fs.resolve(`file-${stamp}.txt`, { cwd: `ssh://${c2.id}${cwd}/.dsh-routing-e2e/two` })
assert.notEqual(String(oneTarget.targetKey), String(twoTarget.targetKey), 'the same relative path on two routes is two targets')

await fs.writeText(oneTarget, 'one\n')

// The file written via c1 must exist in c1's directory and NOT in c2's, even
// though both routes share one host — the relative name is not shared.
const oneSession = router.sessionForId(c1.id)
const twoSession = router.sessionForId(c2.id)
const oneInOne = await oneSession.request('stat', { path: `${cwd}/.dsh-routing-e2e/one/file-${stamp}.txt` })
const oneInTwo = await twoSession.request('stat', { path: `${cwd}/.dsh-routing-e2e/two/file-${stamp}.txt` })
assert.equal((oneInOne as { present: boolean }).present, true, 'the file written via c1 must exist in c1\'s directory')
assert.equal((oneInTwo as { present: boolean }).present, false, 'c1\'s file must NOT appear in c2\'s directory')

await fs.writeText(twoTarget, 'two\n')
const twoInTwo = await twoSession.request('stat', { path: `${cwd}/.dsh-routing-e2e/two/file-${stamp}.txt` })
assert.equal((twoInTwo as { present: boolean }).present, true, 'the file written via c2 must exist in c2\'s directory')

// -- subprocess runs in the directory its route names ------------------------
const subCtx = new Context()
subCtx.provide('ssh')
subCtx.provide('sshRegistry')
;(subCtx as unknown as { ssh: unknown }).ssh = defaultTransport
;(subCtx as unknown as { sshRegistry: unknown }).sshRegistry = registry
const subprocess = new SshSubprocessRuntime(subCtx)

const oneRun = subprocess.spawn({
  argv: ['/bin/sh', '-c', 'pwd'],
  cwd: `ssh://${c1.id}${cwd}/.dsh-routing-e2e/one`,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  graceMs: 1000,
})
await oneRun.done
const onePwd = oneRun.collected.stdout?.readFrom(0).text.trim()
assert.equal(onePwd, `${cwd}/.dsh-routing-e2e/one`, 'a spawn routed to c1 must run in c1\'s directory')

const twoRun = subprocess.spawn({
  argv: ['/bin/sh', '-c', 'pwd'],
  cwd: `ssh://${c2.id}${cwd}/.dsh-routing-e2e/two`,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  graceMs: 1000,
})
await twoRun.done
const twoPwd = twoRun.collected.stdout?.readFrom(0).text.trim()
assert.equal(twoPwd, `${cwd}/.dsh-routing-e2e/two`, 'a spawn routed to c2 must run in c2\'s directory')

await subprocess.terminateAll()

// -- cleanup -----------------------------------------------------------------
for (const session of [oneSession, twoSession]) {
  await session.request('remove', { path: `${cwd}/.dsh-routing-e2e/one/file-${stamp}.txt` }).catch(() => undefined)
  await session.request('remove', { path: `${cwd}/.dsh-routing-e2e/two/file-${stamp}.txt` }).catch(() => undefined)
}
await router.dispose()
registry.remove(c1.id)
registry.remove(c2.id)
rmSync(stateFile, { force: true })

console.log('routing-connect.e2e: ok — two routes on one host, writes and spawns land in the directory their cwd names')
process.exit(0)
