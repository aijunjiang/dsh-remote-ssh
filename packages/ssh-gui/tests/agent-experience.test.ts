/**
 * Unit tests for the agent-facing surface of dsh-ssh-gui (P0-1 runtime-context
 * routing identity + degraded warnings, P1-5 DSH_SSH_* environment, P0-2
 * ssh_exec and P1-4 ssh_route_status tool wiring).
 *
 * No SSH connection is made: every execution path tested either refuses
 * before touching the network or runs with stub services on a real cordis
 * Context.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  installAgentExperience,
  remoteWorldOf,
  ROUTE_CONTEXT_NAME,
  SSH_EXEC_TOOL,
  SSH_ROUTE_STATUS_TOOL,
  USAGE_CONTEXT_NAME,
} from '../src/agent-experience.ts'
import { sshRoutePlaceholder } from '../src/transport.ts'
import {
  degradedRouteText,
  parseRoutedCwd,
  routeEnvironment,
  routeFactsFor,
  routeIdentityText,
  type RouteFacts,
} from '../src/route-facts.ts'
import type { SshConnection } from '../src/connection.ts'

/** A stub registry connection; structurally enough for route facts. */
const fakeConnection = (overrides: Partial<{ host: string; port: number; username: string; cwd: string; label: string }> = {}): SshConnection => ({
  id: 'c1',
  label: overrides.label ?? 'dev box',
  endpoint: 'amax@192.168.10.125',
  spec: {
    id: 'c1',
    label: overrides.label ?? 'dev box',
    host: overrides.host ?? '192.168.10.125',
    port: overrides.port ?? 22,
    username: overrides.username ?? 'amax',
    cwd: overrides.cwd ?? '/home/amax',
  },
  cwd: overrides.cwd ?? '/home/amax',
}) as unknown as SshConnection

// -- parsing: both route spellings -----------------------------------------

{
  // ssh://<id>/<abs>
  const viaUri = parseRoutedCwd('ssh://c1/home/haitang/JunHeAssemblyLine')
  assert.deepEqual(viaUri, { id: 'c1', path: '/home/haitang/JunHeAssemblyLine' })

  // local placeholder twin under a temp DSH_HOME
  const previousHome = process.env.DSH_HOME
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  process.env.DSH_HOME = scratch
  try {
    const placeholder = sshRoutePlaceholder('c1', '/home/haitang/JunHeAssemblyLine')
    const viaPlaceholder = parseRoutedCwd(placeholder)
    assert.deepEqual(viaPlaceholder, { id: 'c1', path: '/home/haitang/JunHeAssemblyLine' })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }

  // local cwd is not a route
  assert.equal(parseRoutedCwd('C:\\Users\\me\\project'), null)
  assert.equal(parseRoutedCwd(undefined), null)
}

// -- route facts, identity text, degraded text, environment -----------------

{
  const facts = routeFactsFor(fakeConnection(), { id: 'c1', path: '/home/haitang/JunHeAssemblyLine' }) as RouteFacts
  assert.equal(facts.host, '192.168.10.125')
  assert.equal(facts.endpoint, 'amax@192.168.10.125')

  const text = routeIdentityText(facts)
  assert.ok(text.includes('c1'), 'identity text names the route id')
  assert.ok(text.includes('amax@192.168.10.125'), 'identity text names the endpoint')
  assert.ok(text.includes('/home/haitang/JunHeAssemblyLine'), 'identity text names the remote path')

  const degraded = degradedRouteText('c1', '/home/haitang/JunHeAssemblyLine', 'the registry has no live entry')
  assert.ok(degraded.includes('c1') && degraded.includes('NOT resolvable'))
  assert.ok(degraded.includes('not because the project is empty'), 'degraded text kills the "empty project" misread')

  const env = routeEnvironment(facts)
  assert.equal(env.DSH_SSH_ROUTE_ID, 'c1')
  assert.equal(env.DSH_SSH_HOST, '192.168.10.125')
  assert.equal(env.DSH_SSH_PORT, '22')
  assert.equal(env.DSH_SSH_USER, 'amax')
  assert.equal(env.DSH_SSH_REMOTE_CWD, '/home/haitang/JunHeAssemblyLine')
}

