/**
 * Local generation of an OpenSSH-compatible ed25519 identity.
 *
 * The auth ladder this serves mirrors VS Code Remote-SSH: the first connection
 * uses the password the operator typed, and the harness immediately provisions a
 * key so no later connection needs one. That requires emitting two exact wire
 * formats, both built here with no native dependency:
 *
 *   * `authorized_keys` line — `ssh-ed25519 <base64 blob> <comment>`
 *   * `OPENSSH PRIVATE KEY` PEM — the format `ssh-keygen` writes, and the one
 *     `ssh2` parses most reliably for ed25519 (PKCS#8 support varies).
 *
 * Node's WebCrypto exports give DER; the raw 32-byte scalars sit at the tail of
 * each DER structure, which is stable for ed25519 because both structures have
 * fixed-length prefixes.
 *
 * @module
 */

import { generateKeyPairSync } from 'node:crypto'

/** SSH wire `string`: a 32-bit big-endian length followed by the payload. */
function sshString(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([length, body])
}

/** SSH wire `uint32`. */
function sshUint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

/** Wrap base64 in a PEM envelope with OpenSSH's 70-column body. */
function pem(label: string, body: Buffer): string {
  const base64 = body.toString('base64')
  const lines: string[] = []
  for (let index = 0; index < base64.length; index += 70) {
    lines.push(base64.slice(index, index + 70))
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** One generated identity, in the two wire formats SSH actually consumes. */
export interface Ed25519Identity {
  /** Complete `OPENSSH PRIVATE KEY` PEM text, unencrypted, for `ssh2`. */
  privateKeyPem: string
  /** Single `authorized_keys` line, newline-free. */
  authorizedKeysLine: string
  /** Base64 of the public key blob — the stable fingerprint input. */
  publicKeyBlobBase64: string
}

/**
 * Generate a fresh ed25519 identity for one remote target.
 * @param comment - trailing comment recorded in `authorized_keys`, typically `dsh@<host>`.
 * @returns the private key PEM plus the matching `authorized_keys` line.
 */
export function generateEd25519Identity(comment: string): Ed25519Identity {
  if (comment.includes('\n')) throw new Error('dsh-ssh: key comment must be single-line')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  // SPKI DER for ed25519 is a 12-byte header plus the 32-byte public key.
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const rawPublic = spki.subarray(spki.length - 32)
  // PKCS#8 DER for ed25519 ends with the 32-byte seed.
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const seed = pkcs8.subarray(pkcs8.length - 32)

  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(rawPublic)])

  // The private section is checked by two identical random words, so a wrong
  // decryption passphrase is detectable; unencrypted keys still carry them.
  const check = Buffer.alloc(4)
  check.writeUInt32BE(Math.floor(Math.random() * 0xffff_ffff), 0)
  let inner = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(rawPublic),
    // ed25519 private key material is seed || public key.
    sshString(Buffer.concat([seed, rawPublic])),
    sshString(comment),
  ])
  // Pad to the cipher block size (8 for "none") with 1,2,3,... exactly as OpenSSH does.
  const padding: number[] = []
  for (let index = 1; inner.length + padding.length > 0 && (inner.length + padding.length) % 8 !== 0; index += 1) {
    padding.push(index)
  }
  inner = Buffer.concat([inner, Buffer.from(padding)])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'), // ciphername
    sshString('none'), // kdfname
    sshString(''), // kdfoptions
    sshUint32(1), // key count
    sshString(publicBlob),
    sshString(inner),
  ])

  return {
    privateKeyPem: pem('OPENSSH PRIVATE KEY', body),
    authorizedKeysLine: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
    publicKeyBlobBase64: publicBlob.toString('base64'),
  }
}
