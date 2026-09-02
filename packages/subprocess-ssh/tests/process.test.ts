/**
 * Lifecycle tests for one remote process tree, driven by a helper fake that can
 * be scripted to behave like a well-behaved target, a stubborn process tree, or
 * a dead channel.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { RemoteProcessHandle, signalName } from '../src/process.ts'
import type { HelperHost } from '../src/process.ts'

/**
 * A scriptable stand-in for HelperChannel.
 *
 * It VALIDATES every payload against the real wire shapes in
 * `packages/ssh/helper/dsh_helper.py` (`op_spawn`, `op_stdin`, `op_kill`). A fake
 * that accepts anything lets client and helper drift apart silently until the
 * first real connection — which is exactly what happened before this check
 * existed (`stdin` was sent as `{b64, eof}` against a helper reading
 * `{dataB64, close}`, and `kill` as `{handle, signal: 15}` against one reading
 * `{pgid, signal: 'TERM'}`).
 */
function fakeHelper(options: { spawnFails?: Error } = {}) {
  const sent: { op: string; payload: Record<string, unknown> }[] = []
  let listeners: Parameters<HelperHost['registerProcess']>[0] | undefined
  let released = false
  let nextPid = 4321

  const validate = (op: string, payload: Record<string, unknown>): void => {
    if (op === 'spawn') {
      assert.ok(Array.isArray(payload.argv) && payload.argv.length > 0, 'spawn.argv must be a non-empty list')
      assert.equal(typeof payload.cwd, 'string')
      assert.equal(typeof payload.env, 'object')
      assert.ok(payload.stdin === 'ignore' || payload.stdin === 'pipe', 'helper accepts only ignore|pipe')
      if (payload.spill !== undefined) {
        const spill = payload.spill as { maxBytes?: unknown; streams?: Record<string, string> }
        assert.equal(typeof spill.maxBytes, 'number', 'op_spawn raises EINVAL without maxBytes')
        assert.ok(
          spill.streams !== undefined && Object.keys(spill.streams).length > 0,
          'op_spawn raises EINVAL without a streams map',
        )
        for (const [label, path] of Object.entries(spill.streams)) {
          assert.ok(label === 'out' || label === 'err', 'stream label must be out|err')
          assert.ok(path.startsWith('/'), 'op_spawn raises EINVAL for a relative spill path')
        }
      }
      return
    }
    if (op === 'stdin') {
      assert.equal(typeof payload.handle, 'string')
      assert.ok(!('b64' in payload), 'the helper reads dataB64, not b64')
      assert.ok(!('eof' in payload), 'the helper reads close, not eof')
      if (payload.dataB64 !== undefined) assert.equal(typeof payload.dataB64, 'string')
      return
    }
    if (op === 'kill') {
      assert.equal(typeof payload.pgid, 'number', 'the helper signals a pgid, not a handle')
      assert.ok(payload.pgid > 1, 'op_kill refuses pgid <= 1')
      assert.ok(['TERM', 'KILL', 'INT', 'HUP', 'TSTP'].includes(String(payload.signal)), 'signals are names')
      return
    }
  }

  const host: HelperHost = {
    async send(op, payload) {
      validate(op, payload as Record<string, unknown>)
      sent.push({ op, payload: payload as Record<string, unknown> })
      if (op === 'spawn') {
        if (options.spawnFails !== undefined) throw options.spawnFails
        const spill = (payload as { spill?: { streams: Record<string, string> } }).spill
        return { pid: nextPid, pgid: nextPid, spill: spill?.streams ?? {} }
      }
      if (op === 'kill') return { delivered: true, alive: true }
      return {}
    },
    registerProcess(hooks) {
      listeners = hooks
      return {
        handle: 'p1',
        release() {
          released = true
        },
      }
    },
  }
  return {
    host,
    sent,
    get released() {
      return released
    },
    get listeners() {
      return listeners!
    },
    ops: () => sent.map((entry) => entry.op),
    setPid(pid: number) {
      nextPid = pid
    },
  }
}

const BASE = {
  argv: ['/bin/sh', '-c', 'echo hi'],
  cwd: '/home/dev/proj',
  env: { PATH: '/usr/bin' },
  stdin: 'ignore' as const,
  stdout: { maxBytes: 1024 },
  stderr: { maxBytes: 1024 },
  graceMs: 50,
}

/** Yield to the microtask queue so in-flight helper promises settle. */
const tick = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

// -- signal names ----------------------------------------------------------

