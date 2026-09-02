/**
 * Client-bundle smoke for dsh-ssh-gui: the artifact the client-modules
 * registry serves must be (a) a `window.__ModuleLoader__.load({id, factory})`
 * registration for exactly `dsh-ssh-gui`, (b) resolvable to the plugin
 * exports (`apply`, `inject`) through the module-table contract, with the only
 * externals being the platform module-table rows, and (c) rebuildable — a
 * missing or stale bundle fails here before it can fail a browser session.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundlePath = join(root, 'packages', 'ssh-gui', 'lib', 'client.js')
assert.ok(existsSync(bundlePath), 'run the client build first (scripts/build-gui-client.mjs)')

const bundle = readFileSync(bundlePath, 'utf8')

// -- (a) the registration shape -------------------------------------------

assert.match(
  bundle,
  /^window\.__ModuleLoader__\.load\(\{\s*\n\s*id: "dsh-ssh-gui",\s*\n\s*factory: \(require\) => \{\s*\n/,
  'the bundle must open with the module-table registration for dsh-ssh-gui',
)
assert.match(
  bundle,
  /return module\.exports;\s*\}\s*\}\);/,
  'the factory must return the plugin exports',
)
assert.ok(bundle.includes('//# sourceMappingURL=client.js.map'), 'the bundle must carry its source-map trailer')

// -- (b) externals are exactly the module-table rows ----------------------

const requires = new Set<string>()
for (const match of bundle.matchAll(/require\("([^"]+)"\)/g)) requires.add(match[1])
assert.deepEqual(
  [...requires].sort(),
  ['react', 'react/jsx-runtime'],
  'the only runtime externals may be the platform module-table rows this bundle requests',
)

// -- (c) the factory materializes to the plugin exports -------------------

const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }> = []
const windowStub = {
  __ModuleLoader__: {
    load(registration: { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }) {
      registrations.push(registration)
    },
  },
}
// The module table answers react rows with the real browser libraries; the
// factory must not touch anything else. Anchor on the dsh profile install
// (the same node_modules a booted web instance resolves), overridable.
const profileModules = process.env.DSH_PROFILE_NODE_MODULES
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules')
const moduleRequire = createRequire(join(profileModules, 'react', 'package.json'))
const sandboxRequire = (specifier: string): unknown => {
  // The module table answers react rows with the real browser libraries; the
  // factory must not touch anything else.
  if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom' || specifier === 'react-dom/client') {
    return moduleRequire(specifier)
  }
  throw new Error(`the factory requested an undeclared module-table row: ${specifier}`)
}

new Function('window', 'document', bundle)(windowStub, undefined)

assert.equal(registrations.length, 1, 'exactly one registration per bundle')
const [registration] = registrations
assert.equal(registration?.id, 'dsh-ssh-gui')

const exports_ = registration?.factory(sandboxRequire) ?? {}
assert.equal(typeof exports_.apply, 'function', 'the client plugin must export apply')
assert.deepEqual(exports_.inject, ['slots', 'uiWorkspace'], 'the client plugin must inject the slot registry and the workspace browser service')

// -- the source map exists and is a valid v3 object -----------------------

const map = JSON.parse(readFileSync(`${bundlePath}.map`, 'utf8')) as { version?: number; mappings?: string; sources?: unknown }
assert.equal(map.version, 3)
assert.equal(typeof map.mappings, 'string')
assert.ok(Array.isArray(map.sources))

console.log('client-bundle smoke: ok — registration, externals, materialization, and map all verified')
