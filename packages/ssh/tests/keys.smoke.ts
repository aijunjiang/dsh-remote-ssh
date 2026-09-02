/**
 * Local smoke test for the generated identity: `ssh2` must accept the private
 * key PEM we emit, and the public blob we put in `authorized_keys` must be the
 * exact one that key advertises. No remote host is involved.
 *
 * Run: node --import tsx <this file>
 */

import assert from 'node:assert/strict'
// ssh2 is CommonJS and its named exports are not statically detectable, so the
// default import is the only reliable shape from an ES module.
import ssh2 from 'ssh2'
import { generateEd25519Identity } from '../src/keys.ts'

const { utils } = ssh2

const identity = generateEd25519Identity('dsh@example')

const parsed = utils.parseKey(identity.privateKeyPem)
assert.ok(!(parsed instanceof Error), `ssh2 rejected the private key: ${String(parsed)}`)
const key = Array.isArray(parsed) ? parsed[0] : parsed
assert.equal(key.type, 'ssh-ed25519')

// The authorized_keys line must advertise the same blob ssh2 derives from the key.
const advertised = key.getPublicSSH().toString('base64')
assert.equal(advertised, identity.publicKeyBlobBase64)

const [algorithm, blob, comment] = identity.authorizedKeysLine.split(' ')
assert.equal(algorithm, 'ssh-ed25519')
assert.equal(blob, identity.publicKeyBlobBase64)
assert.equal(comment, 'dsh@example')

// A signature the key produces must verify under the advertised public key.
const message = Buffer.from('dsh remote workspace')
const signature = key.sign(message)
assert.ok(!(signature instanceof Error), `sign failed: ${String(signature)}`)
const publicOnly = utils.parseKey(`ssh-ed25519 ${identity.publicKeyBlobBase64} dsh@example`)
assert.ok(!(publicOnly instanceof Error), `ssh2 rejected the authorized_keys line: ${String(publicOnly)}`)
assert.equal(publicOnly.verify(message, signature), true)

console.log('keys.smoke: ok — ssh2 accepts the generated OPENSSH PRIVATE KEY and the authorized_keys line')