// -- wiring on a real cordis Context with stub services --------------------

{
  const previousHome = process.env.DSH_HOME
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  process.env.DSH_HOME = scratch
  try {
    const routedCwd = sshRoutePlaceholder('c1', '/home/haitang/JunHeAssemblyLine')
    const localCwd = join(scratch, 'plain-project')
    const ghostCwd = sshRoutePlaceholder('c9', '/somewhere') // route id with no registry entry

    const ctx = new Context()
    // sessions store stub
    const sessions = { get: (id: unknown) => (id === 'sess-routed'
      ? { header: { cwd: routedCwd } }
      : id === 'sess-local' ? { header: { cwd: localCwd } }
      : id === 'sess-ghost' ? { header: { cwd: ghostCwd } } : undefined) }
    // registry stub: c1 resolvable; c9 spells but is unknown.
    const registry = {
      get: (id: string) => (id === 'c1' ? fakeConnection() : undefined),
      list: () => [{ id: 'c1', label: 'dev box', host: '192.168.10.125', port: 22, username: 'amax' }],
    }

    let registeredContexts: Record<string, { name: string; order: number; text: unknown }> = {}
    let registeredEnv: { name: string; variables: unknown; resolve: (execution: unknown) => unknown } | undefined
    const registeredTools: Array<{ name: string; description: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = []

    ctx.provide('sessions'); ctx.sessions = sessions
    ctx.provide('sshRegistry'); ctx.sshRegistry = registry
    ctx.provide('systemPrompt')
    ctx.systemPrompt = {
      context: (registration: { name: string; order: number; text: unknown }) => {
        registeredContexts[registration.name] = registration
        return () => undefined
      },
    }
    ctx.provide('shellEnv')
    ctx.shellEnv = {
      register: (contributor: { name: string; variables: unknown; resolve: (e: unknown) => unknown }) => {
        registeredEnv = contributor
        return () => undefined
      },
    }
    ctx.provide('tools')
    ctx.tools = {
      register: (definition: { name: string; description: string; execute: (a: unknown, e: unknown) => Promise<unknown> }) => {
        registeredTools.push(definition)
        return () => undefined
      },
    }

    installAgentExperience(ctx)
    await new Promise((resolve) => setTimeout(resolve, 10))

    // P0-1: identity + usage contexts distinguish routed / local / degraded.
    assert.equal(remoteWorldOf(ctx), 'local', 'stub ctx mounts no SSH providers, so the guide must say so')
    const identity = registeredContexts[ROUTE_CONTEXT_NAME]
    const usage = registeredContexts[USAGE_CONTEXT_NAME]
    assert.ok(identity !== undefined, 'a routing identity context must be registered')
    assert.ok(usage !== undefined, 'a usage-guide context must be registered')
    const renderIdentity = identity!.text as (context: unknown) => string
    const renderUsage = usage!.text as (context: unknown) => string
    const routedText = renderIdentity({ agent: { session: { header: { cwd: routedCwd } } } })
    assert.ok(routedText.includes('c1') && routedText.includes('/home/haitang/JunHeAssemblyLine'))
    assert.equal(renderIdentity({ agent: { session: { header: { cwd: localCwd } } } }), '', 'local session renders no routing context')
    const degradedText = renderIdentity({ agent: { session: { header: { cwd: ghostCwd } } } })
    assert.ok(degradedText.includes('c9') && degradedText.includes('NOT resolvable'),
      'a route-spelled-but-unknown cwd must render a degraded warning, not silence')

    // The usage guide renders only for live routes and adapts to a local world:
    // it must teach ssh_exec as the channel and warn against the mirror traps.
    assert.equal(renderUsage({ agent: { session: { header: { cwd: localCwd } } } }), '', 'local sessions get no usage guide')
    assert.equal(renderUsage({ agent: { session: { header: { cwd: ghostCwd } } } }), '', 'degraded sessions get no usage guide')
    const routedUsage = renderUsage({ agent: { session: { header: { cwd: routedCwd } } } })
    assert.ok(routedUsage.includes('ssh_exec'), 'usage guide must point at ssh_exec')
    assert.ok(routedUsage.includes('NOT mounted') && routedUsage.includes('placeholders'),
      'usage guide must state when providers are local and mirrors are placeholders')
    assert.ok(/guess the target/u.test(routedUsage), 'usage guide must forbid ssh-config guessing')
    assert.ok(routedUsage.includes('DSH_SSH_REMOTE_CWD'), 'usage guide must mention the env variable')

    // P1-5: env contributor maps routed sessions to DSH_SSH_*; local AND
    // degraded contribute nothing (no false claims about an offline host).
    assert.ok(registeredEnv !== undefined, 'an environment contributor must be registered')
    assert.equal(registeredEnv!.name, 'ssh-route')
    const resolved = registeredEnv!.resolve({ agent: { id: 'sess-routed' } }) as Record<string, string>
    assert.equal(resolved.DSH_SSH_ROUTE_ID, 'c1')
    assert.equal(resolved.DSH_SSH_REMOTE_CWD, '/home/haitang/JunHeAssemblyLine')
    const localResolved = registeredEnv!.resolve({ agent: { id: 'sess-local' } }) as Record<string, string>
    assert.deepEqual(localResolved, {}, 'local session contributes no DSH_SSH_* variables')
    const degradedResolved = registeredEnv!.resolve({ agent: { id: 'sess-ghost' } }) as Record<string, string>
    assert.deepEqual(degradedResolved, {}, 'degraded session contributes no DSH_SSH_* variables')

    // Both tools are registered.
    const execTool = registeredTools.find(tool => tool.name === SSH_EXEC_TOOL)
    const statusTool = registeredTools.find(tool => tool.name === SSH_ROUTE_STATUS_TOOL)
    assert.ok(execTool !== undefined, 'the ssh_exec tool must be registered')
    assert.ok(statusTool !== undefined, 'the ssh_route_status tool must be registered')

    // P0-2: local execution refuses explicitly.
    const localResult = await execTool!.execute({ command: 'uname -a' }, { agent: { id: 'sess-local' }, signal: new AbortController().signal })
    assert.ok(String(localResult).includes('not on an SSH route'), 'local execution must refuse explicitly')

    // P0-2: a degraded route reports triage facts, not a bare failure.
    const degradedResult = await execTool!.execute(
      { command: 'uname -a' },
      { agent: { id: 'sess-ghost' }, signal: new AbortController().signal },
    )
    assert.ok(String(degradedResult).includes('NOT resolvable'), 'degraded execution must say the route is unresolvable')
    assert.ok(String(degradedResult).includes('Known connections'), 'degraded execution must list recovery paths')

    // P1-4: ssh_route_status reports each situation without the network.
    const localStatus = await statusTool!.execute({}, { agent: { id: 'sess-local' }, signal: new AbortController().signal })
    assert.ok(String(localStatus).includes('NOT on an SSH route') && String(localStatus).includes('Known connections'))
    const degradedStatus = await statusTool!.execute({}, { agent: { id: 'sess-ghost' }, signal: new AbortController().signal })
    assert.ok(String(degradedStatus).includes('DEGRADED') && String(degradedStatus).includes('c9'))
    const routedStatus = await statusTool!.execute({}, { agent: { id: 'sess-routed' }, signal: new AbortController().signal })
    assert.ok(String(routedStatus).includes('SSH route `c1`') && String(routedStatus).includes('amax@192.168.10.125'))
    assert.ok(String(routedStatus).includes('/home/haitang/JunHeAssemblyLine'))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('ssh-gui agent-experience: ok — routed/local/degraded contexts, DSH_SSH_* env, ssh_exec and ssh_route_status verified')
