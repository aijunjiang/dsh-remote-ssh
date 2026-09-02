/**
 * Download the reference repo's source so it can be audited with file tools.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), '.reference')
const repo = 'Hefulalala/dsh-remote-workspace'
const branch = 'main'
const wanted = [
  'docs/architecture.md',
  'cordis.patch.yml',
  'package.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'CHANGELOG.md',
  'SECURITY.md',
  'install.sh',
  'scripts/build.sh',
  'scripts/smoke.mjs',
  'src/index.ts',
  'src/client/index.tsx',
  '.github/workflows/ci.yml',
]

for (const path of wanted) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`)
  if (!res.ok) {
    console.log('MISS', path, res.status)
    continue
  }
  const target = join(out, path)
  mkdirSync(dirname(target), { recursive: true })
  const text = await res.text()
  writeFileSync(target, text)
  console.log('ok  ', path, text.split('\n').length, 'lines')
}
