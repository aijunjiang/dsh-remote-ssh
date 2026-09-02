/**
 * Dump the reference repo's shape so its coverage can be compared against our
 * contract specs: description, tree with sizes, README, and any open issues.
 * Writes artifacts under ../.reference/ for reading with the file tools.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), '.reference')
mkdirSync(out, { recursive: true })

const repo = 'Hefulalala/dsh-remote-workspace'
const headers = { 'user-agent': 'dsh-probe', accept: 'application/vnd.github+json' }

const meta = await (await fetch(`https://api.github.com/repos/${repo}`, { headers })).json()
console.log('description:', meta.description)
console.log('default_branch:', meta.default_branch, '| pushed_at:', meta.pushed_at, '| size KB:', meta.size)

const tree = await (
  await fetch(`https://api.github.com/repos/${repo}/git/trees/${meta.default_branch}?recursive=1`, { headers })
).json()
const files = (tree.tree ?? []).filter((e) => e.type === 'blob')
files.sort((a, b) => a.path.localeCompare(b.path))
const listing = files.map((e) => `${String(e.size).padStart(8)}  ${e.path}`).join('\n')
writeFileSync(join(out, 'tree.txt'), `${files.length} files\n${listing}\n`)
console.log(`tree: ${files.length} blobs, total ${files.reduce((n, e) => n + (e.size ?? 0), 0)} bytes`)

for (const name of ['README.md', 'readme.md', 'README.zh-CN.md']) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/${name}`)
  if (!res.ok) continue
  writeFileSync(join(out, name.replace(/\//g, '_')), await res.text())
  console.log('saved', name)
}

const issues = await (await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=20`, { headers })).json()
if (Array.isArray(issues)) {
  const summary = issues
    .map((i) => `#${i.number} [${i.state}] ${i.title}\n${(i.body ?? '').slice(0, 4000)}`)
    .join('\n\n---\n\n')
  writeFileSync(join(out, 'issues.md'), summary || 'no issues\n')
  console.log('issues:', issues.length)
}
console.log('artifacts in', out)