assert.equal(signalName(15), 'SIGTERM')
assert.equal(signalName(9), 'SIGKILL')
assert.equal(signalName(2), 'SIGINT')
assert.equal(signalName(99), 'SIG99', 'an unknown number must stay reportable')

// -- a normal run ----------------------------------------------------------

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)

  // The spawn is asynchronous, so pid is -1 until the reply lands. The listener
  // registration, however, must already have happened.
  assert.equal(handle.pid, -1)
  assert.ok(helper.listeners !== undefined, 'listeners must be registered before spawn is sent')

  await tick()
  assert.deepEqual(await handle.whenStarted, { pid: 4321, pgid: 4321 })
  assert.equal(handle.pid, 4321, 'the real remote pid must be reported, not -1 forever')

  const spawn = helper.sent[0]!
  assert.equal(spawn.op, 'spawn')
  assert.deepEqual(spawn.payload.argv, ['/bin/sh', '-c', 'echo hi'], 'argv must reach the helper as a list, unquoted')
  assert.equal(spawn.payload.cwd, '/home/dev/proj')
  assert.equal(spawn.payload.stdin, 'ignore')
  assert.equal(spawn.payload.spill, undefined, 'no spill was requested')

  helper.listeners.onData('out', Buffer.from('hi\n'))
  helper.listeners.onExit(0, null)
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
  assert.equal(handle.collected.stdout?.readFrom(0).text, 'hi\n')
  assert.equal(handle.collected.stderr?.readFrom(0).text, '')

  // `done` reports the direct child; the tree is a separate fact.
  let exited = false
  const waiting = handle.waitForExit().then((value) => (exited = value))
  await tick()
  assert.equal(exited, false, 'a surviving descendant must keep waitForExit pending')
  helper.listeners.onGone()
  assert.equal(await waiting, true)
  assert.equal(helper.released, true, 'a finished handle must release its registration')
}

// -- exit fact mapping ----------------------------------------------------

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await tick()
  helper.listeners.onExit(null, 15)
  assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGTERM' })
}

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await tick()
  helper.listeners.onExit(7, null)
  assert.deepEqual(await handle.done, { exitCode: 7, signal: null })
}

// A tree that vanishes without an exit frame (helper or channel death) must
// still settle `done`, or an awaiting caller hangs forever.
{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await tick()
  helper.listeners.onGone()
  assert.deepEqual(await handle.done, { exitCode: null, signal: null })
  assert.equal(await handle.waitForExit(), true)
}

// -- spawn-level failure --------------------------------------------------

{
  const failure = new Error('dsh-ssh: spawn failed: ENOTDIR')
  const helper = fakeHelper({ spawnFails: failure })
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await assert.rejects(handle.done, /ENOTDIR/, 'a spawn-level failure is the only reason done may reject')
  assert.equal(handle.pid, -1, 'pid must stay -1 after a spawn failure')
  assert.equal(helper.released, true)
  // waitForExit must not hang after a failed spawn.
  assert.equal(await handle.waitForExit(), true)
}

// -- termination is tree-scoped and proven, not assumed -------------------

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, graceMs: 20 })
  await tick()
  handle.terminate()
  await tick()

  const kills = helper.sent.filter((entry) => entry.op === 'kill')
  assert.equal(kills.length, 1)
  assert.equal(kills[0]!.payload.signal, 'TERM', 'the escalation starts with TERM')
  assert.equal(kills[0]!.payload.pgid, 4321, 'the GROUP is signalled, which is what makes it tree-scoped')

  // A stubborn tree ignores TERM; after the grace, KILL must follow.
  await new Promise((resolve) => setTimeout(resolve, 45))
  const escalated = helper.sent.filter((entry) => entry.op === 'kill')
  assert.equal(escalated.length, 2)
  assert.equal(escalated[1]!.payload.signal, 'KILL', 'the grace expiring escalates to KILL')

  helper.listeners.onExit(null, 9)
  helper.listeners.onGone()
  assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGKILL' })
}

// A tree that dies during the grace must NOT be KILLed afterwards: the pid may
// already have been reused by then.
{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, graceMs: 40 })
  await tick()
  handle.terminate()
  await tick()
  helper.listeners.onExit(null, 15)
  helper.listeners.onGone()
  await new Promise((resolve) => setTimeout(resolve, 70))
  const signals = helper.sent.filter((entry) => entry.op === 'kill').map((entry) => entry.payload.signal)
  assert.deepEqual(signals, ['TERM'], 'no KILL may be sent to an already-dead group')
}

