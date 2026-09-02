/**
 * Unit tests for helper frame routing, driven by a fake transport. This is the
 * only part of the SSH stack that can be verified without a target, so every
 * boundary condition TCP can produce is pinned here.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { HelperChannel, SshHelperError, SshTransportError } from '../src/channel.ts'

/** A transport fake that records written lines and can fail a write. */
function fakeTransport(options: { failWith?: Error } = {}) {
  const lines: string[] = []
  const logs: { level: string; message: string }[] = []
  const channel = new HelperChannel({
    write(line, callback) {
      lines.push(line)
      callback(options.failWith)
    },
    log(level, message) {
      logs.push({ level, message })
    },
  })
  return { channel, lines, logs }
}

/** The reply frame the helper would send for one request line. */
function replyTo(line: string, result: unknown): string {
  const request = JSON.parse(line) as { id: number }
  return `${JSON.stringify({ id: request.id, ok: true, result })}\n`
}

// -- request/reply round trip -----------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const pending = channel.send('ping', {})
  assert.equal(lines.length, 1)
  const sent = JSON.parse(lines[0]!) as Record<string, unknown>
  assert.equal(sent.op, 'ping')
  assert.equal(sent.id, 1)
  assert.equal(channel.pendingCount, 1)
  channel.consume(replyTo(lines[0]!, { protocol: 1 }))
  assert.deepEqual(await pending, { protocol: 1 })
  assert.equal(channel.pendingCount, 0, 'a settled request must not leak')
}

// Ids must be unique and increasing, and `op` must not be overridable by a
// payload field — otherwise a caller could misroute its own request.
{
  const { channel, lines } = fakeTransport()
  void channel.send('stat', { path: '/a' })
  void channel.send('stat', { path: '/b', op: 'kill', id: 999 } as never)
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  const second = JSON.parse(lines[1]!) as Record<string, unknown>
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(second.op, 'stat', 'payload must never shadow the operation')
}

// -- chunk boundaries -------------------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const pending = channel.send('realpath', { path: '/x' })
  const reply = replyTo(lines[0]!, { path: '/x' })
  // Deliver the frame one byte at a time: nothing may dispatch until the newline.
  for (const byte of reply) channel.consume(byte)
  assert.deepEqual(await pending, { path: '/x' })
}

{
  // Several frames in one chunk, plus a trailing partial line.
  const { channel, lines } = fakeTransport()
  const a = channel.send('stat', { path: '/a' })
  const b = channel.send('stat', { path: '/b' })
  const partial = '{"id":99,"ok":true,'
  channel.consume(replyTo(lines[0]!, { present: true }) + replyTo(lines[1]!, { present: false }) + partial)
  assert.deepEqual(await a, { present: true })
  assert.deepEqual(await b, { present: false })
  // The partial frame must still be buffered, not discarded.
  channel.consume('"result":{}}\n')
}

// -- streamed payload ------------------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const chunks: Buffer[] = []
  const pending = channel.send('read', { path: '/f' }, { onData: (chunk) => void chunks.push(chunk) })
  const id = (JSON.parse(lines[0]!) as { id: number }).id
  channel.consume(`${JSON.stringify({ ev: 'data', id, b64: Buffer.from('hello ').toString('base64') })}\n`)
  channel.consume(`${JSON.stringify({ ev: 'data', id, b64: Buffer.from('world').toString('base64') })}\n`)
  channel.consume(replyTo(lines[0]!, { bytes: 11, version: 'v1' }))
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello world')
  assert.deepEqual(await pending, { bytes: 11, version: 'v1' })
}

// -- coded errors ----------------------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const pending = channel.send('stat', { path: '/missing' })
  const id = (JSON.parse(lines[0]!) as { id: number }).id
  channel.consume(`${JSON.stringify({ id, ok: false, error: { code: 'ENOENT', message: 'nope', errno: 2 } })}\n`)
  const error = await pending.then(() => undefined, (reason: unknown) => reason)
  assert.ok(error instanceof SshHelperError)
  assert.equal(error.code, 'ENOENT')
  assert.equal(error.errno, 2)
  assert.match(error.message, /stat failed/, 'the message must name the operation, not just the id')
}

