/**
 * 无 npm 的依赖安装器。
 *
 * 本机 npm CLI 不可用（除 `npm -v` 外任何子命令都在 npm.ps1 里因 $LASTEXITCODE 未设置而失败），
 * 但 registry 的 HTTPS 是通的（`fetch` 验证过）。此脚本按固定版本清单直接下载 tarball，
 * 用 Windows 内置 bsdtar 解到 node_modules/。
 *
 * 用法：node scripts/fetch-deps.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modules = join(root, 'node_modules')

/** 固定版本清单（含 ssh2 的运行时依赖闭包；跳过 cpu-features/nan 这两个可选原生加速件）。 */
const PINS = [
  ['ssh2', '1.17.0'],
  ['asn1', '0.2.6'],
  ['safer-buffer', '2.1.2'],
  ['bcrypt-pbkdf', '1.0.2'],
  ['tweetnacl', '0.14.5'],
]

/**
 * 解出一个包版本的 tarball 地址。
 * @param {string} name 包名。
 * @param {string} version 精确版本。
 * @returns {Promise<string>} dist.tarball 地址。
 */
async function tarballUrl(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`)
  if (!res.ok) throw new Error(`registry ${name}@${version}: HTTP ${res.status}`)
  const meta = await res.json()
  const url = meta?.dist?.tarball
  if (typeof url !== 'string') throw new Error(`registry ${name}@${version}: no dist.tarball`)
  return url
}

/**
 * 下载并解包一个包到 node_modules/<name>。
 * @param {string} name 包名。
 * @param {string} version 精确版本。
 * @returns {Promise<void>}
 */
async function install(name, version) {
  const dest = join(modules, name)
  if (existsSync(join(dest, 'package.json'))) {
    console.log(`skip  ${name}@${version} (already present)`)
    return
  }
  const url = await tarballUrl(name, version)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`tarball ${name}@${version}: HTTP ${res.status}`)
  const tgz = join(tmpdir(), `dsh-dep-${name.replace(/[^a-z0-9]/gi, '_')}-${version}.tgz`)
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  mkdirSync(dest, { recursive: true })
  // bsdtar 随 Windows 10+ 内置；stdio 用 inherit 以避开沙箱对管道捕获的限制。
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], {
    stdio: 'inherit',
  })
  rmSync(tgz, { force: true })
  if (tar.error) throw tar.error
  if (tar.status !== 0) throw new Error(`tar exited ${tar.status} for ${name}@${version}`)
  console.log(`ok    ${name}@${version}`)
}

mkdirSync(modules, { recursive: true })
for (const [name, version] of PINS) await install(name, version)
console.log('done')
