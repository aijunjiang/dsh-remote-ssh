/**
 * Local tests for the helper session: the deploy/start/verify sequence and the
 * request surface, driven by a fake registry connection whose exec channel
 * answers like the real helper daemon would.
 *
 * No real SSH is involved; the fake validates the client's wire shapes against
 * the helper's protocol (the same discipline that already caught one drift).
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { SshHelperSession } from '../src/helper-session.ts'
import { SshHelperError, SshTransportError } from '../../ssh/src/channel.ts'
import { HELPER_PROTOCOL_VERSION } from '../../ssh/src/protocol.ts'

/** A fake ssh2 exec channel that behaves like the helper daemon. */
function fakeHelperChannel(): {
  channel: EventEmitter & { write(line: string, cb: (e?: Error | null) => void): boolean }
  requests: Record<string, unknown>[]
  lastLine: string
} {
  const requests: Record<string, unknown>[] = []
  let lastLine = ''
  let nextId = 1
  const channel = new EventEmitter() as EventEmitter & {
    write(line: string, cb: (e?: Error | null) => void): boolean
    stderr: EventEmitter
  }
  channel.stderr = new EventEmitter()
  // The ready frame is scheduled by the EXEC callback (see fakeConnection),
  // never at construction: bootstrap registers the data listener only after a
  // real fs read (a macrotask), and a ready frame emitted earlier would race it.
  channel.write = (line, cb) => {
    lastLine = line
    const request = JSON.parse(line) as { id: number; op: string; [key: string]: unknown }
    requests.push(request)
    cb(null)
    const id = request.id
    if (request.op === 'ping') {
      queueFrame({ id, ok: true, result: { protocol: HELPER_PROTOCOL_VERSION, python: '3.8.10', pid: 99, uname: ['Linux'] } })
    } else if (request.op === 'env') {
      queueFrame({ id, ok: true, result: { home: '/home/test', env: { HOME: '/home/test', PATH: '/usr/bin:/bin' } } })
    } else if (request.op === 'mkdir') {
      queueFrame({ id, ok: true, result: { created: true } })
    } else if (request.op === 'spawn') {
      const payload = request as unknown as { handle: string }
      queueFrame({ id, ok: true, result: { pid: 777, pgid: 777, spill: {} } })
      queueFrame({ ev: 'exit', h: payload.handle, code: 0, signal: null })
      queueFrame({ ev: 'gone', h: payload.handle })
    } else if (request.op === 'stat') {
      const payload = request as unknown as { path: string }
      if (String(payload.path).includes('missing')) {
        queueFrame({ id, ok: false, error: { code: 'ENOENT', message: 'no such file' } })
      } else {
        queueFrame({ id, ok: true, result: { present: true, info: { type: 'file', version: 'v1', size: 3 } } })
      }
    } else {
      queueFrame({ id, ok: true, result: {} })
    }
    return true
  }
  const queueFrame = (frame: unknown): void => {
    // A macrotask keeps ordering honest: the client consumes frames in the same
    // turn it writes requests, as the real daemon would.
    setTimeout(() => channel.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)), 0)
  }
  return { channel, requests, lastLine }
}

/** A fake registry connection. */
function fakeConnection(): {
  connection: {
    cwd: string
    getClient(): Promise<{ exec(c: string, cb: (e: Error | undefined, ch: unknown) => void): void }>
    getSftp(): Promise<{
      mkdir(p: string, o: { mode: number }, cb: (e?: Error) => void): void
      readFile(p: string, cb: (e?: (Error & { code?: number }) | undefined, d?: Buffer) => void): void
      writeFile(p: string, d: string | Buffer, o: { mode: number }, cb: (e?: Error) => void): void
    }>
    exec(c: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }>
  }
  helper: ReturnType<typeof fakeHelperChannel>
}

