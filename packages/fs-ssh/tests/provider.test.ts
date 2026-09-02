/**
 * Provider tests for the remote filesystem, driven by a fake helper connection.
 *
 * These cover what the pure-layer tests cannot: the ORDER of round trips, the
 * exact payloads sent, and the sequences where a wiring mistake hides — a guard
 * checked after the write, a cap that never reaches the helper, a listing that
 * secretly costs one round trip per entry, an edit that publishes without its
 * compare-and-swap.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { SshFileSystem } from '../src/index.ts'

/** Files the fake target holds: remote path → content and version. */
interface FakeFile {
  content: string
  version: string
  type?: 'file' | 'directory' | 'symlink' | 'other'
}

/**
 * A helper-connection fake with a tiny in-memory target.
 *
 * It VALIDATES payloads against the real helper's expectations, so a client that
 * sends a field the helper does not read fails here rather than on first
 * connection.
 */
function fakeTarget(files: Record<string, FakeFile> = {}) {
  const calls: { op: string; payload: Record<string, unknown> }[] = []
  const connection = {
    cwd: '/home/dev/proj',
    async request(op: string, payload: object, options?: { onData?: (chunk: Buffer) => void }) {
      const fields = payload as Record<string, unknown>
      calls.push({ op, payload: fields })
      if (op === 'realpath') {
        assert.equal(typeof fields.path, 'string')
        const path = String(fields.path)
        const base = String(fields.cwd ?? '/home/dev/proj')
        // `realpath -m`: a missing final segment still canonicalizes.
        const absolute = path.startsWith('/') ? path : `${base}/${path}`.replaceAll('//', '/')
        const segments: string[] = []
        for (const segment of absolute.split('/')) {
          if (segment === '' || segment === '.') continue
          if (segment === '..') segments.pop()
          else segments.push(segment)
        }
        return { path: `/${segments.join('/')}` }
      }
      if (op === 'stat' || op === 'lstat') {
        const file = files[String(fields.path)]
        if (file === undefined) return { present: false }
        // The real helper nests metadata under `info`; the fake must mirror that
        // exactly, or a shape mismatch sails through the tests (it did: the
        // provider read the flat shape while the helper sent `info`).
        return {
          present: true,
          info: {
            type: file.type ?? 'file',
            size: Buffer.byteLength(file.content),
            version: file.version,
          },
        }
      }
      if (op === 'listdir') {
        const prefix = `${String(fields.path)}/`
        const entries = Object.entries(files)
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          // Deliberately unsorted, so the provider's ordering guarantee is tested.
          .reverse()
          .map(([path, file]) => ({
            name: path.slice(prefix.length),
            type: file.type ?? 'file',
            size: Buffer.byteLength(file.content),
            version: file.version,
          }))
        return { entries }
      }
      if (op === 'read') {
        const file = files[String(fields.path)]
        if (file === undefined) {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
        }
        const bytes = Buffer.from(file.content, 'utf8')
        const cap = fields.maxBytes
        if (typeof cap === 'number' && bytes.length > cap) {
          throw Object.assign(new Error('too large'), { code: 'E2BIG' })
        }
        // Deliver in small chunks so cross-chunk decoding is exercised.
        for (let offset = 0; offset < bytes.length; offset += 3) {
          options?.onData?.(bytes.subarray(offset, offset + 3))
        }
        return { bytes: bytes.length, version: file.version }
      }
      if (op === 'write') {
        assert.equal(typeof fields.dataB64, 'string', 'the helper reads dataB64')
        const path = String(fields.path)
        const existing = files[path]
        if (fields.exclusive === true && existing !== undefined) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        }
        if (fields.ifVersion !== undefined) {
          if (existing === undefined) throw Object.assign(new Error('vanished'), { code: 'ESTALE' })
          if (existing.version !== fields.ifVersion) {
            throw Object.assign(new Error('changed'), { code: 'ESTALE' })
          }
        }
        const content = Buffer.from(String(fields.dataB64), 'base64').toString('utf8')
        const version = `v-${content.length}-${Math.random().toString(36).slice(2, 8)}`
        files[path] = { content, version }
        return { version, size: Buffer.byteLength(content) }
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
  const ctx = new Context()
  ctx.provide('ssh')
  ;(ctx as unknown as { ssh: unknown }).ssh = connection
  return { ctx: ctx as never, files, calls, ops: () => calls.map((call) => call.op) }
}

// -- resolve: canonical, stable, and works for a file that does not exist yet

{
  const world = fakeTarget()
  const fs = new SshFileSystem(world.ctx)

  const target = await fs.resolve('src/a.ts')
  assert.equal(fs.processPath(target), '/home/dev/proj/src/a.ts')
  assert.equal(target.displayPath, 'src/a.ts')

  // A path whose last segment does not exist must still resolve — every file
  // creation starts here, and SFTP's own realpath fails on it.
  const fresh = await fs.resolve('src/brand-new.ts')
  assert.equal(fs.processPath(fresh), '/home/dev/proj/src/brand-new.ts')

  // The same file must always produce the same key, however it was spelled.
  const spellings = await Promise.all([
    fs.resolve('src/a.ts'),
    fs.resolve('./src/a.ts'),
    fs.resolve('src/../src/a.ts'),
    fs.resolve('/home/dev/proj/src/a.ts'),
  ])
  const keys = new Set(spellings.map((entry) => fs.processPath(entry)))
  assert.equal(keys.size, 1, 'containment and staleness are string comparisons over this key')

  // A path outside the workspace keeps its absolute display path.
  const outside = await fs.resolve('/etc/hosts')
  assert.equal(outside.displayPath, '/etc/hosts')

  await assert.rejects(fs.resolve('   '), (error: { code?: string }) => error.code === 'FS_NOT_FOUND')
}

// -- stat / lstat ---------------------------------------------------------

{
  const world = fakeTarget({ '/home/dev/proj/a.txt': { content: 'hello', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  const target = await fs.resolve('a.txt')

  const info = await fs.stat(target)
  assert.equal(info?.type, 'file')
  assert.equal(info?.size, 5)
  assert.equal(String(info?.version), 'v1')

  // A missing path is `undefined`, not an error.
  assert.equal(await fs.stat(await fs.resolve('missing.txt')), undefined)

  // stat follows symlinks and the seam has no symlink branch, so a link reports
  // as `other`; lstat keeps the distinction.
  const linked = fakeTarget({ '/home/dev/proj/link': { content: '', version: 'v2', type: 'symlink' } })
  const linkedFs = new SshFileSystem(linked.ctx)
  const link = await linkedFs.resolve('link')
  assert.equal((await linkedFs.stat(link))?.type, 'other')
  assert.equal((await linkedFs.lstat('link'))?.type, 'symlink')

  // lstat must NOT pay for a realpath round trip: it would follow the very link
  // it exists to report.
  const before = linked.ops().filter((op) => op === 'realpath').length
  await linkedFs.lstat('link')
  assert.equal(linked.ops().filter((op) => op === 'realpath').length, before, 'lstat resolves lexically')
}

// -- listDir: one round trip, stable order, resolved children ------------

{
  const world = fakeTarget({
    '/home/dev/proj/b.ts': { content: 'b', version: 'v-b' },
    '/home/dev/proj/a.ts': { content: 'a', version: 'v-a' },
    '/home/dev/proj/sub/deep.ts': { content: 'd', version: 'v-d' },
    '/home/dev/proj/sub': { content: '', version: 'v-s', type: 'directory' },
  })
  const fs = new SshFileSystem(world.ctx)
  const root = await fs.resolve('.')
  world.calls.length = 0

  const entries = await fs.listDir(root)
  assert.deepEqual(entries.map((entry) => entry.name), ['a.ts', 'b.ts', 'sub'], 'stable name order is contract')
  assert.equal(entries.length, 3, 'only direct children')
  assert.equal(
    world.calls.length,
    1,
    'ONE round trip for the whole directory — the shipped SFTP provider issues one exec per entry',
  )
  // Children arrive already resolved, with metadata.
  assert.equal(fs.processPath(entries[0]!.target), '/home/dev/proj/a.ts')
  assert.equal(String(entries[0]!.version), 'v-a')
  assert.equal(entries[2]!.type, 'directory')
}

// -- reads: caps and decoding -------------------------------------------

{
  const world = fakeTarget({
    '/home/dev/proj/t.txt': { content: 'line one\nline two\n', version: 'v1' },
    '/home/dev/proj/utf.txt': { content: '日本語のテキスト', version: 'v2' },
    '/home/dev/proj/crlf.txt': { content: 'a\r\nb\r\n', version: 'v3' },
  })
  const fs = new SshFileSystem(world.ctx)

  assert.equal(await fs.readText(await fs.resolve('t.txt')), 'line one\nline two\n')
  // Chunks arrive 3 bytes at a time, so this only passes with cross-chunk decoding.
  assert.equal(await fs.readText(await fs.resolve('utf.txt')), '日本語のテキスト')
  // Text read back is LF-normalized regardless of what is stored.
  assert.equal(await fs.readText(await fs.resolve('crlf.txt')), 'a\nb\n')

  const bytes = await fs.readBytes(await fs.resolve('t.txt'), undefined, 1024)
  assert.equal(Buffer.from(bytes).toString('utf8'), 'line one\nline two\n')

  // The cap must reach the helper, so enforcement happens where the bytes are.
  world.calls.length = 0
  await assert.rejects(
    fs.readBytes(await fs.resolve('t.txt'), undefined, 4),
    (error: { code?: string }) => error.code === 'FS_TOO_LARGE',
  )
  const read = world.calls.find((call) => call.op === 'read')!
  assert.equal(read.payload.maxBytes, 4, 'a cap enforced only on the host would still transfer the whole file')

  // A missing file surfaces as FS_NOT_FOUND through the funnel.
  await assert.rejects(
    fs.readText(await fs.resolve('gone.txt')),
    (error: { code?: string }) => error.code === 'FS_NOT_FOUND',
  )
}

// Binary content is refused, and the refusal is coded.
{
  const world = fakeTarget({ '/home/dev/proj/b.bin': { content: 'a\0b', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  await assert.rejects(
    fs.readText(await fs.resolve('b.bin')),
    (error: { code?: string }) => error.code === 'FS_NOT_TEXT',
  )
}

// -- writeText: guards, atomicity, and line-ending fidelity ------------

{
  const world = fakeTarget({ '/home/dev/proj/a.txt': { content: 'old\n', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  const target = await fs.resolve('a.txt')

  const update = await fs.writeText(target, 'new\n')
  assert.equal(update.operation, 'update')
  assert.equal(update.before, 'old\n', 'the baseline is the previous content, LF-normalized')
  assert.equal(update.after, 'new\n')
  assert.equal(world.files['/home/dev/proj/a.txt']!.content, 'new\n')

  const created = await fs.writeText(await fs.resolve('fresh.txt'), 'hi\n')
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null, 'a file that did not exist has no baseline')
}

// createIfAbsent must be enforced by EXCLUSIVE creation, not a stat-then-write.
{
  const world = fakeTarget({ '/home/dev/proj/a.txt': { content: 'x', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  await assert.rejects(
    fs.writeText(await fs.resolve('a.txt'), 'y', { kind: 'createIfAbsent' }),
    (error: { code?: string }) => error.code === 'FS_NOT_OBSERVED',
  )

  world.calls.length = 0
  await fs.writeText(await fs.resolve('new.txt'), 'y', { kind: 'createIfAbsent' })
  const write = world.calls.find((call) => call.op === 'write')!
  assert.equal(write.payload.exclusive, true, 'the race-free guard is O_EXCL/link, not a preceding stat')
}

// replaceIfVersion rejects both a mismatch and a vanished file as STALE.
{
  const world = fakeTarget({ '/home/dev/proj/a.txt': { content: 'x', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  await assert.rejects(
    fs.writeText(await fs.resolve('a.txt'), 'y', { kind: 'replaceIfVersion', version: 'v-other' }),
    (error: { code?: string }) => error.code === 'FS_STALE_VERSION',
  )
  await assert.rejects(
    fs.writeText(await fs.resolve('nope.txt'), 'y', { kind: 'replaceIfVersion', version: 'v1' }),
    (error: { code?: string }) => error.code === 'FS_STALE_VERSION',
  )
  // The guard must be enforced BEFORE anything is published.
  assert.equal(world.files['/home/dev/proj/a.txt']!.content, 'x')
  assert.equal(world.files['/home/dev/proj/nope.txt'], undefined)
}

// A CRLF file keeps its convention: a one-line edit must not rewrite every line.
{
  const world = fakeTarget({ '/home/dev/proj/w.txt': { content: 'a\r\nb\r\n', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  const outcome = await fs.writeText(await fs.resolve('w.txt'), 'a\nc\n')
  assert.equal(world.files['/home/dev/proj/w.txt']!.content, 'a\r\nc\r\n', 'stored bytes keep CRLF')
  assert.equal(outcome.after, 'a\nc\n', 'reported text is LF-normalized')
}

// -- editText: version check first, compare-and-swap on publish -------

{
  const world = fakeTarget({ '/home/dev/proj/e.ts': { content: 'const a = 1\n', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  const target = await fs.resolve('e.ts')

  const outcome = await fs.editText(target, { oldString: 'const a = 1', newString: 'const a = 2' })
  assert.equal(outcome.before, 'const a = 1\n')
  assert.equal(outcome.after, 'const a = 2\n')
  assert.equal(world.files['/home/dev/proj/e.ts']!.content, 'const a = 2\n')

  // The publish must carry the version the edit was computed against.
  const write = world.calls.filter((call) => call.op === 'write').at(-1)!
  assert.equal(write.payload.ifVersion, 'v1', 'without this, a concurrent writer is silently overwritten')
}

// A stale expected version must fail BEFORE matching is attempted, so the
// diagnostic names the real problem.
{
  const world = fakeTarget({ '/home/dev/proj/e.ts': { content: 'value\n', version: 'v2' } })
  const fs = new SshFileSystem(world.ctx)
  world.calls.length = 0
  await assert.rejects(
    fs.editText(
      await fs.resolve('e.ts'),
      { oldString: 'absent-text', newString: 'x' },
      { kind: 'replaceIfVersion', version: 'v1' },
    ),
    (error: { code?: string }) => error.code === 'FS_STALE_VERSION',
  )
  assert.ok(
    !world.ops().includes('write'),
    'a stale edit must not publish, and must not be reported as EDIT_NOT_FOUND',
  )
}

// A target that vanished mid-edit is STALE, not NOT_FOUND: the caller's belief
// is what went stale.
{
  const world = fakeTarget({})
  const fs = new SshFileSystem(world.ctx)
  await assert.rejects(
    fs.editText(await fs.resolve('gone.ts'), { oldString: 'a', newString: 'b' }),
    (error: { code?: string }) => error.code === 'FS_STALE_VERSION',
  )
}

// Ambiguity and absence keep their own codes.
{
  const world = fakeTarget({ '/home/dev/proj/m.ts': { content: 'x\nx\n', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  await assert.rejects(
    fs.editText(await fs.resolve('m.ts'), { oldString: 'x', newString: 'y' }),
    (error: { code?: string }) => error.code === 'FS_AMBIGUOUS_EDIT',
  )
  await assert.rejects(
    fs.editText(await fs.resolve('m.ts'), { oldString: 'zzz', newString: 'y' }),
    (error: { code?: string }) => error.code === 'FS_EDIT_NOT_FOUND',
  )
  assert.equal(world.files['/home/dev/proj/m.ts']!.content, 'x\nx\n', 'a failed edit must not touch the file')
}

// An edit whose replacement contains `$&` must be inserted literally.
{
  const world = fakeTarget({ '/home/dev/proj/s.sh': { content: "sed 's/a/b/'\n", version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  await fs.editText(await fs.resolve('s.sh'), { oldString: 's/a/b/', newString: 's/a/$&x/' })
  assert.equal(world.files['/home/dev/proj/s.sh']!.content, "sed 's/a/$&x/'\n")
}

// -- containment and URLs ------------------------------------------------

{
  const world = fakeTarget({})
  const fs = new SshFileSystem(world.ctx)
  const root = await fs.resolve('.')
  const child = await fs.resolve('src/a.ts')
  const outside = await fs.resolve('/etc/hosts')
  assert.equal(fs.contains(root, child), true)
  assert.equal(fs.contains(root, root), true, 'containment is reflexive')
  assert.equal(fs.contains(root, outside), false)
  assert.equal(fs.contains(child, root), false)
  assert.equal(fs.fileUrl(child), 'file:///home/dev/proj/src/a.ts')
}

// -- abort is checked between round trips -------------------------------

{
  const world = fakeTarget({ '/home/dev/proj/a.txt': { content: 'x', version: 'v1' } })
  const fs = new SshFileSystem(world.ctx)
  const target = await fs.resolve('a.txt')
  for (const call of [
    async () => await fs.stat(target, AbortSignal.abort()),
    async () => await fs.readText(target, AbortSignal.abort()),
    async () => await fs.listDir(target, AbortSignal.abort()),
    async () => await fs.writeText(target, 'y', undefined, AbortSignal.abort()),
    async () => await fs.editText(target, { oldString: 'x', newString: 'y' }, undefined, AbortSignal.abort()),
  ]) {
    await assert.rejects(call(), (error: { code?: string }) => error.code === 'FS_ABORTED')
  }
  assert.equal(world.files['/home/dev/proj/a.txt']!.content, 'x', 'an aborted write must not have happened')
}

console.log('fs-ssh/provider: ok — resolve stability, one-trip listing, capped reads, guarded atomic writes, CAS edits verified')
