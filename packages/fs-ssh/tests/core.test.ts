/**
 * Tests for the filesystem provider's pure layers: text handling, edit
 * semantics, path identity, and the error funnel. Every rule checked here is a
 * contract rule with a citation in the module it tests.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  BINARY_SAMPLE_BYTES,
  FsTextError,
  TextStreamDecoder,
  decodeText,
  detectsCrlf,
  normalizeLineEndings,
  restoreLineEndings,
} from '../src/text.ts'
import { FsEditError, applyEdit, countOccurrences, enforceGuard } from '../src/edit.ts'
import { contains, displayPathFor, fileUrl, resolveLexically } from '../src/paths.ts'
import { FsProviderError, assertNotAborted, codeForErrno, mapFsError } from '../src/errors.ts'

// ===========================================================================
// text
// ===========================================================================

assert.equal(decodeText(Buffer.from('hello'), 'a.txt'), 'hello')
assert.equal(decodeText(Buffer.from('héllo 世界'), 'a.txt'), 'héllo 世界')
assert.equal(decodeText(Buffer.alloc(0), 'empty'), '', 'an empty file is valid text')

// A NUL anywhere in the sample window means binary.
{
  const error = (() => {
    try {
      decodeText(Buffer.from([0x61, 0x00, 0x62]), 'bin')
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  assert.ok(error instanceof FsTextError)
  assert.equal(error.code, 'FS_NOT_TEXT')
  assert.match(error.message, /binary file/)
}

// Invalid UTF-8 is refused rather than silently replaced: `editText` writes the
// decoded text back, so a replacement character would corrupt the file.
assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0xfd]), 'bad'), /invalid UTF-8 text/)

// A NUL beyond the sample window is not detected — a documented bound, asserted
// so a future change to BINARY_SAMPLE_BYTES is a deliberate decision.
{
  const late = Buffer.concat([Buffer.alloc(BINARY_SAMPLE_BYTES, 0x61), Buffer.from([0x00])])
  assert.equal(decodeText(late, 'late').length, BINARY_SAMPLE_BYTES + 1)
}

// -- line endings ---------------------------------------------------------

assert.equal(normalizeLineEndings('a\r\nb\r\n'), 'a\nb\n')
assert.equal(normalizeLineEndings('a\nb'), 'a\nb')
// A lone CR is not a line ending we rewrite.
assert.equal(normalizeLineEndings('a\rb'), 'a\rb')

assert.equal(detectsCrlf('a\r\nb\r\nc\r\n'), true)
assert.equal(detectsCrlf('a\nb\nc\n'), false)
assert.equal(detectsCrlf(''), false)
// Majority wins: two CRLF against one LF is a CRLF file.
assert.equal(detectsCrlf('a\r\nb\r\nc\nd'), true)
assert.equal(detectsCrlf('a\r\nb\nc\nd'), false)

assert.equal(restoreLineEndings('a\nb\n', true), 'a\r\nb\r\n')
assert.equal(restoreLineEndings('a\nb\n', false), 'a\nb\n')
// Restoring is idempotent: already-CRLF text must not become CRCRLF.
assert.equal(restoreLineEndings('a\r\nb\r\n', true), 'a\r\nb\r\n')

// The round trip a CRLF edit performs must be lossless.
{
  const stored = 'one\r\ntwo\r\nthree\r\n'
  const crlf = detectsCrlf(stored)
  const normalized = normalizeLineEndings(stored)
  assert.equal(normalized, 'one\ntwo\nthree\n')
  assert.equal(restoreLineEndings(normalized, crlf), stored, 'a CRLF file must survive an edit unchanged')
}

// -- streaming ------------------------------------------------------------

{
  // A character split across chunks must survive.
  const decoder = new TextStreamDecoder('s.txt')
  const bytes = Buffer.from('日本語')
  let text = ''
  for (const byte of bytes) text += decoder.push(Buffer.from([byte]))
  text += decoder.end()
  assert.equal(text, '日本語', 'per-chunk decoding would produce replacement characters here')
}

{
  // A NUL arriving in a later chunk must still be rejected.
  const decoder = new TextStreamDecoder('s.bin')
  decoder.push(Buffer.from('plain text '))
  assert.throws(() => decoder.push(Buffer.from([0x00])), /binary file/)
}

{
  // A stream that ends mid-character is invalid UTF-8, not a partial success.
  const decoder = new TextStreamDecoder('s.txt')
  const bytes = Buffer.from('é')
  decoder.push(bytes.subarray(0, 1))
  assert.throws(() => decoder.end(), /invalid UTF-8 text/)
}

// ===========================================================================
// edit
// ===========================================================================

assert.equal(countOccurrences('aaa', 'a'), 3)
assert.equal(countOccurrences('aaaa', 'aa'), 2, 'occurrences are non-overlapping')
assert.equal(countOccurrences('abc', 'x'), 0)

{
  const result = applyEdit('const a = 1\nconst b = 2\n', { oldString: 'const b = 2', newString: 'const b = 3' })
  assert.equal(result.after, 'const a = 1\nconst b = 3\n')
  assert.equal(result.before, 'const a = 1\nconst b = 2\n')
  assert.equal(result.replacements, 1)
}

// A single-match edit must refuse an ambiguous match rather than guess.
{
  const error = (() => {
    try {
      applyEdit('x\nx\n', { oldString: 'x', newString: 'y' })
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  assert.ok(error instanceof FsEditError)
  assert.equal(error.code, 'FS_AMBIGUOUS_EDIT')
  assert.match(error.message, /appears 2 times/, 'the count belongs in the message so the caller can act')
}

{
  const all = applyEdit('x\nx\nx\n', { oldString: 'x', newString: 'y', replaceAll: true })
  assert.equal(all.after, 'y\ny\ny\n')
  assert.equal(all.replacements, 3)
}

// An absent needle and an empty needle are both FS_EDIT_NOT_FOUND.
for (const [oldString, label] of [['nope', 'absent'], ['', 'empty']] as const) {
  const error = (() => {
    try {
      applyEdit('abc', { oldString, newString: 'x' })
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  assert.ok(error instanceof FsEditError, label)
  assert.equal(error.code, 'FS_EDIT_NOT_FOUND', label)
}

// A CRLF needle against normalized text must still match: the caller may have
// copied the literal out of a CRLF file.
{
  const result = applyEdit('a\nb\n', { oldString: 'a\r\nb', newString: 'c\r\nd' })
  assert.equal(result.after, 'c\nd\n', 'both sides normalize before comparison')
}

// Replacement text is inserted literally — `$&` and friends must not be
// interpreted as replacement patterns. String.replace would corrupt this.
{
  const result = applyEdit('cost: X', { oldString: 'X', newString: '$& $1 $$' })
  assert.equal(result.after, 'cost: $& $1 $$', 'a literal edit must not honour replacement patterns')
}

// The same hazard with replaceAll, and with the needle appearing in the
// replacement (a self-referential edit must not loop or double-apply).
{
  const all = applyEdit('a$&b a$&b', { oldString: '$&', newString: '$$' , replaceAll: true })
  assert.equal(all.after, 'a$$b a$$b')
  const nested = applyEdit('x x', { oldString: 'x', newString: 'xx', replaceAll: true })
  assert.equal(nested.after, 'xx xx', 'a replacement containing the needle must not be rescanned')
}

// -- guards ---------------------------------------------------------------

// Omitting a guard is an unconditional overwrite, not a third behaviour.
enforceGuard({ kind: 'unconditional' }, undefined)
enforceGuard({ kind: 'unconditional' }, 'v1')

enforceGuard({ kind: 'createIfAbsent' }, undefined)
{
  const error = (() => {
    try {
      enforceGuard({ kind: 'createIfAbsent' }, 'v1')
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  assert.ok(error instanceof FsEditError)
  assert.equal(error.code, 'FS_NOT_OBSERVED', 'createIfAbsent meeting a file is NOT_OBSERVED')
}

enforceGuard({ kind: 'replaceIfVersion', version: 'v1' }, 'v1')
for (const [observed, label] of [[undefined, 'absent'], ['v2', 'mismatched']] as const) {
  const error = (() => {
    try {
      enforceGuard({ kind: 'replaceIfVersion', version: 'v1' }, observed)
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  assert.ok(error instanceof FsEditError, label)
  assert.equal(error.code, 'FS_STALE_VERSION', `replaceIfVersion meeting an ${label} target is STALE_VERSION`)
}

// ===========================================================================
// paths
// ===========================================================================

assert.equal(contains('/home/dev/proj', '/home/dev/proj'), true, 'containment is reflexive')
assert.equal(contains('/home/dev/proj', '/home/dev/proj/src/a.ts'), true)
assert.equal(contains('/home/dev/proj', '/home/dev/other'), false)
assert.equal(contains('/home/dev/proj', '/home/dev'), false, 'a parent is not contained by its child')
// A sibling sharing a name prefix must not be considered inside.
assert.equal(contains('/home/dev/proj', '/home/dev/proj-old/x'), false)
assert.equal(contains('/', '/anything'), true)

assert.equal(fileUrl('/home/dev/a.txt'), 'file:///home/dev/a.txt')
assert.equal(fileUrl('/home/dev/my file.txt'), 'file:///home/dev/my%20file.txt')
assert.equal(fileUrl('/home/dev/a#b?c.txt'), 'file:///home/dev/a%23b%3Fc.txt')
assert.equal(fileUrl('/home/dev/日本.txt'), 'file:///home/dev/%E6%97%A5%E6%9C%AC.txt')
assert.ok(!fileUrl('/a/b/c').includes('%2F'), 'separators must survive encoding')

assert.equal(resolveLexically('src/a.ts', '/home/dev/proj'), '/home/dev/proj/src/a.ts')
assert.equal(resolveLexically('/abs/path', '/home/dev/proj'), '/abs/path')
assert.equal(resolveLexically('../sibling', '/home/dev/proj'), '/home/dev/sibling')

assert.equal(displayPathFor('/home/dev/proj/src/a.ts', '/home/dev/proj'), 'src/a.ts')
assert.equal(displayPathFor('/home/dev/proj', '/home/dev/proj'), '.')
assert.equal(
  displayPathFor('/etc/hosts', '/home/dev/proj'),
  '/etc/hosts',
  'a path outside the workspace must not be dressed up as workspace-relative',
)

// ===========================================================================
// errors
// ===========================================================================

assert.equal(codeForErrno('ENOENT'), 'FS_NOT_FOUND')
assert.equal(codeForErrno('ENOTDIR'), 'FS_NOT_DIRECTORY')
assert.equal(codeForErrno('EISDIR'), 'FS_NOT_REGULAR_FILE')
assert.equal(codeForErrno('EACCES'), 'FS_PERMISSION_DENIED')
assert.equal(codeForErrno('EPERM'), 'FS_PERMISSION_DENIED')
assert.equal(codeForErrno('E2BIG'), 'FS_TOO_LARGE')
assert.equal(codeForErrno('EEXIST'), 'FS_NOT_OBSERVED')
assert.equal(codeForErrno('EWHATEVER'), undefined)

// An already-coded error passes through untouched.
{
  const inner = new FsProviderError('binary file', 'FS_NOT_TEXT')
  assert.equal(mapFsError(inner, 'read', 'a.txt'), inner)
}

// A foreign object carrying an FS_ code is preserved, not reclassified.
{
  const mapped = mapFsError({ code: 'FS_STALE_VERSION', message: 'stale' }, 'write', 'a.txt')
  assert.equal(mapped.code, 'FS_STALE_VERSION')
}

// Abort wins over the transport symptom it caused.
{
  const controller = new AbortController()
  controller.abort()
  const mapped = mapFsError(new Error('socket closed'), 'read', 'a.txt', controller.signal)
  assert.equal(mapped.code, 'FS_ABORTED', 'the cancellation is the cause; the I/O error is its symptom')
}

// A helper errno maps; anything else becomes FS_IO_ERROR rather than leaking.
assert.equal(mapFsError(Object.assign(new Error('x'), { code: 'ENOENT' }), 'stat', 'a').code, 'FS_NOT_FOUND')
assert.equal(mapFsError(new Error('protocol desync'), 'read', 'a').code, 'FS_IO_ERROR')
assert.equal(mapFsError('a string', 'read', 'a').code, 'FS_IO_ERROR')

// The cause chain must survive for diagnosis.
{
  const cause = new Error('underlying')
  assert.equal(mapFsError(cause, 'read', 'a').cause, cause)
}

assert.throws(() => assertNotAborted(AbortSignal.abort(), 'read'), /read aborted/)
assertNotAborted(undefined, 'read')
assertNotAborted(new AbortController().signal, 'read')

console.log('fs-ssh/core: ok — text decoding, line endings, edit ordering, guards, path identity, error funnel verified')
