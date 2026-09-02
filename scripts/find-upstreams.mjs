/**
 * Locate the upstream sources behind the vendored built packages, so the
 * integration can target real source instead of patched build output.
 */
const headers = { 'user-agent': 'dsh-probe', accept: 'application/vnd.github+json' }

async function tryRepo(slug) {
  const res = await fetch(`https://api.github.com/repos/${slug}`, { headers })
  if (!res.ok) return console.log(`repo ${slug}: HTTP ${res.status}`)
  const meta = await res.json()
  console.log(
    `repo ${slug}: ${meta.default_branch} | pushed ${meta.pushed_at} | ${meta.size}KB | stars ${meta.stargazers_count}\n  ${meta.description ?? ''}`,
  )
  const tree = await (
    await fetch(`https://api.github.com/repos/${slug}/git/trees/${meta.default_branch}?recursive=1`, { headers })
  ).json()
  const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob')
  const src = blobs.filter((e) => /^(src|packages)\//.test(e.path))
  console.log(`  blobs ${blobs.length}, under src/ or packages/: ${src.length}`)
  for (const entry of src.slice(0, 40)) console.log(`    ${String(entry.size).padStart(7)}  ${entry.path}`)
}

for (const slug of [
  'UynajGI/dsh-ssh',
  'chenw2759-wq/dsh-IDE',
  'flymysql/dsh-remote',
  'UynajGI/dsh-easyssh',
]) {
  await tryRepo(slug)
}

for (const query of ['dsh-easyssh', 'dsh easyssh in:name', 'topic:deepseek-harness ssh']) {
  const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`, {
    headers,
  })
  const body = await res.json()
  console.log(`\nsearch "${query}": ${body.total_count ?? body.message}`)
  for (const item of body.items ?? []) console.log(`  ${item.full_name}  ★${item.stargazers_count}  ${item.description ?? ''}`)
}

for (const pkg of ['dsh-easyssh', '@deepseek-ai/dsh-ssh', 'dsh-remote']) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`)
  if (!res.ok) {
    console.log(`\nnpm ${pkg}: HTTP ${res.status}`)
    continue
  }
  const body = await res.json()
  const latest = body['dist-tags']?.latest
  console.log(`\nnpm ${pkg}: latest ${latest} | repo ${JSON.stringify(body.repository ?? null)}`)
}
