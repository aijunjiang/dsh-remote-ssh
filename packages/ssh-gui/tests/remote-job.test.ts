/**
 * Unit tests for the remote background-job helpers (no network).
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { TailBuffer } from '../src/remote-job.ts'

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

console.log('ssh-gui remote-job: ok — rolling tail buffer verified')
