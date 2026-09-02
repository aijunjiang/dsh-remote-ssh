/**
 * Unit tests for the human-readable route manifest (P1-5): written beside the
 * connection state, secret-free, refreshed on add/remove.
 *
 * Run: node <this file>
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRoutesManifest,
  routesManifestPath,
  writeRoutesManifest,
  type RoutesManifestEntry,
} from '../src/routes-manifest.ts'

{
  const scratch = mkdtempSync(join(process.cwd(), '.scratch-manifest-'))
  try {
    const stateFile = join(scratch, 'dsh-ssh-connections.json')
    const entries: RoutesManifestEntry[] = [
      {
        id: 'c1',
        label: 'dev box',
        host: '192.168.10.125',
        port: 22,
        username: 'amax',
        cwd: '/home/amax',
        auth: 'password',
        jumpHosts: [],
      },
    ]

    const expectedPath = routesManifestPath(stateFile)
    assert.equal(expectedPath, join(scratch, 'dsh-ssh-routes.json'))

    const written = writeRoutesManifest(stateFile, entries)
    assert.equal(written, expectedPath)
    assert.ok(existsSync(expectedPath), 'the manifest file must be written')

    const doc = JSON.parse(readFileSync(expectedPath, 'utf8')) as ReturnType<typeof buildRoutesManifest>
    assert.equal(doc.connections.length, 1)
    assert.equal(doc.connections[0]!.id, 'c1')
    assert.equal(doc.connections[0]!.host, '192.168.10.125')
    assert.equal(doc.connections[0]!.auth, 'password')
    const raw = readFileSync(expectedPath, 'utf8')
    assert.ok(!raw.includes('secret') && !raw.includes('password: "'), 'the manifest must never carry credentials')

    // Empty registry still writes a valid (empty) manifest.
    writeRoutesManifest(stateFile, [])
    const emptied = JSON.parse(readFileSync(expectedPath, 'utf8')) as ReturnType<typeof buildRoutesManifest>
    assert.deepEqual(emptied.connections, [])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('ssh-gui routes-manifest: ok — sibling manifest written beside connection state, secret-free')
