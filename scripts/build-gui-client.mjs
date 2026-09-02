/**
 * Build dsh-ssh-gui's client bundle with the harness's own toolchain.
 *
 * The shipped package lives OUT of the harness workspace, but the client bundle
 * must be produced by the harness's tsdown client pipeline (same banner/footer,
 * same module-table externals, same CSS-modules handling) so the
 * client-modules registry can serve it. This script:
 *
 *   1. hosts a copy of the package at <checkout>/packages/remote/ssh-gui
 *      (inside the harness workspace, where tsdown + lightningcss + the
 *      platform externals list resolve);
 *   2. writes the client-only tsdown config next to it;
 *   3. runs the harness tsdown binary against it;
 *   4. copies lib/client.js(+map) back into the package;
 *   5. removes the temporary host again.
 *
 * The one thing it cannot do is fix the client source — edit
 * packages/ssh-gui/src/client/* and re-run. No remote target, no web boot
 * needed. Run: node scripts/build-gui-client.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const checkout = resolve(process.env.DSH_HARNESS_CHECKOUT ?? 'C:/Users/Administrator/Documents/deepseek-harness')
const packageDir = join(root, 'packages', 'ssh-gui')
const hostDir = join(checkout, 'packages', 'remote', 'ssh-gui')
const tsdownCli = join(checkout, 'node_modules', 'tsdown', 'dist', 'run.mjs')

// The bundle's module id: 'dsh-ssh-gui' for the dev package, or
// 'dsh-remote-ssh' for the official root package (set DSH_GUI_BUNDLE_ID).
const bundleId = process.env.DSH_GUI_BUNDLE_ID ?? 'dsh-ssh-gui'

if (!existsSync(tsdownCli)) {
  console.error(`tsdown not found at ${tsdownCli} — point DSH_HARNESS_CHECKOUT at the harness checkout`)
  process.exit(1)
}

// -- 1. host the package inside the harness workspace ----------------------

rmSync(hostDir, { recursive: true, force: true })
mkdirSync(join(hostDir, 'src'), { recursive: true })
cpSync(join(packageDir, 'src', 'client'), join(hostDir, 'src', 'client'), { recursive: true })
copyFileSync(join(packageDir, 'package.json'), join(hostDir, 'package.json'))

// -- 2. the client-only tsdown config --------------------------------------

writeFileSync(join(hostDir, 'tsdown.config.ts'), `/**
 * TEMPORARY build host config (created by dsh-remote-ssh/scripts/build-gui-client.mjs).
 * Mirrors packages/client/tsdown.client.ts's clientConfig for dsh-ssh-gui.
 */
import { readFile } from 'node:fs/promises'
import { basename, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../client/web/src/platform.ts'

const id = ${JSON.stringify(bundleId)}
const externals = new Set([...PLATFORM_MODULES, ...PRELOADED_CLIENT_EXTERNALS])
const CSS_VIRTUAL_PREFIX = '\\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(fileId: string, css: string, classMap?: Readonly<Record<string, string>>): string {
  const source = [
    \`const css = \${JSON.stringify(css)};\`,
    \`const tagId = \${JSON.stringify(\`\${id}/\${basename(fileId)}\`)};\`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    \`  tag.dataset.plugin = \${JSON.stringify(id)};\`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : \`export default \${JSON.stringify(classMap)};\`)
  return source.join('\\n')
}

export default defineConfig({
  name: \`\${id}/client\`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => externals.has(specifier),
    alwaysBundle: (specifier: string) => !externals.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(importer, '..', source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: \`window.__ModuleLoader__.load({ id: \${JSON.stringify(id)}, factory: (require) => {\`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
`)

// -- 3. build ---------------------------------------------------------------

try {
  execFileSync(process.execPath, [tsdownCli], {
    cwd: hostDir,
    stdio: 'inherit',
  })
} catch (error) {
  rmSync(hostDir, { recursive: true, force: true })
  console.error('tsdown failed — see the build output above')
  process.exit(1)
}

// -- 4. copy the artifacts back ---------------------------------------------

const libDir = join(packageDir, 'lib')
mkdirSync(libDir, { recursive: true })
const copyOut = (file) => {
  const built = join(hostDir, 'lib', file)
  if (!existsSync(built)) {
    rmSync(hostDir, { recursive: true, force: true })
    console.error(`expected artifact missing: ${built}`)
    process.exit(1)
  }
  if (bundleId === 'dsh-ssh-gui') {
    // Dev-tree package: keep packages/ssh-gui/lib in sync with its own id.
    copyFileSync(built, join(libDir, file))
  } else {
    // Official root package ships its own bundle id at <repo>/lib; never
    // overwrite the dev package's lib with a mismatched id.
    mkdirSync(join(root, 'lib'), { recursive: true })
    copyFileSync(built, join(root, 'lib', file))
  }
}
for (const file of ['client.js', 'client.js.map']) copyOut(file)

// -- 5. clean up ------------------------------------------------------------

rmSync(hostDir, { recursive: true, force: true })

const size = (file) =>
  `${(readFileSync(join(libDir, file)).byteLength / 1024).toFixed(1)} kB`

console.log(`dsh-ssh-gui client bundle rebuilt: lib/client.js (${size('client.js')}), lib/client.js.map (${size('client.js.map')})`)
