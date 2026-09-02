/**
 * Composition tests for `cordis.patch.yml`.
 *
 * A patch is a set of claims about ANOTHER package's row ids. Those claims rot
 * silently: upstream renames `fs-sandbox`, our `disabled: true` stops matching
 * anything, the local provider stays mounted, and the harness ends up with files
 * here and commands there — the exact split world the patch exists to prevent.
 *
 * So this suite reads both files as text (no YAML dependency is available in this
 * environment, and the checks are structural) and asserts:
 *
 *  * every row this patch disables or reconfigures EXISTS in the base bundle;
 *  * every seam that must move actually moves;
 *  * the one-world invariant holds — the connection's `cwd` and
 *    `sandbox-policy.workspaceRoot` derive from the same single value;
 *  * the shell/tool twins are switched together, as the base bundle requires;
 *  * the sandbox removal is stated, not silent.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const basePath = 'C:/Users/Administrator/Documents/deepseek-harness/packages/bundle/base/cordis.patch.yml'

const patch = readFileSync(patchPath, 'utf8')
const base = readFileSync(basePath, 'utf8')

/** Row ids declared in a patch document, in order. */
function rowIds(document: string): string[] {
  return [...document.matchAll(/^\s*-?\s*id:\s*([\w-]+)\s*$/gm)].map((match) => match[1] as string)
}

/** Row ids this patch marks `disabled: true`. */
function disabledIds(document: string): string[] {
  const ids: string[] = []
  const lines = document.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^\s*-?\s*id:\s*([\w-]+)\s*$/.exec(lines[index] ?? '')
    if (idMatch === null) continue
    // The row's own following lines, until the next row starts.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? ''
      if (/^\s*-?\s*id:/.test(line) || /^\s*-\s*insert:/.test(line)) break
      if (/^\s*disabled:\s*true\s*$/.test(line)) {
        ids.push(idMatch[1] as string)
        break
      }
    }
  }
  return ids
}

const baseIds = new Set(rowIds(base))
const patchIds = rowIds(patch)
const disabled = new Set(disabledIds(patch))

// -- the base bundle still has the rows this patch talks about --------------

for (const id of ['subprocess', 'fs-sandbox', 'sandbox', 'permission', 'sandbox-policy', 'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh']) {
  assert.ok(
    baseIds.has(id),
    `the base bundle no longer declares a row named "${id}" — this patch's claim about it is stale, `
      + 'and a claim that matches nothing silently leaves the local provider mounted',
  )
}

// The directory chooser the GUI replaces lives in the web-app bundle layer.
{
  const webAppPath = 'C:/Users/Administrator/Documents/deepseek-harness/packages/bundle/web-app/cordis.patch.yml'
  const webApp = readFileSync(webAppPath, 'utf8')
  assert.ok(
    rowIds(webApp).includes('directory-picker'),
    'the web-app bundle no longer declares the "directory-picker" row this patch disables',
  )
  assert.match(
    webApp,
    /name: '@deepseek-ai\/dsh-host-directory-picker-auto'/,
    'the disabled row must still resolve to the -auto chooser package',
  )
}

// -- both seams move, together --------------------------------------------

assert.ok(disabled.has('subprocess'), 'local command execution must come down')
assert.ok(disabled.has('fs-sandbox'), 'the local filesystem must come down')
assert.ok(patch.includes('name: dsh-subprocess-ssh'), 'the remote subprocess provider must be inserted')
assert.ok(patch.includes('name: dsh-fs-ssh'), 'the remote filesystem provider must be inserted')
assert.ok(patch.includes('name: dsh-ssh'), 'the connection owner must be inserted')

// Neither seam may move alone: a half-moved composition reads one machine and
// writes the other.
assert.equal(
  disabled.has('subprocess'),
  disabled.has('fs-sandbox'),
  'the two seams must be switched together or not at all',
)

// -- the one-world invariant ---------------------------------------------

const cwdExpressions = [...patch.matchAll(/^\s*(cwd|workspaceRoot):\s*!!js\s+(.+)$/gm)].map((match) => ({
  key: match[1] as string,
  expression: (match[2] as string).trim(),
}))
assert.ok(cwdExpressions.length >= 2, 'both the connection cwd and the policy workspace root must be declared')
const distinct = new Set(cwdExpressions.map((entry) => entry.expression))
assert.equal(
  distinct.size,
  1,
  `the connection cwd and sandbox-policy.workspaceRoot must derive from ONE value; found ${[...distinct].join(' | ')}`,
)
assert.ok(
  [...distinct][0]?.includes('DSH_REMOTE_CWD'),
  'the shared directory must come from an environment variable, not a literal duplicated in two rows',
)
// It must NOT be the host's cwd, which is what the base bundle uses.
assert.ok(
  !patch.includes('workspaceRoot: !!js process.cwd()'),
  'a host cwd as the workspace root would point the policy at the wrong machine',
)

