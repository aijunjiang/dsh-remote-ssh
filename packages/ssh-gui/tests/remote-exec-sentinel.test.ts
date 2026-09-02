/**
 * Unit tests for the remote-exec sentinel machinery (no network): the wrapper
 * builder appends an end sentinel and the parser distinguishes a real empty
 * result from a lost one.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { buildWrappedCommand, parseSentinelExit } from '../src/remote-exec.ts'

// -- wrapper builder ---------------------------------------------------------

{
  const { wrapped, token } = buildWrappedCommand('ls config/')
  assert.ok(wrapped.includes('ls config/'), 'wrapper must contain the caller command')
  assert.ok(wrapped.includes(`printf '\\n${token}=%s\\n'`), 'wrapper must print the sentinel last')
  assert.ok(wrapped.endsWith('exit "$__DSHX_RC"'), 'wrapper must exit with the captured rc')
  const again = buildWrappedCommand('ls config/')
  assert.notEqual(again.token, token, 'each run needs a fresh token so content cannot collide')
}

// -- parser ------------------------------------------------------------------

{
  // Sentinel present with rc 0; payload keeps its own trailing newline (the
  // printf separator newline is the one stripped).
  const a = parseSentinelExit('hello\nworld\n\n__DSHX_abc=0\n', '__DSHX_abc')
  assert.equal(a.seen, true)
  assert.equal(a.exit, 0)
  assert.equal(a.stdout, 'hello\nworld\n')

  // Non-zero rc round-trips; payload without a trailing newline stays bare.
  const b = parseSentinelExit('error text\n__DSHX_abc=2\n', '__DSHX_abc')
  assert.equal(b.seen, true)
  assert.equal(b.exit, 2)
  assert.equal(b.stdout, 'error text')

  // A real empty result carries ONLY the sentinel.
  const c = parseSentinelExit('\n__DSHX_abc=0\n', '__DSHX_abc')
  assert.equal(c.seen, true)
  assert.equal(c.stdout, '')

  // Missing sentinel = unverifiable (the silent-loss signal the engine needs).
  const d = parseSentinelExit('', '__DSHX_abc')
  assert.equal(d.seen, false)
  assert.equal(d.exit, null)
  assert.equal(d.stdout, '')

  const e = parseSentinelExit('partial output', '__DSHX_abc')
  assert.equal(e.seen, false)
  assert.equal(e.stdout, 'partial output')

  // A different token must not match (user content cannot fake our sentinel).
  const f = parseSentinelExit('__DSHX_other=0\n', '__DSHX_abc')
  assert.equal(f.seen, false)
}

console.log('ssh-gui remote-exec sentinel: ok — wrapper appends end sentinel, parser distinguishes empty vs lost')
