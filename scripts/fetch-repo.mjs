/**
 * Dump a second reference repo for comparison. Same shape as fetch-reference:
 * meta, recursive tree with sizes, README, issues; then every source file.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = process.argv[2]
const slug = repo.replace('/', '__')
const out = join(dirname(dirname(fileURLToPath(import.meta.url))), '.reference', slug)
mkdirSync(out, { recursive: true })
const headers = { 'user-agent': 'dsh-probe', accept: 'application/vnd.github+json' }

const meta = await (await fetch(`https://api.github.com/repos/${repo}`, { headers })).json()
if (meta.message) {
  console.log('API says:', meta.message)
  process.exit(1)
}
console.log('description:', meta.description)
console.log('branch:', meta.default_branch, '| pushed_at:', meta.pushed_at, '| KB:', meta.size, '| stars:', meta.stargazers_count)

const tree = await (
  await fetch(`https://api.github.com/repos/${repo}/git/trees/${meta.default_branch}?recursive=1`, { headers })
).json()
const files = (tree.tree ?? []).filter((e) => e.type === 'blob').sort((a, b) => a.path.localeCompare(b.path))
writeFileSync(
  join(out, 'tree.txt'),
  `${files.length} files, ${files.reduce((n, e) => n + (e.size ?? 0), 0)} bytes\n` +
    files.map((e) => `${String(e.size).padStart(8)}  ${e.path}`).join('\n') +
    '\n',
)
console.log(`tree: ${files.length} blobs, ${files.reduce((n, e) => n + (e.size ?? 0), 0)} bytes`)

// Fetch every text-ish file that is small enough to be worth reading locally.
const skip = /\.(png|jpg|jpeg|gif|webp|ico|svg|lock|woff2?|ttf|zip|tgz)$/i
for (const entry of files) {
  if (skip.test(entry.path) || (entry.size ?? 0) > 400_000) {
    console.log('skip', entry.path)
    continue
  }
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/${entry.path}`)
  if (!res.ok) {
    console.log('MISS', entry.path, res.status)
    continue
  }
  const target = join(out, entry.path)
  mkdirSync(dirname(target), { recursive: true })
  const text = await res.text()
  writeFileSync(target, text)
  console.log('ok  ', String(text.split('\n').length).padStart(5), 'lines ', entry.path)
}
console.log('artifacts in', out)