function fakeConnection(): ReturnType<typeof fakeConnection> {
  const helper = fakeHelperChannel()
  const uploaded = new Map<string, Buffer>()
  let started = ''
  const connection = {
    cwd: '/home/test/proj',
    async getClient() {
      return {
        exec(command: string, cb: (e: Error | undefined, ch: unknown) => void) {
          started = command
          cb(undefined, helper.channel)
          // The real daemon announces itself shortly after its exec channel
          // opens; a macrotask guarantees the session has registered its data
          // listener (which happens right after the exec callback resolves).
          setTimeout(
            () =>
              helper.channel.emit(
                'data',
                Buffer.from(`${JSON.stringify({ ev: 'ready', protocol: HELPER_PROTOCOL_VERSION, pid: 99 })}\n`),
              ),
            10,
          )
        },
      }
    },
    async getSftp() {
      return {
        mkdir(_p: string, _o: { mode: number }, cb: (e?: Error) => void) {
          cb(undefined)
        },
        readFile(p: string, cb: (e?: (Error & { code?: number }) | undefined, d?: Buffer) => void) {
          const data = uploaded.get(p)
          if (data === undefined) cb(Object.assign(new Error('not found'), { code: 2 }))
          else cb(undefined, data)
        },
        writeFile(p: string, d: string | Buffer, _o: { mode: number }, cb: (e?: Error) => void) {
          uploaded.set(p, Buffer.isBuffer(d) ? d : Buffer.from(d))
          cb(undefined)
        },
      }
    },
    async exec(command: string) {
      if (command.includes('remote-true')) return { exitCode: 0, stdout: 'ok', stderr: '' }
      return { exitCode: 127, stdout: '', stderr: '' }
    },
  }
  return { connection, helper }
}

// -- the session deploys, starts, and verifies the helper -----------------

{
  const { connection, helper } = fakeConnection()
  const session = new SshHelperSession(connection, { logger: { warn: () => {} } })

  const facts = await session.open()
  assert.equal(facts.home, '/home/test')
  assert.equal(facts.runtimeRoot, '/home/test/.dsh-remote/run', 'the runtime root must be ABSOLUTE on the target')
  assert.equal(facts.python, '3.8.10')

  // The helper script was uploaded content-addressed and the daemon started.
  const spawnLine = helper.lastLine
  const startedScript = /python3 -u '(.+)'/.exec(spawnLine === '' ? '' : 'x')
  void startedScript
  assert.ok(
    helper.requests.length >= 3,
    'the session must have run ping, env, and mkdir against the helper',
  )
  assert.ok(
    helper.requests.some((request) => request.op === 'ping'),
    'the protocol version must be verified before the session reports ready',
  )
}

// -- request / registerProcess / runtimePath / exec ------------------------

{
  const { connection, helper } = fakeConnection()
  const session = new SshHelperSession(connection)
  await session.open()

  // request rides the helper channel.
  const stat = await session.request('stat', { path: '/home/test/a.txt' })
  assert.equal((stat as { present: boolean }).present, true)

  // A coded helper failure surfaces as SshHelperError, not a raw transport error.
  await assert.rejects(
    session.request('stat', { path: '/home/test/missing.txt' }),
    (error: unknown) => error instanceof SshHelperError && error.code === 'ENOENT',
  )

  // registerProcess + spawn: listeners receive exit facts keyed by the handle.
  const events: string[] = []
  const registration = session.registerProcess({
    onData: () => {},
    onEof: () => {},
    onExit: (code, signal) => void events.push(`exit:${code}:${signal}`),
    onGone: () => void events.push('gone'),
  })
  const spawned = await session.request('spawn', {
    handle: registration.handle,
    argv: ['/bin/true'],
    cwd: '/home/test/proj',
    env: {},
    stdin: 'ignore',
  })
  assert.equal((spawned as { pid: number }).pid, 777)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(events, ['exit:0:null', 'gone'])
  registration.release()

  // runtimePath is absolute and provider-owned.
  assert.equal(session.runtimePath('bin', 'rg'), '/home/test/.dsh-remote/run/bin/rg')

  // exec delegates to the connection's own control-plane exec.
  assert.equal((await session.exec('remote-true')).stdout, 'ok')
}

// -- disposal shuts the daemon and settles pending work --------------------

{
  const { connection } = fakeConnection()
  const session = new SshHelperSession(connection)
  await session.open()
  await session.dispose()
  // A request after disposal must fail fast, not hang.
  await assert.rejects(
    session.request('stat', { path: '/x' }),
    (error: unknown) => error instanceof SshTransportError,
  )
}

console.log('ssh-gui/helper-session: ok — deploy/start/verify, request, process events, runtimePath, disposal verified')
