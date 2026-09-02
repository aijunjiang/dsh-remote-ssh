/**
 * Server-side smoke test for the GUI layer: every module in the fork's closure
 * must resolve in the harness package domain and expose its expected surface.
 *
 * The React client (`src/client/*`) is intentionally NOT exercised here: it is
 * compiled into the web bundle by the harness's own build, which this sandbox
 * cannot run (esbuild is denied). Its correctness is pinned by the upstream
 * package's own CI, and the fork changes nothing in it.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'

const gui = await import('../src/index.ts')

// Every forked module must load — a dangling relative import or a missing
// junctioned package fails here, not at first web launch.
const modules = await Promise.all([
  import('../src/runtime.ts'),
  import('../src/connection.ts'),
  import('../src/registry.ts'),
  import('../src/transport.ts'),
  import('../src/web.ts'),
  import('../src/picker.ts'),
  import('../src/plugin.ts'),
])

assert.equal(modules.length, 7, 'the whole server closure must load')

// The registry is a cordis Service publishing `sshRegistry`.
assert.equal(typeof gui.SshRegistry, 'function')
assert.equal(typeof gui.SshRegistry.prototype?.list, 'function', 'registry must expose the connection surface')
assert.equal(typeof gui.SshRegistry.prototype?.add, 'function')
assert.equal(typeof gui.SshRegistry.prototype?.route, 'function', 'registry must parse ssh:// routes')

// The connection class constructs and holds a spec.
assert.equal(typeof gui.SshConnection, 'function')

// The web channel exposes the RPC application entry.
assert.equal(typeof gui.applyWeb, 'function')

// The picker is a DirectoryPicker subclass (the upstream seam's abstract base
// comes from the junctioned package; constructing needs a Context, so only the
// class shape is checked here).
assert.equal(typeof gui.SshDirectoryPicker, 'function')
assert.deepEqual(gui.SshDirectoryPicker.inject, ['ssh'], 'the picker injects the connection owner')

// The aggregate apply mounts the registry and the RPC channel.
assert.equal(typeof gui.apply, 'function')

console.log('ssh-gui smoke: ok — runtime/connection/registry/transport/web/picker/plugin all resolve')
