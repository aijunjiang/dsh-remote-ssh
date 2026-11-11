/**
 * Unit tests for the remote background-job helpers (no network).
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { backgroundJobHooks, TailBuffer } from '../src/remote-job.ts'

{
  const tail = new TailBuffer(8)
  tail.push('abcdefgh')
  assert.equal(tail.text(), 'abcdefgh')
  tail.push('ij') // total 10 > cap 8 -> head trimmed by 2
  assert.equal(tail.text(), 'cdefghij', 'overflow must drop from the head')
  assert.equal(tail.text().length, 8)
}

{
  // Chunked writes keep order and cap independently of chunk boundaries.
  const tail = new TailBuffer(5)
  tail.push('123')
  tail.push('456789')
  assert.equal(tail.text(), '56789')
}

{
  const tail = new TailBuffer(4)
  tail.push('')
  tail.push('ab')
  tail.push('c')
  assert.equal(tail.text(), 'abc')
  tail.push('d')
  tail.push('e') // cap reached; head already minimal
  assert.equal(tail.text(), 'bcde', 'a single oversized tail is clipped, not emptied')
}

// -- live output source: what makes job_output / the header log non-empty ----
//
// The hooks own two readers of one output stream: the completion-notice tail
// and the registry's pull source (`output()`). A helper-session stub replays
// two chunks and EOF, so both readers must see every byte exactly once.

{
  const chunks = [Buffer.from('line one\n'), Buffer.from('line two\n')]
  let feed: (() => void) | undefined
  const session = {
    open: async () => undefined,
    loginEnvironment: { PATH: '/usr/bin:/bin' },
    registerProcess: (listeners: { onData(stream: string, chunk: Buffer): void; onExit(code: number | null, signal: number | null): void; onGone(): void }) => {
      feed = () => {
        for (const chunk of chunks) listeners.onData('stdout', chunk)
        listeners.onExit(0, null)
        listeners.onGone()
      }
      return { handle: 'h1', release: () => undefined }
    },
    request: async (op: string) => {
      if (op === 'spawn') {
        // Replay after registration, so the pull source is armed first.
        setTimeout(() => feed?.(), 0)
        return { pid: 10, pgid: 10 }
      }
      return { ok: true }
    },
  } as unknown as Parameters<typeof backgroundJobHooks>[0]

  const hooks = backgroundJobHooks(session, { command: 'echo hi', cwd: '/tmp' })
  const text: string[] = []
  const drained = (async () => {
    for await (const chunk of hooks.output()) text.push(Buffer.from(chunk).toString('utf8'))
  })()

  const outcome = await hooks.done
  await drained
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.output, 'line one\nline two\n', 'the completion notice keeps the whole tail')
  assert.equal(text.join(''), 'line one\nline two\n', 'the pull source delivers every chunk the tail saw, exactly once')
  assert.equal(hooks.readOutput!(), 'line one\nline two\n', 'readOutput answers the same tail')
}

console.log('ssh-gui remote-job: ok — rolling tail buffer and live output source verified')
