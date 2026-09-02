/**
 * Unit tests for argv translation. No connection, no filesystem: the whole
 * surface is pure string work, so every rule is pinned here.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { RemoteArgvError, isPackagedRipgrep, translateArgv, translateHostPath } from '../src/index.ts'

// -- isPackagedRipgrep: only host-only spellings are translated ---------------

// The real shapes @vscode/ripgrep produces on each platform.
assert.equal(isPackagedRipgrep('C:\\proj\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe'), true)
assert.equal(isPackagedRipgrep('/home/u/app/node_modules/@vscode/ripgrep/bin/rg'), true)
assert.equal(isPackagedRipgrep('/opt/dsh/node_modules/.pnpm/@vscode+ripgrep@1.15.9/node_modules/@vscode/ripgrep/bin/rg'), true)
assert.equal(isPackagedRipgrep('C:\\tools\\rg.exe'), true, 'rg.exe cannot run on a POSIX target')
assert.equal(isPackagedRipgrep('C:/tools/rg'), true, 'a Windows-absolute rg is host-only')
assert.equal(isPackagedRipgrep('\\\\server\\share\\rg'), true, 'a UNC path is host-only')

// Legitimate remote programs must pass through untouched.
assert.equal(isPackagedRipgrep('/usr/bin/rg'), false)
assert.equal(isPackagedRipgrep('/home/dev/.cargo/bin/rg'), false)
assert.equal(isPackagedRipgrep('rg'), false, 'a bare name resolves on the target PATH')
assert.equal(isPackagedRipgrep('/usr/bin/git'), false)
assert.equal(isPackagedRipgrep('/bin/sh'), false)
// A remote path that merely contains "rg" is not ripgrep.
assert.equal(isPackagedRipgrep('/usr/bin/rgb-tool'), false)
assert.equal(isPackagedRipgrep('/srv/org/bin/build'), false)

// -- translateHostPath -------------------------------------------------------

const routes = [
  { hostPrefix: 'C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod', remotePrefix: '/home/dev/proj' },
  // A nested placeholder must not be shadowed by its parent.
  { hostPrefix: 'C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod\\vendor', remotePrefix: '/srv/vendor' },
]

assert.equal(translateHostPath('C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod', routes, true), '/home/dev/proj')
assert.equal(
  translateHostPath('C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod\\src\\main.ts', routes, true),
  '/home/dev/proj/src/main.ts',
  'the tail must be re-spelled with POSIX separators',
)
assert.equal(
  translateHostPath('C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod\\vendor\\lib.c', routes, true),
  '/srv/vendor/lib.c',
  'the longest matching prefix must win',
)
// Forward slashes are a valid host spelling on Windows.
assert.equal(
  translateHostPath('C:/Users/me/.dsh/dsh-ssh-routes/prod/src/a.ts', routes, true),
  '/home/dev/proj/src/a.ts',
)
// Case-insensitive hosts must still match.
assert.equal(
  translateHostPath('c:\\users\\ME\\.dsh\\dsh-ssh-routes\\PROD\\x', routes, true),
  '/home/dev/proj/x',
)
assert.equal(
  translateHostPath('c:\\users\\ME\\.dsh\\dsh-ssh-routes\\PROD\\x', routes, false),
  undefined,
  'a case-sensitive host must not match a different spelling',
)
// A sibling directory that merely shares a prefix string must not match.
assert.equal(translateHostPath('C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod-old\\x', routes, true), undefined)
// Unrelated values pass through.
assert.equal(translateHostPath('--type=ts', routes, true), undefined)
assert.equal(translateHostPath('/home/dev/proj/src', routes, true), undefined, 'an already-remote path is not remapped')
// A trailing separator on the mapping must not produce a doubled slash.
assert.equal(
  translateHostPath('C:\\ph\\x', [{ hostPrefix: 'C:\\ph\\', remotePrefix: '/r/' }], true),
  '/r/x',
)

// -- translateArgv -----------------------------------------------------------

// The exact vector tool-fs-search builds, in a remote session.
const search = translateArgv(
  ['C:\\proj\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', '--no-config', '--files', '--glob', '*.ts'],
  { remoteRipgrep: '/usr/bin/rg', caseInsensitiveHostPaths: true },
)
assert.deepEqual(search.argv, ['/usr/bin/rg', '--no-config', '--files', '--glob', '*.ts'])
assert.equal(search.ripgrepReplaced, true)
assert.deepEqual(search.rewrittenIndices, [])

// A search rooted at an explicit path: the root must land in the remote world.
const rooted = translateArgv(
  ['C:\\proj\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', '--no-config', '--files', 'C:\\Users\\me\\.dsh\\dsh-ssh-routes\\prod\\src'],
  { remoteRipgrep: '/usr/bin/rg', routes, caseInsensitiveHostPaths: true },
)
assert.deepEqual(rooted.argv, ['/usr/bin/rg', '--no-config', '--files', '/home/dev/proj/src'])
assert.deepEqual(rooted.rewrittenIndices, [3])

// An ordinary remote command is untouched, including an argument that looks
// path-like but belongs to no placeholder.
const plain = translateArgv(['/bin/sh', '-c', 'git status --short'], { routes, caseInsensitiveHostPaths: true })
assert.deepEqual(plain.argv, ['/bin/sh', '-c', 'git status --short'])
assert.equal(plain.ripgrepReplaced, false)

// A grep pattern is never treated as a path.
const pattern = translateArgv(['/usr/bin/rg', '--json', '-e', 'C:\\\\Windows\\\\System32'], {
  routes,
  caseInsensitiveHostPaths: true,
})
assert.deepEqual(pattern.argv, ['/usr/bin/rg', '--json', '-e', 'C:\\\\Windows\\\\System32'])

// The missing-ripgrep failure must be coded and actionable, not exit 127.
const failure = (() => {
  try {
    translateArgv(['C:\\p\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', '--files'], {})
    return undefined
  } catch (error) {
    return error
  }
})()
assert.ok(failure instanceof RemoteArgvError)
assert.equal(failure.code, 'REMOTE_RIPGREP_MISSING')
assert.match(failure.message, /command -v rg|ripgrepPath|staging/)

// Degenerate inputs are rejected loudly.
assert.throws(() => translateArgv([]), /must not be empty/)
assert.throws(() => translateArgv(['']), /non-empty program name/)

// With no routes configured, nothing but argv[0] can change.
const noRoutes = translateArgv(['/usr/bin/env', 'C:\\Users\\me\\x'], {})
assert.deepEqual(noRoutes.argv, ['/usr/bin/env', 'C:\\Users\\me\\x'])

console.log('remote-argv: ok — 30 assertions over ripgrep detection, prefix mapping, and argv rewriting')