// -- the shell stack matches the TARGET, not the host -------------------

assert.ok(disabled.has('bash-sandbox'), 'the sandboxed bash executor wraps argv in a host launcher')
assert.ok(disabled.has('pwsh-sandbox'), 'a PowerShell executor cannot drive a Linux target')
assert.ok(disabled.has('tool-pwsh'), 'the model-facing shell tool must match the target')
assert.ok(
  disabled.has('permission'),
  'permission presets bundle a sandbox mode and hard-reject an unconfined executor; '
    + 'with the sandbox rows down the preset service must come down with them',
)
assert.match(
  patch,
  /- id: tool-bash\s*\n\s*disabled: false/,
  'tool-bash is disabled on a Windows host by the base bundle and must be re-enabled explicitly',
)
assert.ok(patch.includes('name: dsh-subprocess-ssh/shell'), 'an unconfined remote shell executor must be provided')

// -- the GUI layer is mounted with its client half -----------------------

assert.ok(patch.includes('name: dsh-ssh-gui'), 'the connection registry and /dsh-ssh RPC channel must mount')
assert.ok(
  !/name: dsh-ssh-gui\/web\b/.test(patch),
  'the GUI row must mount the PACKAGE ROOT — client-modules only scans entries whose name resolves '
    + 'to a package root, so a "dsh-ssh-gui/web" subpath row would never compose the React client',
)
assert.ok(
  patch.includes("name: '@deepseek-ai/dsh-host-directory-picker-browse'"),
  'the disabled -auto chooser must be replaced by its backend half so the directoryPicker seam stays alive',
)
assert.ok(
  disabled.has('directory-picker'),
  'the default chooser surface must come down — it mounts a rival occupant into the directory-flow single slots',
)
{
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../packages/ssh-gui/package.json', import.meta.url)), 'utf8'),
  ) as {
    exports?: Record<string, unknown>
    dsh?: { client?: { inject?: string[]; platform?: string } }
  }
  assert.ok(manifest.exports?.['.'] !== undefined, 'the GUI row mounts the package root, which must be exported')
  assert.ok(manifest.exports?.['./web'] !== undefined, 'the web plugin surface must stay exported for direct consumers')
  assert.ok(
    manifest.exports?.['./client'] !== undefined,
    'the package must export ./client — the client-modules registry reads the built bundle there',
  )
  assert.equal(manifest.dsh?.client?.platform, 'web', 'the client bundle must declare the web platform')
  const injected = manifest.dsh?.client?.inject ?? []
  assert.ok(injected.length >= 5, 'the client needs the connection/renderer/workspace/ui services')
  // Every inject edge must name a real client row of the shipping web-app
  // bundle; a name that resolves to no graph row would stall materialization.
  for (const name of injected) {
    assert.ok(
      /^@deepseek-ai\/dsh-client-(connection|ui-renderer|ui-conversation|ui-sidebar|ui-workspace)$/.test(name),
      `the client inject edge "${name}" must name an existing dsh-client row`,
    )
  }
}

// A subpath the patch names must actually be exported, or the row fails to load.
{
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../packages/subprocess-ssh/package.json', import.meta.url)), 'utf8'),
  ) as { exports?: Record<string, unknown> }
  for (const subpath of [...patch.matchAll(/name:\s*dsh-subprocess-ssh(\/[\w-]+)?/g)].map((match) => match[1] ?? '.')) {
    const key = subpath === '.' ? '.' : `.${subpath}`
    assert.ok(
      manifest.exports?.[key] !== undefined,
      `the patch mounts "dsh-subprocess-ssh${subpath === '.' ? '' : subpath}" but package.json does not export "${key}"`,
    )
  }
}

// -- the sandbox removal is stated, not silent ------------------------

assert.ok(disabled.has('sandbox'), 'the host sandbox provider must come down')
assert.match(
  patch,
  /does NOT constrain anything on the target/,
  'disabling the fence without saying so in the artifact people read would be a silent downgrade',
)
assert.match(patch, /remote account's own permissions/, 'the patch must name what the actual fence is')

// -- glob/grep are deliberately left in place -------------------------

assert.ok(
  !disabled.has('tool-fs-search') && !patch.includes('tool-fs-search'),
  'the search tool needs no patching: argv translation in the subprocess provider is what fixes it',
)

// -- rows are unique ---------------------------------------------------

assert.equal(new Set(patchIds).size, patchIds.length, `duplicate row ids in the patch: ${patchIds.join(', ')}`)

console.log(
  `composition: ok — ${patchIds.length} rows checked against the base bundle, one-world invariant and shell twins verified`,
)