// -- process events -------------------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const events: string[] = []
  const registration = channel.registerProcess({
    onData: (stream, chunk) => void events.push(`${stream}:${chunk.toString('utf8')}`),
    onEof: (stream) => void events.push(`eof:${stream}`),
    onExit: (code, signal) => void events.push(`exit:${code}:${signal}`),
    onGone: () => void events.push('gone'),
  })
  const handle = registration.handle
  const pending = channel.send('spawn', { handle, argv: ['/bin/true'], cwd: '/', env: {}, stdin: 'ignore' })

  // Output that precedes the spawn reply must still reach the listener — this is
  // exactly why registration happens before the request is sent.
  channel.consume(`${JSON.stringify({ ev: 'data', h: handle, s: 'out', b64: Buffer.from('early').toString('base64') })}\n`)
  channel.consume(replyTo(lines[0]!, { pid: 4321, pgid: 4321 }))
  channel.consume(`${JSON.stringify({ ev: 'data', h: handle, s: 'err', b64: Buffer.from('warn').toString('base64') })}\n`)
  channel.consume(`${JSON.stringify({ ev: 'eof', h: handle, s: 'out' })}\n`)
  channel.consume(`${JSON.stringify({ ev: 'exit', h: handle, code: 7, signal: null })}\n`)
  channel.consume(`${JSON.stringify({ ev: 'gone', h: handle })}\n`)

  assert.deepEqual(await pending, { pid: 4321, pgid: 4321 })
  assert.deepEqual(events, ['out:early', 'err:warn', 'eof:out', 'exit:7:null', 'gone'])

  // After release, further frames for that handle are ignored rather than thrown.
  registration.release()
  channel.consume(`${JSON.stringify({ ev: 'exit', h: handle, code: 0, signal: null })}\n`)
  assert.equal(events.length, 5)
}

// A spill-loss event must reach the handle that owns it.
{
  const { channel } = fakeTransport()
  const lost: string[] = []
  const registration = channel.registerProcess({
    onData: () => {},
    onEof: () => {},
    onExit: () => {},
    onGone: () => {},
    onSpillLost: (reason) => void lost.push(reason),
  })
  channel.consume(`${JSON.stringify({ ev: 'spill', h: registration.handle, lost: true, reason: 'cap' })}\n`)
  assert.deepEqual(lost, ['cap'])
}

// A consumer that never requested a spill omits the listener; the event must
// then be a silent no-op rather than a crash.
{
  const { channel } = fakeTransport()
  const registration = channel.registerProcess({
    onData: () => {},
    onEof: () => {},
    onExit: () => {},
    onGone: () => {},
  })
  channel.consume(`${JSON.stringify({ ev: 'spill', h: registration.handle, lost: true, reason: 'cap' })}\n`)
}

// -- malformed and unknown frames -----------------------------------------

{
  const { channel, logs } = fakeTransport()
  channel.consume('not json at all\n')
  channel.consume('[1,2,3]\n')
  channel.consume('{"ok":true,"result":{}}\n') // a reply with no id
  channel.consume('{"ev":"something-new","x":1}\n') // a newer helper's event
  channel.consume('\n') // an empty line
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 3)
  // The channel must still work afterwards.
  const pending = channel.send('ping', {})
  channel.consume('{"id":1,"ok":true,"result":{"protocol":1}}\n')
  assert.deepEqual(await pending, { protocol: 1 })
}

// A reply for an id nobody is waiting on must be dropped silently.
{
  const { channel, logs } = fakeTransport()
  channel.consume('{"id":404,"ok":true,"result":{}}\n')
  assert.equal(logs.length, 0)
}

// -- readiness ------------------------------------------------------------

{
  // A ready frame that arrives before anyone waits must still be observed.
  const { channel } = fakeTransport()
  channel.consume('{"ev":"ready","protocol":1,"pid":10}\n')
  await channel.waitForReady(1000)
}

{
  const { channel } = fakeTransport()
  const waiting = channel.waitForReady(1000)
  channel.consume('{"ev":"ready","protocol":1,"pid":10}\n')
  await waiting
}

{
  const { channel } = fakeTransport()
  await assert.rejects(channel.waitForReady(20), /did not report ready within 20ms/)
}

// -- channel death --------------------------------------------------------

{
  const { channel, lines } = fakeTransport()
  const pending = channel.send('stat', { path: '/a' })
  let gone = false
  channel.registerProcess({
    onData: () => {},
    onEof: () => {},
    onExit: () => {},
    onGone: () => void (gone = true),
  })
  channel.fail(new SshTransportError('the remote helper exited'))
  await assert.rejects(pending, /the remote helper exited/)
  assert.equal(gone, true, 'a dead channel can no longer observe a tree; gone is the honest terminal state')
  // A request after death fails immediately rather than hanging.
  await assert.rejects(channel.send('ping', {}), /the remote helper exited/)
  assert.equal(lines.length, 1, 'no request may be written after death')
  // Failing twice must not throw and must keep the first cause.
  channel.fail(new Error('later cause'))
  assert.match(String(channel.failure), /the remote helper exited/)
}

// A waiter blocked on readiness must be rejected when the channel dies.
{
  const { channel } = fakeTransport()
  const waiting = channel.waitForReady(5000)
  channel.fail(new SshTransportError('connection closed'))
  await assert.rejects(waiting, /connection closed/)
}

// -- write failure --------------------------------------------------------

{
  const { channel } = fakeTransport({ failWith: new Error('EPIPE') })
  await assert.rejects(channel.send('ping', {}), /failed to write the ping request/)
  assert.equal(channel.pendingCount, 0, 'a failed write must not leave a pending request')
}

console.log('ssh/channel: ok — framing, streaming, process events, malformed input, readiness, and death verified')
