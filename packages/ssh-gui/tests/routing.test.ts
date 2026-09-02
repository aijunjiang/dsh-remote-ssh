/**
 * Session-routing tests: two registry connections, one harness process, and
 * every operation landing on the machine its `ssh://<id>/<path>` cwd names.
 *
 * This is the multi-remote parallel-development claim, verified with fake
 * connections whose helper channels record every request — so the test can
 * assert WHICH connection received the write/spawn, not just that something
 * happened.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { SshFileSystem } from '../../fs-ssh/src/index.ts'
import { SshSubprocessRuntime } from '../../subprocess-ssh/src/index.ts'
import { SshHelperRouter } from '../src/helper-router.ts'
import { HELPER_PROTOCOL_VERSION } from '../../ssh/src/protocol.ts'

/** One fake registry connection with a recordable helper channel. */
function fakeConnection(id: string, cwd: string): { connection: unknown; ops: string[] } {
  const ops: string[] = []
  const channel = new EventEmitter() as EventEmitter & {
    write(line: string, cb: (e?: Error | null) => void): boolean
    stderr: EventEmitter
  }
  channel.stderr = new EventEmitter()
  channel.write = (line, cb) => {
    const request = JSON.parse(line) as { id: number; op: string }
    ops.push(request.op)
    cb(null)
    setTimeout(() => {
      const reply = (frame: unknown) => channel.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`))
      if (request.op === 'ping') reply({ id: request.id, ok: true, result: { protocol: HELPER_PROTOCOL_VERSION, python: '3.8', pid: 1, uname: ['Linux'] } })
      else if (request.op === 'env') reply({ id: request.id, ok: true, result: { home: cwd, env: { PATH: '/usr/bin:/bin' } } })
      else if (request.op === 'mkdir') reply({ id: request.id, ok: true, result: { created: true } })
      else if (request.op === 'realpath') reply({ id: request.id, ok: true, result: { path: `${cwd}${request.path.startsWith('/') ? '' : '/'}${request.path}`.replaceAll('//', '/') } })
      else if (request.op === 'write') reply({ id: request.id, ok: true, result: { version: `v-${request.path}`, size: 1 } })
      else if (request.op === 'read') reply({ id: request.id, ok: true, result: { bytes: 0, version: 'v' } })
      else if (request.op === 'stat') reply({ id: request.id, ok: true, result: { present: true, info: { type: 'file', version: 'v1', size: 1 } } })
      else if (request.op === 'spawn') {
        reply({ id: request.id, ok: true, result: { pid: 1000, pgid: 1000, spill: {} } })
        reply({ ev: 'exit', h: request.handle, code: 0, signal: null })
        reply({ ev: 'gone', h: request.handle })
      } else reply({ id: request.id, ok: true, result: {} })
    }, 0)
    return true
  }
  const connection = {
    id,
    label: id,
    cwd,
    getClient: async () => ({
      exec(_command: string, cb: (e: Error | undefined, ch: unknown) => void) {
        cb(undefined, channel)
        // The real daemon announces itself after its exec channel opens; a
        // macrotask guarantees the session registered its data listener first.
        setTimeout(
          () => channel.emit('data', Buffer.from(`${JSON.stringify({ ev: 'ready', protocol: HELPER_PROTOCOL_VERSION, pid: 1 })}\n`)),
          5,
        )
      },
    }),
    getSftp: async () => ({
      mkdir: (_p: string, _o: { mode: number }, cb: (e?: Error) => void) => cb(undefined),
      readFile: (p: string, cb: (e?: (Error & { code?: number }) | undefined, d?: Buffer) => void) =>
        cb(Object.assign(new Error('nf'), { code: 2 })),
      writeFile: (_p: string, _d: string | Buffer, _o: { mode: number }, cb: (e?: Error) => void) => cb(undefined),
    }),
    exec: async (command: string) => ({ exitCode: command.includes('env -0') ? 0 : 0, stdout: 'PATH=/usr/bin', stderr: '' }),
  }
  return { connection, ops }
}

/** A context hosting two registry connections plus a default transport. */
function world(): {
  ctx: Context
  ops: Record<string, string[]>
  defaults: string[]
} {
  const ctx = new Context()
  const conns = {
    c1: fakeConnection('c1', '/home/one'),
    c2: fakeConnection('c2', '/home/two'),
  }
  const defaults: string[] = []
  // The default transport (ctx.ssh) also records which ops it served.
  const defaultChannel = new EventEmitter() as EventEmitter & {
    write(line: string, cb: (e?: Error | null) => void): boolean
    stderr: EventEmitter
  }
  defaultChannel.stderr = new EventEmitter()
  defaultChannel.write = (line, cb) => {
    const request = JSON.parse(line) as { op: string }
    defaults.push(request.op)
    cb(null)
    return true
  }
  const defaultConn = {
    id: 'default',
    cwd: '/home/default',
    getClient: async () => ({ exec: (_c: string, cb: (e: Error | undefined, ch: unknown) => void) => cb(undefined, defaultChannel) }),
    getSftp: async () => ({
      mkdir: (_p: string, _o: { mode: number }, cb: (e?: Error) => void) => cb(undefined),
      readFile: (p: string, cb: (e?: (Error & { code?: number }) | undefined, d?: Buffer) => void) =>
        cb(Object.assign(new Error('nf'), { code: 2 })),
      writeFile: (_p: string, _d: string | Buffer, _o: { mode: number }, cb: (e?: Error) => void) => cb(undefined),
    }),
    exec: async (command: string) => ({ exitCode: 0, stdout: 'PATH=/usr/bin', stderr: '' }),
    // The default transport is also a HelperTransport: record which ops it served.
    request: async (op: string, payload: Record<string, unknown>) => {
      defaults.push(op)
      if (op === 'realpath') return { path: payload.path }
      return {}
    },
    send: async (op: string, payload: Record<string, unknown>) => {
      defaults.push(op)
      if (op === 'realpath') return { path: payload.path }
      return {}
    },
    registerProcess: () => ({ handle: 'default', release: () => {} }),
    runtimePath: (...segments: string[]) => `/home/default/run/${segments.join('/')}`,
  }
  ctx.provide('ssh')
  ;(ctx as unknown as { ssh: unknown }).ssh = defaultConn
  ctx.provide('sshRegistry')
  ;(ctx as unknown as { sshRegistry: unknown }).sshRegistry = {
    get(id: string) {
      return (conns as Record<string, { connection: unknown }>)[id]?.connection
    },
  }
  return { ctx, ops: { c1: conns.c1.ops, c2: conns.c2.ops }, defaults }
}

const tick = async () => {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 2))
}

// -- the router picks the connection the cwd names --------------------------

{
  const { ctx } = world()
  const router = new SshHelperRouter(ctx)
  const first = router.resolveCwd('ssh://c1/home/one/src')
  assert.equal(first.connectionId, 'c1')
  assert.equal(first.base, '/home/one/src')
  const again = router.resolveCwd('ssh://c1/home/one/src/deep')
  assert.equal(again.transport, first.transport, 'one connection gets ONE helper session (cached)')
  const other = router.resolveCwd('ssh://c2/home/two')
  assert.notEqual(other.transport, first.transport, 'a different connection gets its own session')
  assert.equal(other.base, '/home/two')

  // A local placeholder (what the session service hands to providers on
  // Windows) routes to the same connection. The root must match the real
  // sshRoutesRoot(), so it is composed here rather than hard-coded.
  const { sshRoutesRoot } = await import('../src/transport.ts')
  const placeholder = sshRoutesRoot() + '\\c2\\home\\two'
  assert.equal(router.resolveCwd(placeholder).connectionId, 'c2')
  assert.equal(router.resolveCwd(placeholder).base, '/home/two')

  // An unknown connection id is a coded error, not a silent fallback.
  assert.throws(() => router.resolveCwd('ssh://ghost/home'), /unknown connection/)
}

// -- fs operations land on the routed connection ----------------------------

{
  const { ctx, ops } = world()
  const fs = new SshFileSystem(ctx)

  // Resolve with an ssh:// cwd embeds the route in the target key.
  const c1Target = await fs.resolve('a.txt', { cwd: 'ssh://c1/home/one' })
  assert.equal(fs.processPath(c1Target), '/home/one/a.txt')
  assert.equal(String(c1Target.targetKey), 'ssh://c1/home/one/a.txt')

  const c2Target = await fs.resolve('b.txt', { cwd: 'ssh://c2/home/two' })
  assert.equal(fs.processPath(c2Target), '/home/two/b.txt')

  // Targets on different connections are never contained in one another.
  assert.equal(fs.contains(c1Target, c2Target), false, 'cross-machine containment is false')
  const c1Dir = await fs.resolve('.', { cwd: 'ssh://c1/home/one' })
  assert.equal(fs.contains(c1Dir, c1Target), true, 'a target contains its own file')
  assert.equal(fs.contains(c1Dir, c2Target), false, 'a target never contains another machine')

  // Writes go to the machine their key names.
  ops.c1.length = 0
  ops.c2.length = 0
  await fs.writeText(c1Target, 'one\n')
  await tick()
  assert.ok(ops.c1.includes('write'), 'the c1 connection must serve the c1 write')
  assert.ok(!ops.c2.includes('write'), 'the c2 connection must not see the c1 write')

  ops.c1.length = 0
  ops.c2.length = 0
  await fs.writeText(c2Target, 'two\n')
  await tick()
  assert.ok(ops.c2.includes('write'), 'the c2 connection must serve the c2 write')
  assert.ok(!ops.c1.includes('write'), 'the c1 connection must not see the c2 write')

  // A default (unrouted) target uses the default transport.
  const plain = await fs.resolve('/etc/hosts')
  assert.equal(fs.processPath(plain), '/etc/hosts')
}

// -- subprocess spawns land on the routed connection ------------------------

{
  const { ctx, ops } = world()
  const subprocess = new SshSubprocessRuntime(ctx)
  ops.c1.length = 0
  ops.c2.length = 0

  const one = subprocess.spawn({
    argv: ['/bin/sh', '-c', 'true'],
    cwd: 'ssh://c1/home/one',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
  })
  await one.done
  await tick()
  assert.ok(ops.c1.includes('spawn'), 'the c1 spawn must reach c1')
  assert.ok(!ops.c2.includes('spawn'), 'c2 must stay idle')

  const two = subprocess.spawn({
    argv: ['/bin/sh', '-c', 'true'],
    cwd: 'ssh://c2/home/two',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
  })
  await two.done
  await tick()
  assert.ok(ops.c2.includes('spawn'), 'the c2 spawn must reach c2')

  await subprocess.terminateAll()
}

console.log('ssh-gui/routing: ok — cwd decides the machine; writes, containment, and spawns all routed')
