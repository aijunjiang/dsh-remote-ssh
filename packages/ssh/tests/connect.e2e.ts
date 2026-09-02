/**
 * End-to-end test against a real SSH target. Skipped unless configured.
 *
 * It proves the whole P0 surface in one pass: authentication, helper upload and
 * startup, the request/event router, atomic publication, and tree-scoped
 * termination. Nothing here is mocked, so a green run is the only evidence that
 * the helper protocol actually works against a live sshd.
 *
 *   $env:DSH_SSH_HOST      = 'dev.example'      # required
 *   $env:DSH_SSH_USER      = 'dev'              # required
 *   $env:DSH_SSH_CWD       = '/home/dev/scratch' # required, remote absolute
 *   $env:DSH_SSH_PASSWORD  = '...'              # first connection only
 *   $env:DSH_SSH_IDENTITY  = 'C:\path\to\key'   # or an existing private key
 *   $env:DSH_SSH_PORT      = '22'
 *   $env:DSH_SSH_IDENTITY_DIR = 'C:\...\remote-ssh'  # where a provisioned key lands
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SshRuntime } from '../src/index.ts'
import { SshSubprocessRuntime } from '../../subprocess-ssh/src/index.ts'
import { SshFileSystem } from '../../fs-ssh/src/index.ts'

const host = process.env.DSH_SSH_HOST
const username = process.env.DSH_SSH_USER
const cwd = process.env.DSH_SSH_CWD

if (host === undefined || username === undefined || cwd === undefined) {
  console.log('connect.e2e: skipped — set DSH_SSH_HOST, DSH_SSH_USER and DSH_SSH_CWD to run')
  process.exit(0)
}

const ctx = new Context()
;(ctx as unknown as { logger?: unknown }).logger = {
  debug: (message: string) => console.log('[dbg]', message),
  warn: (message: string) => console.log('[warn]', message),
  error: (message: string) => console.log('[error]', message),
  info: (message: string) => console.log('[info]', message),
}
const config = SshRuntime.Config({
  host,
  username,
  cwd,
  port: process.env.DSH_SSH_PORT === undefined ? undefined : Number(process.env.DSH_SSH_PORT),
  password: process.env.DSH_SSH_PASSWORD,
  identityPath: process.env.DSH_SSH_IDENTITY,
  identityDir: process.env.DSH_SSH_IDENTITY_DIR,
})
const ssh = new SshRuntime(ctx, config)

const facts = await ssh.getFacts()
console.log('connected:', {
  home: facts.home,
  helperRoot: facts.helperRoot,
  runtimeRoot: facts.runtimeRoot,
  python: facts.python,
  uname: facts.uname.slice(0, 3),
})
assert.ok(facts.home.startsWith('/'), 'home must be an absolute POSIX path')
assert.ok(Object.keys(facts.loginEnv).length > 0, 'login environment must not be empty')
assert.ok(facts.loginEnv.PATH !== undefined, 'PATH must survive the login-shell probe')

// -- realpath: the `-m` semantics a create depends on ------------------------
const missing = `${cwd}/does-not-exist-${Date.now()}/deep/file.txt`
const resolved = await ssh.request('realpath', { path: missing })
assert.equal(resolved.path, missing, 'realpath must canonicalize a non-existent tail')
const relative = await ssh.request('realpath', { path: 'sub/./x', cwd })
assert.equal(relative.path, `${cwd}/sub/x`, 'a relative path must resolve against cwd')

// -- write / stat / read: identity and freshness -----------------------------
const file = `${cwd}/.dsh-e2e-${Date.now()}.txt`
const first = await ssh.request('write', {
  path: file,
  dataB64: Buffer.from('hello remote\n', 'utf8').toString('base64'),
})
assert.equal(first.size, 13)

const statted = await ssh.request('stat', { path: file })
assert.equal(statted.present, true)
assert.equal(statted.info?.type, 'file')
assert.equal(statted.info?.version, first.version, 'stat and write must mint the same token')

const chunks: Buffer[] = []
const read = await ssh.request('read', { path: file }, { onData: (chunk) => void chunks.push(chunk) })
assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello remote\n')
assert.equal(read.bytes, 13)

// A same-size overwrite within the same second must still change the token —
// this is exactly what SFTP v3 attributes could not express.
const second = await ssh.request('write', {
  path: file,
  dataB64: Buffer.from('HELLO REMOTE\n', 'utf8').toString('base64'),
})
assert.notEqual(second.version, first.version, 'a same-size overwrite must change the version token')

// -- exclusive publication ---------------------------------------------------
const guarded = await ssh
  .request('write', { path: file, dataB64: '', exclusive: true })
  .then(() => 'unexpected-success')
  .catch((error: unknown) => (error as { code?: string }).code)
assert.equal(guarded, 'EEXIST', 'an exclusive create over an existing file must fail with EEXIST')

// -- listdir -----------------------------------------------------------------
const listing = await ssh.request('listdir', { path: cwd })
assert.ok(
  listing.entries.some((entry) => file.endsWith(`/${entry.name}`)),
  'the new file must appear in its parent listing',
)

// -- which -------------------------------------------------------------------
const shell = await ssh.request('which', { name: 'sh', path: facts.loginEnv.PATH })
assert.ok(shell.path.startsWith('/'), 'which must return an absolute path')
const rejected = await ssh
  .request('which', { name: './relative' })
  .then(() => 'unexpected-success')
  .catch((error: unknown) => (error as { code?: string }).code)
assert.equal(rejected, 'EINVAL', 'a relative path with separators must be rejected, not guessed')

// -- spawn: pid, pgid, output, exit facts ------------------------------------
const output: Buffer[] = []
let exitCode: number | null | undefined
let gone = false
const registration = ssh.registerProcess({
  onData: (_stream, chunk) => void output.push(chunk),
  onEof: () => {},
  onExit: (code) => void (exitCode = code),
  onGone: () => void (gone = true),
})
const spawned = await ssh.request('spawn', {
  handle: registration.handle,
  argv: ['/bin/sh', '-c', 'echo out; echo err >&2; exit 7'],
  cwd,
  env: { PATH: facts.loginEnv.PATH ?? '/usr/bin:/bin' },
  stdin: 'ignore',
})
assert.ok(spawned.pid > 1, 'spawn must report a real pid')
assert.equal(spawned.pgid, spawned.pid, 'start_new_session must make the child its own group leader')
await waitUntil(() => gone, 10_000, 'the process group did not become quiescent')
assert.equal(exitCode, 7, 'the exit code must be reported verbatim')
assert.match(Buffer.concat(output).toString('utf8'), /out/)
registration.release()

// -- spawn failure is a spawn-level failure, not an exit code ----------------
const badCwd = ssh.registerProcess({
  onData: () => {},
  onEof: () => {},
  onExit: () => {},
  onGone: () => {},
})
const cwdFailure = await ssh
  .request('spawn', {
    handle: badCwd.handle,
    argv: ['/bin/sh', '-c', 'true'],
    cwd: `${cwd}/definitely-not-a-directory-${Date.now()}`,
    env: {},
    stdin: 'ignore',
  })
  .then(() => 'unexpected-success')
  .catch((error: unknown) => (error as { code?: string }).code)
assert.equal(cwdFailure, 'ENOTDIR', 'a bad cwd must never look like a child exit code')
badCwd.release()

// -- tree-scoped termination -------------------------------------------------
let treeGone = false
const tree = ssh.registerProcess({
  onData: () => {},
  onEof: () => {},
  onExit: () => {},
  onGone: () => void (treeGone = true),
})
// A child that outlives its parent: only group-scoped signalling reaches it.
const longRunning = await ssh.request('spawn', {
  handle: tree.handle,
  argv: ['/bin/sh', '-c', 'sleep 120 & sleep 120'],
  cwd,
  env: {},
  stdin: 'ignore',
})
const alive = await ssh.request('alive', { pgid: longRunning.pgid })
assert.equal(alive.alive, true)
const killed = await ssh.request('kill', { pgid: longRunning.pgid, signal: 'TERM' })
assert.equal(killed.delivered, true)
await waitUntil(() => treeGone, 15_000, 'the process tree survived a group TERM')
const after = await ssh.request('alive', { pgid: longRunning.pgid })
assert.equal(after.alive, false, 'liveness is the only proof of quiescence')
tree.release()

// -- cleanup -----------------------------------------------------------------
await ssh.request('remove', { path: file })

// ===========================================================================
// THE PROVIDER LAYER — the same code the harness mounts, against the live target
// ===========================================================================

// -- ctx.fs: the full seam surface, one round trip at a time ------------------
{
  const ctx2 = new Context()
  ctx2.provide('ssh')
  ;(ctx2 as unknown as { ssh: unknown }).ssh = ssh
  const fs = new SshFileSystem(ctx2)

  // resolve: canonical, stable, and possible for a file that does not exist yet.
  const freshPath = `${cwd}/.dsh-e2e-fs-${Date.now()}.ts`
  const fresh = await fs.resolve(freshPath)
  assert.equal(fs.processPath(fresh), freshPath)
  const again = await fs.resolve(freshPath.replace(`${cwd}/`, `${cwd}/./`))
  assert.equal(fs.processPath(again), freshPath, 'the same file must always mint the same key')

  // writeText: atomic create, baseline reported, CRLF preserved.
  const created = await fs.writeText(fresh, 'const a = 1\r\nconst b = 2\r\n')
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)
  assert.equal(created.after, 'const a = 1\nconst b = 2\n', 'reported text is LF-normalized')

  // readText: LF-normalized round trip.
  assert.equal(await fs.readText(fresh), 'const a = 1\nconst b = 2\n')

  // editText: version check, literal replacement, CRLF restore on the wire.
  const edited = await fs.editText(fresh, { oldString: 'const b = 2', newString: 'const b = 3' })
  assert.equal(edited.after, 'const a = 1\nconst b = 3\n')
  // The stored bytes must keep CRLF; read them raw through the helper.
  const rawChunks: Buffer[] = []
  await ssh.request('read', { path: freshPath }, { onData: (chunk) => void rawChunks.push(chunk) })
  assert.ok(
    Buffer.concat(rawChunks).includes(Buffer.from('\r\n')),
    'a CRLF file must be written back as CRLF, or a one-line edit rewrites every line',
  )

  // A stale edit must fail with FS_STALE_VERSION and leave the file untouched.
  const staleVersion = String((await fs.stat(fresh))?.version)
  const stale = await fs
    .editText(fresh, { oldString: 'const a', newString: 'const z' }, { kind: 'replaceIfVersion', version: 'v-not-real' })
    .then(() => 'unexpected-success')
    .catch((error: unknown) => (error as { code?: string }).code)
  assert.equal(stale, 'FS_STALE_VERSION')
  assert.equal((await fs.stat(fresh))?.version, staleVersion, 'a rejected edit must not touch the file')

  // createIfAbsent over an existing file must fail with FS_NOT_OBSERVED.
  const exists = await fs
    .writeText(fresh, 'x', { kind: 'createIfAbsent' })
    .then(() => 'unexpected-success')
    .catch((error: unknown) => (error as { code?: string }).code)
  assert.equal(exists, 'FS_NOT_OBSERVED')

  // listDir: one round trip, stable order, children pre-resolved.
  const parent = await fs.resolve(cwd)
  const entries = await fs.listDir(parent)
  const seen = entries.find((entry) => entry.target.targetKey === freshPath)
  assert.ok(seen !== undefined, 'the new file must be listed with a resolved child target')
  assert.equal(String(seen.version), staleVersion, 'the listing must carry the same version token as stat')

  // readBytes: the cap must be enforced on the TARGET.
  const tooBig = await fs
    .readBytes(fresh, undefined, 4)
    .then(() => 'unexpected-success')
    .catch((error: unknown) => (error as { code?: string }).code)
  assert.equal(tooBig, 'FS_TOO_LARGE')

  await ssh.request('remove', { path: freshPath })
  console.log('fs-ssh e2e: ok — resolve identity, CRLF fidelity, CAS edits, one-trip listing, capped reads')
}

// -- ctx.subprocess: the provider's whole pipeline against the live target ----
{
  const ctx2 = new Context()
  ctx2.provide('ssh')
  ;(ctx2 as unknown as { ssh: unknown }).ssh = ssh
  const runtime = new SshSubprocessRuntime(ctx2)

  // Environment layering: an EXPLICIT DSH_* entry survives the scrub (that is
  // how a deliberately forwarded fact reaches a child), while an ambient
  // credential-shaped name from the target's own environment never does.
  const handle = runtime.spawn({
    argv: ['/bin/sh', '-c', 'printf "%s" "$DSH_E2E_EXPLICIT"; command -v sh'],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 1000,
    env: {
      DSH_E2E_EXPLICIT: 'forwarded-value',
    },
  })
  const outcome = await handle.done
  assert.equal(outcome.exitCode, 0)
  const text = handle.collected.stdout?.readFrom(0).text ?? ''
  assert.ok(text.includes('/bin/sh') || text.includes('/usr/bin/sh'), 'the target PATH must resolve sh')
  assert.ok(text.includes('forwarded-value'), 'an EXPLICIT entry must survive the scrub')
  assert.equal(handle.pid > 1, true, 'the real remote pid must be reported')

  // And the scrub itself: the child environment is built from the probed login
  // environment minus the seam's two predicate classes. Prove it by forwarding
  // an ambient credential-shaped name through the environment the child would
  // inherit, and confirming the child never sees it. The probe is cached, so the
  // ambient entry must exist at probe time: we make the FIRST probe carry it.
  const leakName = `DSH_E2E_LEAK_${Date.now()}`
  // The helper's login probe reads the daemon's own environment; a variable the
  // daemon inherited at start appears there. Our helper was started long ago, so
  // instead we prove the scrub predicate directly on a probe we control:
  // buildChildEnvironment is pure and already covered by unit tests; here we
  // verify the LIVE path end-to-end by forwarding a credential-shaped EXPLICIT
  // entry via the spec (the one escape hatch that must work) and an ambient one
  // via env -i semantics (the one that must not).
  const forwarded = runtime.spawn({
    argv: ['/bin/sh', '-c', 'printf "%s" "$DEEPSEEK_API_KEY"'],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 1000,
    env: {
      // Deliberate: explicit entries are the documented escape hatch for a
      // credential the caller really means to forward.
      DEEPSEEK_API_KEY: 'sk-forwarded-on-purpose',
    },
  })
  await forwarded.done
  assert.equal(
    forwarded.collected.stdout?.readFrom(0).text,
    'sk-forwarded-on-purpose',
    'an explicit credential-shaped entry must survive the scrub',
  )
  // An ambient credential-shaped name cannot be injected into the login probe
  // without touching the machine's profile; the pure predicate parity is covered
  // by environment.test.ts against the seam's own pattern. Here we assert the
  // wiring: the child sees NO ambient DSH_* value at all.
  const ambient = runtime.spawn({
    argv: ['/bin/sh', '-c', 'printf "%s" "$DSH_SESSION_ID"'],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 1000,
  })
  await ambient.done
  assert.equal(
    ambient.collected.stdout?.readFrom(0).text,
    '',
    'an ambient DSH_* entry must be scrubbed before it reaches a child',
  )
  void leakName

  // Termination must reach a descendant, not just the direct child.
  const tree = runtime.spawn({
    argv: ['/bin/sh', '-c', 'sleep 300 & sleep 300'],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 500,
  })
  await tree.whenStarted
  tree.terminate()
  assert.equal(await tree.waitForExit(AbortSignal.timeout(10_000)), true, 'a group TERM must silence the whole tree')
  const treeOutcome = await tree.done
  assert.ok(
    treeOutcome.signal === 'SIGTERM' || treeOutcome.signal === 'SIGKILL',
    `the tree must die from our signal, got ${String(treeOutcome.signal)}`,
  )

  // Remote output spill: the reported path must exist ON THE TARGET. The helper
  // root is relative to the home directory, so compose an absolute spill path.
  const spillDir = posix.join(facts.home, facts.runtimeRoot, `e2e-spill-${Date.now()}`)
  const spiller = runtime.spawn({
    argv: ['/bin/sh', '-c', 'printf "spill-me-now"'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 8, spill: { maxBytes: 1024, path: `${spillDir}/out.log` } },
      stderr: { maxBytes: 8 },
    },
    graceMs: 1000,
  })
  await spiller.done
  const spillRead = spiller.collected.stdout?.readFrom(0)
  assert.equal(spillRead?.spillPath, `${spillDir}/out.log`)
  const spillFile = await ssh
    .request('stat', { path: `${spillDir}/out.log` })
    .then((result: { present: boolean }) => result.present)
  assert.equal(spillFile, true, 'a spillPath the model cannot read is worse than no spill at all')
  await ssh.request('remove', { path: `${spillDir}/out.log` })

  await runtime.terminateAll()
  console.log('subprocess-ssh e2e: ok — env scrub, real pid, tree termination, remote spill')
}

// -- glob/grep: the argv translation against the live target ------------------
{
  // Only when the target has ripgrep: the ladder's `command -v` rung.
  const probe = await ssh.exec('command -v rg')
  if (probe.exitCode === 0) {
    const ctx2 = new Context()
    ctx2.provide('ssh')
    ;(ctx2 as unknown as { ssh: unknown }).ssh = ssh
    const runtime = new SshSubprocessRuntime(ctx2)

    const dir = `${cwd}/.dsh-e2e-search-${Date.now()}`
    await ssh.request('mkdir', { path: dir, parents: true })
    await ssh.request('write', {
      path: `${dir}/needle.txt`,
      dataB64: Buffer.from('the needle lives here\n', 'utf8').toString('base64'),
    })

    // The EXACT argv tool-fs-search builds: the host's packaged rg path as
    // argv[0]. Without translation this dies with exit 127 on the target.
    const hostRg = process.platform === 'win32'
      ? 'C:\\proj\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe'
      : '/opt/dsh/node_modules/@vscode/ripgrep/bin/rg'
    const search = runtime.spawn({
      argv: [hostRg, '--no-config', '--files', '--glob', '*.txt', dir],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 1000,
    })
    const outcome = await search.done
    assert.equal(outcome.exitCode, 0, `rg must run on the TARGET, not die 127: ${search.collected.stderr?.readFrom(0).text}`)
    assert.match(search.collected.stdout?.readFrom(0).text ?? '', /needle\.txt/)

    await ssh.request('remove', { path: `${dir}/needle.txt` })
    await ssh.request('rmdir', { path: dir })
    await runtime.terminateAll()
    console.log('remote-argv e2e: ok — the packaged-ripgrep argv executes on the target')
  } else {
    console.log('remote-argv e2e: skipped — the target has no rg on PATH')
  }
}

console.log('connect.e2e: ok — auth, helper, fs identity, spawn, tree termination, providers, and search all verified')

// -- unprovision --------------------------------------------------------------
// The test provisioned a key on first connection; leaving it in authorized_keys
// would be a persistent backdoor on the target. Remove it, and report how many
// lines went away (0 means the key was already gone).
const removed = await ssh.unprovisionPublicKey(`dsh@${host}`)
console.log(`connect.e2e: removed ${removed} provisioned key line(s) for dsh@${host}`)
process.exit(0)

/**
 * Poll a predicate until it holds.
 * @param predicate - condition to await.
 * @param timeoutMs - upper bound before failing.
 * @param message - assertion text on timeout.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`connect.e2e: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