// terminate() is idempotent and a no-op once the tree is gone.
{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await tick()
  handle.terminate()
  handle.terminate()
  handle.terminate()
  await tick()
  assert.equal(helper.sent.filter((entry) => entry.op === 'kill').length, 1)
  helper.listeners.onGone()
  handle.terminate()
  await tick()
  assert.equal(helper.sent.filter((entry) => entry.op === 'kill').length, 1)
}

// A terminate() issued before the spawn reply lands must not be lost.
{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  handle.terminate() // synchronously, while spawn is still in flight
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const kills = helper.sent.filter((entry) => entry.op === 'kill')
  assert.equal(kills.length, 1, 'the signal must wait for the group id rather than vanish')
  assert.equal(kills[0]!.payload.signal, 'TERM')
}

// -- abort runs the escalation and must not reject done ------------------

{
  const controller = new AbortController()
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, signal: controller.signal })
  await tick()
  controller.abort(new Error('tool timeout'))
  await tick()
  assert.equal(helper.sent.filter((entry) => entry.op === 'kill').length, 1)
  helper.listeners.onExit(null, 15)
  helper.listeners.onGone()
  // The seam classifies timeouts itself; abort must look like an ordinary
  // signal death, never a rejection.
  assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGTERM' })
}

// An already-aborted signal at construction terminates immediately.
{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, signal: AbortSignal.abort() })
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(helper.sent.some((entry) => entry.op === 'kill'))
  void handle
}

// -- waitForExit honours its own signal ---------------------------------

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, BASE)
  await tick()
  const controller = new AbortController()
  const waiting = handle.waitForExit(controller.signal)
  controller.abort()
  assert.equal(await waiting, false, 'an aborted wait reports false, not an exception')
  // The tree is still alive, so a later unbounded wait still works.
  const later = handle.waitForExit()
  helper.listeners.onGone()
  assert.equal(await later, true)
}

// -- stdin dispositions -------------------------------------------------

{
  // The batch shape writes the bytes and closes.
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, stdin: { data: 'payload' } })
  await tick()
  assert.equal(handle.stdin, undefined, 'the batch shape exposes no writable')
  const write = helper.sent.find((entry) => entry.op === 'stdin')!
  assert.equal(Buffer.from(String(write.payload.dataB64), 'base64').toString('utf8'), 'payload')
  assert.equal(write.payload.close, true)
}

{
  // 'pipe' exposes a Writable whose writes and end become helper ops.
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, { ...BASE, stdin: 'pipe' })
  await tick()
  assert.ok(handle.stdin !== undefined)
  handle.stdin.write('one')
  await tick()
  handle.stdin.end()
  await tick()
  const writes = helper.sent.filter((entry) => entry.op === 'stdin')
  assert.equal(writes.length, 2)
  assert.equal(Buffer.from(String(writes[0]!.payload.dataB64), 'base64').toString('utf8'), 'one')
  assert.equal(writes[0]!.payload.close, undefined, 'an ordinary write must not close fd 0')
  assert.equal(writes[1]!.payload.close, true, 'end() closes the child fd, never the SSH channel')
  assert.equal(writes[1]!.payload.dataB64, undefined)
}

// -- remote spill request ----------------------------------------------

{
  const helper = fakeHelper()
  const handle = new RemoteProcessHandle(helper.host, {
    ...BASE,
    stdout: { maxBytes: 16, spill: { maxBytes: 1_000, path: '/home/dev/.dsh-remote/run/p/out.log' } },
  })
  await tick()
  const spawn = helper.sent[0]!
  const spill = spawn.payload.spill as { maxBytes: number; streams: Record<string, string> }
  assert.deepEqual(
    spill.streams,
    { out: '/home/dev/.dsh-remote/run/p/out.log' },
    'each stream names its own file, and the path is on the TARGET',
  )
  assert.equal(spill.maxBytes, 1_000)

  // The reported spillPath is the remote one, so the model can actually read it.
  helper.listeners.onData('out', Buffer.from('x'.repeat(40)))
  const read = handle.collected.stdout!.readFrom(0)
  assert.equal(read.spillPath, '/home/dev/.dsh-remote/run/p/out.log')
  assert.equal(read.lossy, true, '40 bytes into a 16-byte window is lossy')
  assert.equal(read.text.length, 16)

  // When the helper reports the spill discarded, the path must stop being
  // advertised: a path that no longer exists is worse than none.
  helper.listeners.onSpillLost!('cap')
  assert.equal(handle.collected.stdout!.readFrom(0).spillPath, undefined)
}

console.log('subprocess-ssh/process: ok — lifecycle, exit mapping, proven tree termination, abort, stdin, and remote spill verified')
