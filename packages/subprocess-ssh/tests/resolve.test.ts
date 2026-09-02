/**
 * Executable-resolution tests, driven by a scripted exec fake.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { resolveRemoteExecutable, shellQuote } from '../src/resolve.ts'

function fakeExec(table: Record<string, { exitCode?: number; stdout?: string }>) {
  const calls: string[] = []
  const exec = async (command: string) => {
    calls.push(command)
    const hit = table[command]
    return { exitCode: hit?.exitCode ?? 127, stdout: hit?.stdout ?? '', stderr: '' }
  }
  return { exec, calls }
}

// -- quoting is inescapable ------------------------------------------------

assert.equal(shellQuote('/usr/bin/git'), "'/usr/bin/git'")
assert.equal(shellQuote("it's"), `'it'"'"'s'`)
// A quote-and-semicolon injection attempt must stay one literal argument.
assert.equal(shellQuote("'; rm -rf /; '"), `''"'"'; rm -rf /; '"'"''`)

// -- absolute paths -------------------------------------------------------

{
  const { exec, calls } = fakeExec({ "test -f '/usr/bin/git' && test -x '/usr/bin/git'": { exitCode: 0 } })
  assert.equal(await resolveRemoteExecutable(exec, '/usr/bin/git'), '/usr/bin/git')
  assert.equal(calls.length, 1, 'an absolute path needs one check, not a PATH search')
}

{
  // A directory, or a file without the execute bit, is not an executable.
  const { exec } = fakeExec({})
  await assert.rejects(resolveRemoteExecutable(exec, '/usr/bin'), /is not an executable file on the target/)
}

// -- relative paths are refused, not guessed -----------------------------

for (const relative of ['./build.sh', '../tool', 'bin/rg', 'a/b/c']) {
  await assert.rejects(
    resolveRemoteExecutable(fakeExec({}).exec, relative),
    /is a relative path/,
    `${relative} must be refused`,
  )
}

// -- bare names use the child's own PATH ---------------------------------

{
  const { exec, calls } = fakeExec({ "command -v -- 'git'": { exitCode: 0, stdout: '/usr/bin/git\n' } })
  assert.equal(await resolveRemoteExecutable(exec, 'git'), '/usr/bin/git')
  assert.equal(calls[0], "command -v -- 'git'")
}

{
  // The spec's PATH must be the one searched, or resolution and execution can
  // disagree about which binary runs.
  const { exec, calls } = fakeExec({
    "PATH='/opt/bin:/usr/bin' command -v -- 'node'": { exitCode: 0, stdout: '/opt/bin/node\n' },
  })
  assert.equal(await resolveRemoteExecutable(exec, 'node', { path: '/opt/bin:/usr/bin' }), '/opt/bin/node')
  assert.match(calls[0]!, /^PATH='\/opt\/bin:\/usr\/bin' command -v/)
}

{
  const { exec } = fakeExec({ "command -v -- 'nope'": { exitCode: 1 } })
  await assert.rejects(resolveRemoteExecutable(exec, 'nope'), /was not found on the target's PATH/)
}

// A builtin, alias, or function is not something execvp can run.
{
  const { exec } = fakeExec({ "command -v -- 'cd'": { exitCode: 0, stdout: 'cd\n' } })
  await assert.rejects(resolveRemoteExecutable(exec, 'cd'), /not an executable path/)
}

{
  const { exec } = fakeExec({ "command -v -- 'll'": { exitCode: 0, stdout: "ll () {\n  ls -l\n}\n" } })
  await assert.rejects(resolveRemoteExecutable(exec, 'll'), /resolved ambiguously|not an executable path/)
}

// -- degenerate input and cancellation ----------------------------------

await assert.rejects(resolveRemoteExecutable(fakeExec({}).exec, ''), /must be non-empty/)

{
  const { exec, calls } = fakeExec({})
  await assert.rejects(
    resolveRemoteExecutable(exec, 'git', { signal: AbortSignal.abort() }),
    (error: unknown) => error instanceof Error,
  )
  assert.equal(calls.length, 0, 'an aborted resolution must not touch the connection')
}

console.log('subprocess-ssh/resolve: ok — absolute checks, relative refusal, PATH lookup, builtin rejection verified')
