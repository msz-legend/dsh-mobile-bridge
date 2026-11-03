/** Cloudflare 命名隧道辅助纯函数/落盘测试。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateCloudflareSetup, readTunnelFile, writeTunnelFile } from '../lib/cloudflare-setup.js'

assert.equal(validateCloudflareSetup({ token: 'short', publicBase: 'https://a.b' }).ok, false)
assert.equal(validateCloudflareSetup({ token: 'x'.repeat(30), publicBase: 'http://a.b' }).ok, false)
const ok = validateCloudflareSetup({ token: 'x'.repeat(30), publicBase: 'https://dsh.example.com/' })
assert.equal(ok.ok, true)
assert.equal(ok.publicBase, 'https://dsh.example.com')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-setup-'))
assert.deepEqual(readTunnelFile(dir), {})
writeTunnelFile(dir, { token: 'abc', publicBase: 'https://x' })
assert.equal(readTunnelFile(dir).token, 'abc')
assert.equal(readTunnelFile(dir).publicBase, 'https://x')
fs.rmSync(dir, { recursive: true, force: true })

console.log('cloudflare-setup: PASS')
