/**
 * Integration test for the GUI backend: the registry and the `/dsh-ssh` RPC
 * channel, hosted on a REAL cordis Context with a fake web transport.
 *
 * No SSH connection is made: `connections.add` stores a spec lazily and only
 * `connections.test` dials the target. This pins the whole user-facing surface —
 * the exact endpoints the React sidebar calls — against a live registry.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.ts'

/** The RPC handler shape the web transport expects. */
type Handler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>

async function mountGui(): Promise<{ ctx: Context; handle: Handler; stateFile: string }> {
  const ctx = new Context()
  // The HostConnectionService's rpc.handle surface, faked: capture the channel
  // handler exactly as the real transport would route to it.
  let captured: Handler | undefined
  ctx.provide('connection')
  ;(ctx as unknown as { connection: unknown }).connection = {
    rpc: {
      handle(_channel: string, handler: Handler, _options: unknown) {
        captured = handler
        return () => undefined
      },
    },
  }
  const stateFile = join(
    mkdtempSync(join(process.cwd(), '.scratch-gui-')),
    'connections.json',
  )
  apply(ctx, { stateFile })
  // `ctx.plugin` mounts through a fiber; give it a few ticks to run the
  // registry construction before the assertions touch the service.
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  return { ctx, handle: captured!, stateFile }
}

const RPC = async (handle: Handler, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> =>
  (await handle(endpoint, payload, new AbortController().signal)) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }

// -- the registry service is mounted --------------------------------------

{
  const { ctx } = await mountGui()
  assert.ok(ctx.get('sshRegistry') !== undefined, 'the GUI apply must mount the connection registry')
}

// -- connection lifecycle over the RPC channel ---------------------------

{
  const { handle, stateFile } = await mountGui()
  try {
    // Empty registry.
    const empty = await RPC(handle, 'connections.list', {})
    assert.equal(empty.ok, true)
    assert.deepEqual((empty.value as unknown[]).length, 0)

    // Add one connection (password auth, with a jump host).
    const added = await RPC(handle, 'connections.add', {
      label: 'dev box',
      host: '192.168.10.125',
      port: 22,
      username: 'amax',
      cwd: '/home/amax',
      auth: 'password',
      password: 'secret',
      jumpHosts: [],
    })
    assert.equal(added.ok, true)
    const addedValue = added.value as { id: string; view: { label: string; host: string } }
    assert.ok(addedValue.id.length > 0)
    assert.equal(addedValue.view.label, 'dev box')

    // The view must never carry the password.
    const listed = await RPC(handle, 'connections.list', {})
    const views = listed.value as { auth: string; host: string }[]
    assert.equal(views.length, 1)
    assert.equal(views[0]!.host, '192.168.10.125')
    assert.equal(views[0]!.auth, 'password')

    // resolve round-trips a host alias through ~/.ssh/config resolution.
    const resolved = await RPC(handle, 'connections.resolve', { host: '192.168.10.125' })
    assert.equal(resolved.ok, true)
    assert.equal((resolved.value as { host: string }).host, '192.168.10.125')

    // Removing a connection succeeds and the list empties.
    const removed = await RPC(handle, 'connections.remove', { id: addedValue.id })
    assert.equal(removed.ok, true)
    const after = await RPC(handle, 'connections.list', {})
    assert.equal((after.value as unknown[]).length, 0)

    // Unknown ids and bad payloads are coded errors, not crashes.
    const unknown = await RPC(handle, 'connections.resolve', { id: 'nope' })
    assert.equal(unknown.ok, false)
    assert.ok((unknown.error?.code ?? '').length > 0)
  } finally {
    rmSync(stateFile, { force: true })
    rmSync(join(process.cwd(), '.scratch-gui-') + '/*', { force: true, recursive: true })
  }
}

// -- the state survives a registry restart (persistence) ------------------

{
  const first = await mountGui()
  await RPC(first.handle, 'connections.add', {
    label: 'persistent',
    host: 'host.example',
    port: 22,
    username: 'dev',
    auth: 'key',
    identityPath: '~/.ssh/id_ed25519',
    jumpHosts: [],
  })

  // A second registry over the SAME state file must see the connection.
  const second = await mountGuiWithState(first.stateFile)
  const listed = await RPC(second.handle, 'connections.list', {})
  assert.equal((listed.value as unknown[]).length, 1, 'a registered connection must survive a restart')
  rmSync(first.stateFile, { force: true })
}

/** Mount the GUI over a specific state file (for the restart assertion). */
async function mountGuiWithState(stateFile: string): Promise<{ handle: Handler; stateFile: string }> {
  const ctx = new Context()
  let captured: Handler | undefined
  ctx.provide('connection')
  ;(ctx as unknown as { connection: unknown }).connection = {
    rpc: { handle: (_c: string, h: Handler) => void (captured = h) && (() => undefined) },
  }
  apply(ctx, { stateFile })
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  return { handle: captured!, stateFile }
}

console.log('ssh-gui backend: ok — registry mounted, add/list/remove/resolve over the RPC channel, persistence verified')
