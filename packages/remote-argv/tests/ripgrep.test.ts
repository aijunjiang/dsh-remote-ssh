/**
 * Unit tests for the remote-ripgrep ladder, driven by a scripted `exec` fake so
 * every rung and every failure mode is exercised without a connection.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { resolveRemoteRipgrep, ripgrepAssetTriple } from '../src/ripgrep.ts'

/** Build an exec fake from a command → outcome table, recording the calls. */
function fakeExec(table: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>) {
  const calls: string[] = []
  const exec = async (command: string) => {
    calls.push(command)
    const hit = table[command]
    // An unlisted command behaves like "not found", the realistic default.
    return {
      exitCode: hit?.exitCode ?? 127,
      stdout: hit?.stdout ?? '',
      stderr: hit?.stderr ?? '',
    }
  }
  return { exec, calls }
}

const VERSION = 'ripgrep 14.1.0 (rev abc1234)\n\nfeatures:+pcre2\n'

// -- rung 1: operator-configured path ---------------------------------------

{
  const { exec, calls } = fakeExec({ "'/opt/rg/rg' --version": { exitCode: 0, stdout: VERSION } })
  const resolved = await resolveRemoteRipgrep({ exec, configuredPath: '/opt/rg/rg' })
  assert.equal(resolved?.path, '/opt/rg/rg')
  assert.equal(resolved?.source, 'configured')
  assert.equal(resolved?.version, 'ripgrep 14.1.0 (rev abc1234)')
  assert.deepEqual(calls, ["'/opt/rg/rg' --version"], 'a configured path must short-circuit the ladder')
}

// A configured path that does not run is a hard error: falling through would
// hide the very misconfiguration the operator must see.
await assert.rejects(
  resolveRemoteRipgrep({ exec: fakeExec({}).exec, configuredPath: '/opt/rg/rg' }),
  /did not run as ripgrep/,
)

// A relative configured path is rejected before any remote work happens.
await assert.rejects(
  resolveRemoteRipgrep({ exec: fakeExec({}).exec, configuredPath: 'rg' }),
  /must be an absolute remote path/,
)

// Something executable that is not ripgrep must be refused.
{
  const { exec } = fakeExec({ "'/usr/bin/rg' --version": { exitCode: 0, stdout: 'GNU grep 3.7\n' } })
  await assert.rejects(resolveRemoteRipgrep({ exec, configuredPath: '/usr/bin/rg' }), /did not run as ripgrep/)
}

// -- rung 2: the target's PATH ----------------------------------------------

{
  const { exec, calls } = fakeExec({
    'command -v rg': { exitCode: 0, stdout: '/usr/local/bin/rg\n' },
    "'/usr/local/bin/rg' --version": { exitCode: 0, stdout: VERSION },
  })
  const resolved = await resolveRemoteRipgrep({ exec, stagedPath: '/run/bin/rg' })
  assert.equal(resolved?.path, '/usr/local/bin/rg')
  assert.equal(resolved?.source, 'path')
  assert.ok(!calls.includes("'/run/bin/rg' --version"), 'a PATH hit must not probe the staging location')
}

// A shell function or alias reported by `command -v` is not a path.
{
  const { exec } = fakeExec({ 'command -v rg': { exitCode: 0, stdout: 'rg () { ... }\n' } })
  assert.equal(await resolveRemoteRipgrep({ exec }), undefined)
}

// -- rung 3: an already-staged binary ---------------------------------------

{
  const { exec } = fakeExec({
    'command -v rg': { exitCode: 1 },
    "'/home/dev/.dsh-remote/run/bin/rg' --version": { exitCode: 0, stdout: VERSION },
  })
  const resolved = await resolveRemoteRipgrep({ exec, stagedPath: '/home/dev/.dsh-remote/run/bin/rg' })
  assert.equal(resolved?.source, 'staged')
}

// -- rung 4: staging now ----------------------------------------------------

{
  let staged = false
  const { exec } = fakeExec({
    'command -v rg': { exitCode: 1 },
    "'/run/bin/rg' --version": { exitCode: 0, stdout: VERSION },
  })
  const resolved = await resolveRemoteRipgrep({
    exec,
    stage: async () => {
      staged = true
      return '/run/bin/rg'
    },
  })
  assert.equal(staged, true)
  assert.equal(resolved?.source, 'staged-now')
}

// A staged binary of the wrong architecture must fail loudly, naming the cause.
{
  const { exec } = fakeExec({ 'command -v rg': { exitCode: 1 } })
  await assert.rejects(
    resolveRemoteRipgrep({ exec, stage: async () => '/run/bin/rg' }),
    /architecture mismatch/,
  )
}

// -- no rung applies --------------------------------------------------------

assert.equal(await resolveRemoteRipgrep({ exec: fakeExec({ 'command -v rg': { exitCode: 1 } }).exec }), undefined)

// -- asset selection --------------------------------------------------------

assert.equal(ripgrepAssetTriple('x86_64', 'gnu'), 'x86_64-unknown-linux-musl')
assert.equal(ripgrepAssetTriple('amd64', 'musl'), 'x86_64-unknown-linux-musl')
assert.equal(ripgrepAssetTriple('aarch64', 'gnu'), 'aarch64-unknown-linux-gnu')
assert.equal(ripgrepAssetTriple('arm64', 'gnu'), 'aarch64-unknown-linux-gnu')
// No musl aarch64 build exists upstream; guessing would produce a dead binary.
assert.equal(ripgrepAssetTriple('aarch64', 'musl'), undefined)
assert.equal(ripgrepAssetTriple('riscv64', 'gnu'), undefined)
assert.equal(ripgrepAssetTriple('  X86_64 ', 'gnu'), 'x86_64-unknown-linux-musl')

console.log('remote-argv/ripgrep: ok — 4 ladder rungs, 5 failure modes, and asset selection verified')
