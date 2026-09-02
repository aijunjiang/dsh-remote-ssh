/**
 * Service-shell tests: the provider's eager validations, remote-world
 * environment assembly, ripgrep translation, and disposal behaviour, all driven
 * by a fake connection.
 *
 * This is where the pieces meet, so it is also where a wiring mistake (a probe
 * that never runs, a scrub that is skipped, argv that reaches the target
 * untranslated) would show up.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SshSubprocessRuntime } from '../src/index.ts'

/**
 * A connection fake hosted on a REAL cordis Context.
 *
 * The context is real because the provider extends the seam's own abstract
 * Service: a hand-rolled context stub would exercise a different base class than
 * the harness loads, which is precisely the fake-vs-real divergence that already
 * hid a wire-shape bug in this package.
 */
function fakeConnection() {
  const sent: { op: string; payload: Record<string, unknown> }[] = []
  const execCalls: string[] = []
  let listeners: Record<string, (...args: never[]) => void> | undefined
  const connection = {
    cwd: '/home/dev/proj',
    async send(op: string, payload: object) {
      sent.push({ op, payload: payload as Record<string, unknown> })
      if (op === 'spawn') return { pid: 777, pgid: 777, spill: {} }
      return {}
    },
    registerProcess(hooks: Record<string, (...args: never[]) => void>) {
      listeners = hooks
      return { handle: 'p1', release() {} }
    },
    async exec(command: string) {
      execCalls.push(command)
      if (command === 'env -0') {
        return {
          exitCode: 0,
          // A realistic login environment, including things that must not leak.
          stdout: 'PATH=/usr/local/bin:/usr/bin:/bin\0HOME=/home/dev\0LANG=C.UTF-8\0DEEPSEEK_API_KEY=sk-leak\0DSH_SESSION=abc\0',
          stderr: '',
        }
      }
      if (command === 'command -v rg') return { exitCode: 0, stdout: '/usr/bin/rg\n', stderr: '' }
      if (command === "'/usr/bin/rg' --version") {
        return { exitCode: 0, stdout: 'ripgrep 14.1.0\n', stderr: '' }
      }
      if (/^PATH=.* command -v -- 'git'$/.test(command)) return { exitCode: 0, stdout: '/usr/bin/git\n', stderr: '' }
      if (/command -v -- 'nosuch'$/.test(command)) return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 127, stdout: '', stderr: '' }
    },
    runtimePath(...segments: readonly string[]) {
      return ['/home/dev/.dsh-remote/run', ...segments].join('/')
    },
  }
  const ctx = new Context()
  ctx.provide('ssh')
  ;(ctx as unknown as { ssh: unknown }).ssh = connection
  return {
    ctx: ctx as never,
    connection,
    sent,
    execCalls,
    get listeners() {
      return listeners!
    },
  }
}

const STDIO = { stdin: 'ignore' as const, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }
const tick = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

// -- the service registers on the seam -------------------------------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  assert.equal(typeof runtime.spawn, 'function')
  assert.equal(typeof runtime.resolveExecutable, 'function')
  assert.equal(typeof runtime.spawnTerminal, 'function')
  assert.deepEqual(SshSubprocessRuntime.inject, ['ssh'], 'the provider depends on the connection owner')
}

// -- eager validation happens in spawn, synchronously ---------------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  assert.throws(
    () => runtime.spawn({ argv: [], cwd: '/x', stdio: STDIO, graceMs: 100 }),
    /non-empty program name/,
  )
  assert.throws(
    () => runtime.spawn({ argv: ['/bin/true'], cwd: '/x', stdio: STDIO, graceMs: 0 }),
    /positive finite number/,
  )
  assert.throws(
    () => runtime.spawn({ argv: ['/bin/true'], cwd: '/x', stdio: STDIO, graceMs: Number.POSITIVE_INFINITY }),
    /positive finite number/,
  )
  assert.throws(
    () =>
      runtime.spawn({
        argv: ['/bin/true'],
        cwd: '/x',
        stdio: STDIO,
        graceMs: 100,
        signal: AbortSignal.abort('gone'),
      }),
    /aborted before spawn/,
  )
  assert.equal(world.sent.length, 0, 'a rejected spawn must not touch the connection')
}

// An explicit credential-shaped entry must survive: explicit env is the
// documented escape hatch, merged AFTER the scrub.
{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  runtime.spawn({
    argv: ['/usr/bin/env'],
    cwd: '/home/dev/proj',
    stdio: STDIO,
    env: { DEEPSEEK_API_KEY: 'sk-forwarded-on-purpose' },
    graceMs: 100,
  })
  await tick()
  const spawn = world.sent.find((entry) => entry.op === 'spawn')!
  const sent = spawn.payload.env as Record<string, string>
  assert.equal(
    sent.DEEPSEEK_API_KEY,
    'sk-forwarded-on-purpose',
    'the helper must receive the explicit credential, or the child never sees it',
  )
  assert.equal(sent.PATH, '/usr/local/bin:/usr/bin:/bin', 'the scrub base must still be there')
}

