/**
 * End-to-end proof of the P-U2 claim: the GUI connection (registry → ssh2
 * client) plus THIS repository's helper-backed capability providers, working
 * together on a real target.
 *
 * The browser half of a connection and the agent half share one TCP connection:
 * SFTP listing for the GUI, helper channel for the providers. If this passes,
 * the connection sidebar in the dsh web GUI can drive real remote development.
 *
 *   $env:DSH_SSH_HOST='192.168.10.125'   # required
 *   $env:DSH_SSH_USER='amax'             # required
 *   $env:DSH_SSH_CWD='/home/amax'        # required
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
import { SshFileSystem } from '../../fs-ssh/src/index.ts'
import { SshSubprocessRuntime } from '../../subprocess-ssh/src/index.ts'

const host = process.env.DSH_SSH_HOST
const username = process.env.DSH_SSH_USER
const cwd = process.env.DSH_SSH_CWD

if (host === undefined || username === undefined || cwd === undefined || process.env.DSH_SSH_PASSWORD === undefined) {
  console.log('gui-connect.e2e: skipped — set DSH_SSH_HOST, DSH_SSH_USER, DSH_SSH_CWD and DSH_SSH_PASSWORD')
  process.exit(0)
}

const stateFile = join(process.cwd(), '.scratch-gui-e2e-connections.json')
const ctx = new Context()
const registry = new SshRegistry(ctx, { stateFile })
const added = registry.add({
  label: 'e2e target',
  host,
  port: 22,
  username,
  cwd,
  auth: 'password',
  password: process.env.DSH_SSH_PASSWORD,
  jumpHosts: [],
})
const connection = registry.get(added.id)!
assert.ok(connection !== undefined, 'the registry must hand back a live connection')

// -- the helper session rides the registry connection's own transport --------
const session = new SshHelperSession(connection, { logger: { warn: (m) => console.log('[warn]', m) } })
const facts = await session.open()
console.log('helper session on registry connection:', {
  home: facts.home,
  runtimeRoot: facts.runtimeRoot,
  python: facts.python,
})
assert.ok(facts.home.startsWith('/'), 'home must be absolute')
assert.ok(facts.runtimeRoot.startsWith('/'), 'the runtime root must be absolute (spills live on the target)')

// -- the fs provider rides the session ----------------------------------------
const fsCtx = new Context()
fsCtx.provide('ssh')
;(fsCtx as unknown as { ssh: unknown }).ssh = session
const fs = new SshFileSystem(fsCtx)

const file = `${cwd}/.dsh-gui-e2e-${Date.now()}.txt`
const target = await fs.resolve(file)
const created = await fs.writeText(target, 'hello from the gui connection\n')
assert.equal(created.operation, 'create')
assert.equal(await fs.readText(target), 'hello from the gui connection\n')
const edited = await fs.editText(target, { oldString: 'gui connection', newString: 'registry connection' })
assert.equal(edited.after, 'hello from the registry connection\n')
const entries = await fs.listDir(await fs.resolve(cwd))
assert.ok(entries.some((entry) => entry.target.targetKey === file), 'the new file must appear in the listing')
await fsCtx.ssh.request('remove', { path: file })

// -- the subprocess provider rides the session --------------------------------
const subCtx = new Context()
subCtx.provide('ssh')
;(subCtx as unknown as { ssh: unknown }).ssh = session
const subprocess = new SshSubprocessRuntime(subCtx)

const handle = subprocess.spawn({
  argv: ['/bin/sh', '-c', 'printf "gui-ok"; sleep 120 & exit 0'],
  cwd,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  graceMs: 500,
})
await handle.whenStarted
handle.terminate()
assert.equal(await handle.waitForExit(), true, 'tree-scoped termination must silence the background sleep too')
assert.equal(handle.collected.stdout?.readFrom(0).text, 'gui-ok')
await subprocess.terminateAll()

await session.dispose()
registry.remove(added.id)
rmSync(stateFile, { force: true })

console.log('gui-connect.e2e: ok — registry connection + helper session + fs/subprocess providers all verified')
process.exit(0)
