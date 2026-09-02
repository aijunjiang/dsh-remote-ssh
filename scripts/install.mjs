#!/usr/bin/env node
/**
 * dsh-remote-ssh installer: link the plugin packages into a DSH profile's
 * loader tree so a `--patch` boot can resolve them by name.
 *
 * The packages form a MONOREPO — subprocess-ssh/fs-ssh/ssh-gui import each
 * other by relative path (../../ssh/src/...), so they must stay inside this
 * tree. This script creates directory junctions (Windows) or symlinks (POSIX)
 * from `<dsh home>/profiles/node_modules/<pkg>` to `./packages/<pkg>`; the
 * loader resolves names from the profile tree and the relative imports keep
 * resolving inside the repository.
 *
 * Usage (from anywhere; run with node):
 *   node scripts/install.mjs                  # link into ~/.dsh (or $DSH_HOME)
 *   node scripts/install.mjs --home C:\x\.dsh  # explicit DSH home
 *   node scripts/install.mjs --remove         # unlink the packages again
 *
 * Idempotent: re-running reports already-linked packages and only repairs
 * stale or wrong-target links. Never deletes anything outside this repo's
 * package directories.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRootReal = realpathSync(repoRoot)

/** package directory name → loader package name. */
const PACKAGES = {
  'ssh': 'dsh-ssh',
  'fs-ssh': 'dsh-fs-ssh',
  'subprocess-ssh': 'dsh-subprocess-ssh',
  'ssh-gui': 'dsh-ssh-gui',
}

function parseArgs(argv) {
  let home
  let remove = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--home needs a path')
      home = resolve(value)
      i += 1
    } else if (arg === '--remove') {
      remove = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return { target: join(dshHome, 'profiles', 'node_modules'), remove }
}

function linkType() {
  // Windows directory junctions need no elevation; POSIX uses a directory
  // symlink with the same loader behaviour.
  return process.platform === 'win32' ? 'junction' : 'dir'
}

function linkTarget(linkPath) {
  try {
    return realpathSync(linkPath)
  } catch {
    return undefined
  }
}

/** Whether a link target lives inside this repository (safe to remove). */
function isInsideRepo(path) {
  if (path === undefined) return false
  const rel = relative(repoRootReal, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const { target, remove } = parseArgs(process.argv.slice(2))
mkdirSync(target, { recursive: true })

const missing = []
for (const [dir, name] of Object.entries(PACKAGES)) {
  const source = resolve(repoRoot, 'packages', dir)
  const linkPath = join(target, name)
  if (!existsSync(source)) {
    missing.push(`${name} <- packages/${dir} (missing source)`)
    continue
  }
  const realSource = realpathSync(source)
  const existing = existsSync(linkPath)
  const currentTarget = existing ? linkTarget(linkPath) : undefined

  if (remove) {
    if (!existing) {
      console.log(`[skip ] ${name}: not linked`)
      continue
    }
    if (!isInsideRepo(currentTarget)) {
      console.log(`[warn ] ${name}: ${linkPath} points at ${currentTarget ?? '(unreadable)'} (not this repo) — leaving it`)
      continue
    }
    rmSync(linkPath, { recursive: true, force: true })
    console.log(`[removed] ${name} -> ${linkPath}`)
    continue
  }

  if (existing && currentTarget !== undefined && currentTarget === realSource) {
    console.log(`[ok   ] ${name}: already linked to packages/${dir}`)
    continue
  }
  if (existing) {
    console.log(`[repair] ${name}: ${linkPath} pointed at ${currentTarget ?? '(unreadable)'} — relinking to packages/${dir}`)
    rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(realSource, linkPath, linkType())
  console.log(`[linked] ${name} -> packages/${dir} (${linkPath})`)
}

if (missing.length > 0) {
  console.error(`\nerror: source packages missing in this checkout:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

console.log(`\ndone. loader tree: ${target}`)
console.log('start a GUI-with-remote session, e.g.:')
console.log('  pnpm dsh web --patch <this repo>/cordis.patch.yml')
