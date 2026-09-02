/**
 * Contract tests for bounded output collection, checked against
 * `packages/subprocess/subprocess/src/types.ts:44-52,120-148`.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { OutputCollector } from '../src/output.ts'

const REMOTE_SPILL = '/home/dev/.dsh-remote/run/processes/abc/stdout.log'

// -- offsets are whole-stream, reads are non-consuming ----------------------

{
  const collector = new OutputCollector({ maxBytes: 1024 })
  collector.append(Buffer.from('hello '))
  collector.append(Buffer.from('world'))

  const first = collector.readFrom(0)
  assert.equal(first.text, 'hello world')
  assert.equal(first.nextOffset, 11)
  assert.equal(first.lossy, false)
  assert.equal(first.spillPath, undefined, 'no spill was configured')

  // Re-reading the same offset must give the same answer: reads do not consume.
  assert.equal(collector.readFrom(0).text, 'hello world')
  // A second independent reader with its own cursor is unaffected by the first.
  assert.equal(collector.readFrom(6).text, 'world')
  // Reading at the end yields nothing and holds the offset steady.
  const tail = collector.readFrom(11)
  assert.equal(tail.text, '')
  assert.equal(tail.nextOffset, 11)
  assert.equal(tail.lossy, false)

  // Incremental reads compose into the whole stream.
  collector.append(Buffer.from('!'))
  const delta = collector.readFrom(tail.nextOffset)
  assert.equal(delta.text, '!')
  assert.equal(delta.nextOffset, 12)
  assert.equal(collector.byteLength, 12)
}

// -- the memory cap keeps the TAIL -----------------------------------------

{
  const collector = new OutputCollector({ maxBytes: 8 })
  collector.append(Buffer.from('0123456789ABCDEF')) // 16 bytes into an 8-byte window
  assert.equal(collector.truncated, true)
  assert.equal(collector.byteLength, 16)

  const read = collector.readFrom(0)
  assert.equal(read.text, '89ABCDEF', 'the tail is retained, not the head')
  assert.equal(read.lossy, true, 'offset 0 slid out of the window')
  assert.equal(read.nextOffset, 16)

  // An offset inside the window is an ordinary, non-lossy read.
  const inside = collector.readFrom(10)
  assert.equal(inside.text, 'ABCDEF')
  assert.equal(inside.lossy, false)
  // Exactly at the window start is still inside.
  assert.equal(collector.readFrom(8).lossy, false)
  assert.equal(collector.readFrom(7).lossy, true, 'one byte before the window is lossy')
}

// Trimming across many small appends must land on the same window as one big one.
{
  const chunked = new OutputCollector({ maxBytes: 5 })
  for (const byte of '0123456789') chunked.append(Buffer.from(byte))
  assert.equal(chunked.readFrom(0).text, '56789')
  assert.equal(chunked.byteLength, 10)
}

// A zero-byte cap retains nothing but must keep offsets monotonic.
{
  const none = new OutputCollector({ maxBytes: 0 })
  none.append(Buffer.from('abc'))
  const read = none.readFrom(0)
  assert.equal(read.text, '')
  assert.equal(read.nextOffset, 3, 'offsets must not rewind just because nothing is retained')
  assert.equal(read.lossy, true)
  none.append(Buffer.from('de'))
  assert.equal(none.readFrom(3).nextOffset, 5)
}

// Empty appends must not disturb anything.
{
  const collector = new OutputCollector({ maxBytes: 4 })
  collector.append(Buffer.alloc(0))
  assert.equal(collector.byteLength, 0)
  assert.equal(collector.readFrom(0).text, '')
}

// -- byte offsets vs text: multi-byte characters ---------------------------

{
  // "héllo" is 6 bytes: h(1) é(2) l l o.
  const collector = new OutputCollector({ maxBytes: 1024 })
  collector.append(Buffer.from('h'))
  // Split é across two appends: a per-chunk toString() would corrupt it.
  const accented = Buffer.from('é')
  collector.append(accented.subarray(0, 1))
  collector.append(accented.subarray(1))
  collector.append(Buffer.from('llo'))
  assert.equal(collector.readFrom(0).text, 'héllo', 'a character split across chunks must survive')
  assert.equal(collector.byteLength, 6, 'offsets are bytes, not characters')
}

{
  // A window trim that cuts a character in half must not throw; the orphaned
  // continuation byte renders as U+FFFD, the honest reading of a cut tail.
  // "aaé" is 4 bytes (a, a, 0xC3, 0xA9); appending 3 bytes drops 3, so the
  // window starts on the ORPHANED second byte of é.
  const collector = new OutputCollector({ maxBytes: 4 })
  collector.append(Buffer.from('aaé', 'utf8'))
  collector.append(Buffer.from('bcd'))
  const read = collector.readFrom(0)
  assert.equal(read.text, '\uFFFDbcd', 'an orphaned continuation byte must render as one replacement char')
  assert.equal(read.nextOffset, 7, 'byte offsets are unaffected by decoding')

  // Dropping a whole character instead must leave the rest intact.
  const clean = new OutputCollector({ maxBytes: 4 })
  clean.append(Buffer.from('aaé', 'utf8'))
  clean.append(Buffer.from('b'))
  assert.equal(clean.readFrom(0).text, 'aéb')
}

// -- spill accounting -----------------------------------------------------

{
  // Within the cap, the remote path is reported on every read.
  const collector = new OutputCollector({ maxBytes: 4, spill: { maxBytes: 100, path: REMOTE_SPILL } })
  collector.append(Buffer.from('0123456789'))
  const read = collector.readFrom(0)
  assert.equal(read.spillPath, REMOTE_SPILL, 'the spill path must be a REMOTE path, readable in the model\'s world')
  assert.equal(read.lossy, true, 'memory truncation is independent of the spill')
}

{
  // Exceeding the spill cap discards the file and stops reporting it: a partial
  // record presented as the full stream is worse than none.
  const collector = new OutputCollector({ maxBytes: 4, spill: { maxBytes: 8, path: REMOTE_SPILL } })
  collector.append(Buffer.from('12345678'))
  assert.equal(collector.readFrom(0).spillPath, REMOTE_SPILL, 'exactly at the cap is still intact')
  collector.append(Buffer.from('9'))
  assert.equal(collector.readFrom(0).spillPath, undefined, 'past the cap the spill is discarded')
  assert.ok(!('spillPath' in collector.readFrom(0)), 'the key must be absent, not undefined-valued')
  // Loss is permanent: later reads must never resurrect the path.
  collector.append(Buffer.from('0'))
  assert.equal(collector.readFrom(0).spillPath, undefined)
}

{
  // A helper-reported write failure has the same effect as a cap overflow.
  const collector = new OutputCollector({ maxBytes: 16, spill: { maxBytes: 1_000, path: REMOTE_SPILL } })
  collector.append(Buffer.from('abc'))
  collector.markSpillLost()
  assert.equal(collector.readFrom(0).spillPath, undefined)
}

// -- input validation -----------------------------------------------------

assert.throws(() => new OutputCollector({ maxBytes: -1 }), /non-negative integer/)
assert.throws(() => new OutputCollector({ maxBytes: 1.5 }), /non-negative integer/)
assert.throws(
  () => new OutputCollector({ maxBytes: 8, spill: { maxBytes: 8, path: 'relative/spill.log' } }),
  /absolute remote path/,
)
assert.throws(() => new OutputCollector({ maxBytes: 8 }).readFrom(-1), /non-negative integer/)

console.log('subprocess-ssh/output: ok — offsets, tail retention, split characters, and remote spill accounting verified')
