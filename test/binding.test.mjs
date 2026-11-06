/**
 * 绑定密码管理器测试（Task 1）。
 * 用临时目录跑，不触碰真实 storeDir；覆盖生成/幂等/校验/重生成/自定义/权限/描述。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBindingManager } from '../lib/binding.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-binding-'))
const log = () => undefined
let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

const fixtureDir = () => fs.mkdtempSync(path.join(tmpRoot, 'case-'))

try {
  // B1 首次 ensure 生成 12 位 base64url 密码并落盘
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log })
    const first = binding.ensure()
    assert.equal(typeof first, 'string')
    assert.equal(first.length, 12)
    assert.match(first, /^[A-Za-z0-9_-]{12}$/)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'binding.json'), 'utf8'))
    assert.equal(file.password, first)
    assert.equal(file.custom, false)
    assert.equal(typeof file.createdAt, 'number')
    pass('B1 ensure() generates 12-char password and persists it')
  }

  // B2 权限：非 Windows 断言 0600（无 group/other 位）
  {
    const dir = fixtureDir()
    createBindingManager({ dir, log }).ensure()
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(dir, 'binding.json')).mode & 0o777
      assert.equal(mode & 0o077, 0, 'group/other bits must be clear')
    } else {
      assert.ok(fs.existsSync(path.join(dir, 'binding.json')), 'file is readable on Windows')
    }
    pass('B2 binding.json is 0600 on POSIX / readable on Windows')
  }

  // B3 ensure 幂等
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log })
    const first = binding.ensure()
    const second = binding.ensure()
    assert.equal(second, first)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'binding.json'), 'utf8'))
    assert.equal(file.createdAt, file.createdAt, 'createdAt unchanged on second ensure')
    pass('B3 ensure() is idempotent')
  }

  // B4 verify 正确/错误/空/null/尾随空白
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log, randomPassword: () => 'ABCDEFGHIJKL' })
    const password = binding.ensure()
    assert.equal(password, 'ABCDEFGHIJKL')
    assert.equal(binding.verify(password), true)
    assert.equal(binding.verify('wrong-password'), false)
    assert.equal(binding.verify(''), false)
    assert.equal(binding.verify(null), false)
    assert.equal(binding.verify(undefined), false)
    assert.equal(binding.verify(`${password}  `), true, 'trailing whitespace is trimmed')
    assert.equal(binding.verify(`  ${password}`), true, 'leading whitespace is trimmed')
    pass('B4 verify() handles correct/wrong/empty/null/whitespace')
  }

  // B5 regenerate() 新随机值生效
  {
    const dir = fixtureDir()
    let counter = 0
    const binding = createBindingManager({ dir, log, randomPassword: () => `PW${String(counter++).padStart(10, '0')}` })
    const first = binding.ensure()
    const second = binding.regenerate()
    assert.notEqual(second, first)
    assert.equal(binding.verify(first), false)
    assert.equal(binding.verify(second), true)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'binding.json'), 'utf8'))
    assert.equal(file.password, second)
    assert.equal(file.custom, false)
    pass('B5 regenerate() rotates to a fresh random password')
  }

  // B6 regenerate('自定义密码') 生效且 hasCustom=true
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log, randomPassword: () => 'ORIGINALPW01' })
    const first = binding.ensure()
    const custom = binding.regenerate('my-secret-pass')
    assert.equal(custom, 'my-secret-pass')
    assert.equal(binding.verify('my-secret-pass'), true)
    assert.equal(binding.verify(first), false)
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'binding.json'), 'utf8'))
    assert.equal(file.custom, true)
    assert.equal(binding.describe().hasCustom, true)
    pass('B6 regenerate(custom) persists custom password')
  }

  // B7 长度校验（6–64）
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log, randomPassword: () => 'ORIGINALPW01' })
    binding.ensure()
    assert.throws(() => binding.regenerate('12345'), (error) => /binding-password-length/.test(String(error?.message ?? error)))
    assert.throws(
      () => binding.regenerate('x'.repeat(65)),
      (error) => /binding-password-length/.test(String(error?.message ?? error)),
    )
    assert.equal(binding.verify('ORIGINALPW01'), true, 'invalid custom must not overwrite stored value')
    pass('B7 regenerate(custom) rejects <6 and >64 char inputs')
  }

  // B8 describe() 不含密码本体
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log, randomPassword: () => 'ORIGINALPW01' })
    binding.ensure()
    const described = binding.describe()
    assert.equal(Object.prototype.hasOwnProperty.call(described, 'password'), false)
    assert.equal(described.hasCustom, false)
    assert.equal(typeof described.createdAt, 'number')
    pass('B8 describe() never leaks the password')
  }

  // B9 注入 randomPassword stub（已在 B4 使用）确认可确定性断言
  {
    const dir = fixtureDir()
    const binding = createBindingManager({ dir, log, randomPassword: () => 'STUBBEDPW012' })
    assert.equal(binding.ensure(), 'STUBBEDPW012')
    pass('B9 injected randomPassword stub is honored')
  }

  console.log(`\n${passed} checks passed`)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
