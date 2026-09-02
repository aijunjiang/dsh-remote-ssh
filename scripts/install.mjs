#!/usr/bin/env node
/**
 * dsh-remote-ssh installer: make the plugin usable on a DSH profile with ONE
 * command and NO extra launch arguments.
 *
 * What it does:
 *  1. Links the monorepo packages into `<dsh home>/profiles/node_modules`
 *     (the loader resolves row names from there). The packages import each
 *     other by relative path, so they must stay inside this tree — links keep
 *     that true (junction on Windows, symlink elsewhere).
 *  2. Registers the SSH GUI user layer in the profile's own patch file
 *     (`<dsh home>/profiles/<profile>/cordis.patch.yml`). That layer applies
 *     automatically at every boot, so `pnpm dsh web` works with NO --patch.
 *
 * Usage:
 *   node scripts/install.mjs                       # link + register (default)
 *   node scripts/install.mjs --home C:\x\.dsh      # explicit DSH home
 *   node scripts/install.mjs --profile headless    # other profile name (default web)
 *   node scripts/install.mjs --no-patch            # link only, skip patch file
 *   node scripts/install.mjs --remove              # remove rows + unlink packages
 *
 * Idempotent and removable. Only touches files this repo owns: the package
 * links inside the profile tree and the marked patch segment.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

/** Canonical markers around the profile-patch segment this script owns. */
const SEGMENT_START = '# ===== dsh-remote-ssh (managed by scripts/install.mjs) ====='
const SEGMENT_END = '# ===== /dsh-remote-ssh (managed by scripts/install.mjs) ====='

/** The SSH GUI user layer, applied automatically at boot (no --patch needed). */
function profileSegment(repoPath) {
  return [
    SEGMENT_START,
    '# dsh-remote-ssh GUI user layer (connection sidebar, remote browser, agent tools).',
    `# repo: ${repoPath}`,
    '# Docs: https://github.com/aijunjiang/dsh-remote-ssh (see README).',
    '# Remove with: node scripts/install.mjs --remove',
    '',
    '# The web-app default directory chooser would fight the ssh-gui flow for the',
    '# directory-flow slots; its browse backend keeps ctx.directoryPicker alive.',
    '- id: directory-picker',
    "  name: '@deepseek-ai/dsh-host-directory-picker-auto'",
    '  disabled: true',
    '',
    '- insert:',
    "    - id: directory-picker-browse",
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '      config:',
    '        maxEntries: 1000',
    "    - id: ssh-web-channel",
    '      name: dsh-ssh-gui',
    '      config:',
    '        maxEntries: 1000',
    SEGMENT_END,
    '',
  ].join('\n')
}

function parseArgs(argv) {
  let home
  let profile = 'web'
  let remove = false
  let noPatch = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--home needs a path')
      home = resolve(value)
      i += 1
    } else if (arg === '--profile') {
      const value = argv[i + 1]
      if (value === undefined || value === '') throw new Error('--profile needs a name')
      profile = value
      i += 1
    } else if (arg === '--remove') {
      remove = true
    } else if (arg === '--no-patch') {
      noPatch = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return { target: join(dshHome, 'profiles', 'node_modules'), patchFile: join(dshHome, 'profiles', profile, 'cordis.patch.yml'), remove, noPatch }
}

function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

function linkTarget(linkPath) {
  try {
    return realpathSync(linkPath)
  } catch {
    return undefined
  }
}

function isInsideRepo(path) {
  if (path === undefined) return false
  const rel = relative(repoRootReal, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Replace the owned segment in a patch file (creates the file when absent). */
function upsertSegment(file, repoPath) {
  const segment = profileSegment(repoPath)
  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    existing = ''
  }
  const startAt = existing.indexOf(SEGMENT_START)
  const endAt = existing.indexOf(SEGMENT_END)
  if (startAt >= 0 && endAt > startAt) {
    const next = existing.slice(endAt + SEGMENT_END.length)
    const prefix = existing.slice(0, startAt).replace(/\s+$/u, '')
    const rewritten = `${prefix}\n\n${segment}${next.replace(/^\r?\n/u, '')}`
    writeFileSync(file, rewritten, 'utf8')
    console.log(`[patch ] ${file}: segment updated`)
    return
  }
  const tail = existing.replace(/\s+$/u, '')
  writeFileSync(file, `${tail.length > 0 ? `${tail}\n\n` : ''}${segment}`, 'utf8')
  console.log(`[patch ] ${file}: GUI layer registered (applies on next boot; no --patch needed)`)
}

/** Remove the owned segment from a patch file. */
function removeSegment(file) {
  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    existing = ''
  }
  const startAt = existing.indexOf(SEGMENT_START)
  const endAt = existing.indexOf(SEGMENT_END)
  if (startAt < 0 || endAt <= startAt) {
    console.log(`[skip ] patch: ${file} has no dsh-remote-ssh segment`)
    return
  }
  const next = existing.slice(endAt + SEGMENT_END.length)
  const prefix = existing.slice(0, startAt).replace(/\s+$/u, '')
  writeFileSync(file, `${prefix}${next.replace(/^\s*\r?\n/u, '')}`, 'utf8')
  console.log(`[patch ] ${file}: segment removed`)
}

const { target, patchFile, remove, noPatch } = parseArgs(process.argv.slice(2))
mkdirSync(target, { recursive: true })

if (remove) {
  if (!noPatch) removeSegment(patchFile)
} else if (!noPatch) {
  upsertSegment(patchFile, repoRoot)
}

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

console.log(remove
  ? '\ndone. dsh-remote-ssh removed from the profile; restart dsh to unload it.'
  : '\ndone. Restart dsh (same command, no extra args) and the SSH GUI layer is live.')