// -- the child environment comes from the TARGET and is scrubbed ----------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  const handle = runtime.spawn({
    argv: ['/usr/bin/git', 'status'],
    cwd: '/home/dev/proj',
    stdio: STDIO,
    env: { GIT_AUTHOR_NAME: 'dsh', LANG: undefined },
    graceMs: 100,
  })
  await tick()

  assert.ok(world.execCalls.includes('env -0'), 'the environment must be probed on the target')
  const spawn = world.sent.find((entry) => entry.op === 'spawn')!
  const env = spawn.payload.env as Record<string, string>
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin', 'the TARGET PATH, not the host one')
  assert.equal(env.HOME, '/home/dev')
  assert.equal(env.GIT_AUTHOR_NAME, 'dsh', 'explicit entries layer over the scrub')
  assert.ok(!('LANG' in env), 'an explicit undefined is a tombstone')
  assert.ok(!('DEEPSEEK_API_KEY' in env), 'credential-shaped names must never reach another machine')
  assert.ok(!('DSH_SESSION' in env), 'the harness namespace must not leak')
  assert.equal(handle.pid, 777)

  // A second spawn must reuse the probe rather than pay for it again.
  const before = world.execCalls.filter((call) => call === 'env -0').length
  runtime.spawn({ argv: ['/bin/true'], cwd: '/home/dev/proj', stdio: STDIO, graceMs: 100 })
  await tick()
  assert.equal(world.execCalls.filter((call) => call === 'env -0').length, before, 'the probe is cached')
}

// -- glob/grep: the host ripgrep path is translated ---------------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  const hostRg = 'C:\\proj\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe'

  // resolveExecutable must answer with the TARGET's ripgrep.
  assert.equal(await runtime.resolveExecutable(hostRg), '/usr/bin/rg')

  // And a spawn must reach the helper already translated.
  runtime.spawn({
    argv: [hostRg, '--no-config', '--files'],
    cwd: '/home/dev/proj',
    stdio: STDIO,
    graceMs: 100,
  })
  await tick()
  const spawn = world.sent.find((entry) => entry.op === 'spawn')!
  assert.deepEqual(
    spawn.payload.argv,
    ['/usr/bin/rg', '--no-config', '--files'],
    'without this, glob and grep die with exit 127 on every remote session',
  )
}

// A host path in a later argv element is translated through the route table.
{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {
    routes: [{ hostPrefix: 'C:\\Users\\me\\.dsh\\routes\\prod', remotePrefix: '/home/dev/proj' }],
  })
  runtime.spawn({
    argv: ['C:\\p\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', '--files', 'C:\\Users\\me\\.dsh\\routes\\prod\\src'],
    cwd: '/home/dev/proj',
    stdio: STDIO,
    graceMs: 100,
  })
  await tick()
  const spawn = world.sent.find((entry) => entry.op === 'spawn')!
  assert.deepEqual(spawn.payload.argv, ['/usr/bin/rg', '--files', '/home/dev/proj/src'])
}

// -- resolveExecutable delegates the ordinary cases ---------------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  assert.equal(await runtime.resolveExecutable('git'), '/usr/bin/git')
  await assert.rejects(runtime.resolveExecutable('nosuch'), /was not found on the target's PATH/)
  await assert.rejects(runtime.resolveExecutable('./local'), /is a relative path/)
}

// -- terminals fail honestly rather than pretending -------------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  await assert.rejects(runtime.spawnTerminal(), /spawnTerminal is not implemented yet/)
}

// -- disposal terminates managed trees and awaits them ----------------

{
  const world = fakeConnection()
  const runtime = new SshSubprocessRuntime(world.ctx, {})
  const handle = runtime.spawn({ argv: ['/bin/sleep', '300'], cwd: '/home/dev/proj', stdio: STDIO, graceMs: 20 })
  await tick()

  const disposal = runtime.terminateAll()
  await tick()
  const kills = world.sent.filter((entry) => entry.op === 'kill')
  assert.equal(kills.length, 1, 'disposal must terminate every managed tree')
  assert.equal(kills[0]!.payload.signal, 'TERM')
  assert.equal(kills[0]!.payload.pgid, 777)

  // Disposal must not resolve until the tree is actually gone.
  let settled = false
  void disposal.then(() => (settled = true))
  await tick()
  assert.equal(settled, false, 'an orphan on someone else\'s machine must block teardown')
  world.listeners.onExit(null as never, 15 as never)
  world.listeners.onGone()
  await disposal
  assert.equal(settled, true)

  // A spawn after disposal is refused.
  assert.throws(
    () => runtime.spawn({ argv: ['/bin/true'], cwd: '/home/dev/proj', stdio: STDIO, graceMs: 100 }),
    /service is disposing/,
  )
  void handle
}

console.log('subprocess-ssh/service: ok — validation, remote env scrub, ripgrep translation, and disposal verified')
