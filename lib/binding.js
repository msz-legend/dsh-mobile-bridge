/**
 * 绑定密码管理：手机接入的唯一闸门。
 *
 * 密码首次运行自动生成 12 位 base64url 随机串，持久化到
 * <storeDir>/binding.json（0600），桌面设置页可查看/复制/重生成/改自定义。
 *
 * 为什么明文存盘：桌面必须能「回显」密码给用户看，不能只存哈希。
 * 威胁模型与 tunnel.json / push.json 一致——本地机密文件，权限 0600，
 * 绝不进仓库、配置或日志；拿到本机文件访问权的人本来就能读 owner cookie。
 *
 * 与旧配对码的区别：不再是一次性 6 位数字 + 扫码自动提交 + 桌面确认，
 * 而是长期有效的密码，密码正确即直接发设备令牌，无桌面二次确认。
 * 暴力破解由 routes.js 的按来源滑动窗口限速挡住。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'binding.json'
const MODE = 0o600
const MIN_LEN = 6
const MAX_LEN = 64
const GENERATED_LEN = 12

const defaultRandomPassword = () => crypto.randomBytes(9).toString('base64url').slice(0, GENERATED_LEN)

export function createBindingManager({ dir, log, now = Date.now, randomPassword = defaultRandomPassword }) {
  const file = path.join(dir, FILE)
  let cached // { password, custom, createdAt }

  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (value === null || typeof value !== 'object') return undefined
      if (typeof value.password !== 'string' || value.password === '') return undefined
      return {
        password: value.password,
        custom: value.custom === true,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : now(),
      }
    } catch {
      return undefined
    }
  }

  const write = (record) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: MODE })
    try {
      fs.chmodSync(file, MODE)
    } catch {
      /* Windows 上受限，忽略 */
    }
    cached = record
    return record.password
  }

  /** 首次运行懒生成；已有文件直接复用（幂等）。返回当前明文密码。 */
  const ensure = () => {
    if (cached !== undefined) return cached.password
    const existing = read()
    if (existing !== undefined) {
      cached = existing
      return cached.password
    }
    const password = String(randomPassword())
    log('binding password generated (local only)')
    return write({ password, custom: false, createdAt: now() })
  }

  /** 常量时间比较；长度不等直接 false（timingSafeEqual 要求等长 Buffer）。 */
  const verify = (input) => {
    const password = ensure()
    if (typeof input !== 'string') return false
    const given = input.trim()
    if (given === '') return false
    const expected = Buffer.from(password, 'utf8')
    const actual = Buffer.from(given, 'utf8')
    if (actual.length !== expected.length) return false
    return crypto.timingSafeEqual(actual, expected)
  }

  /**
   * 重生成：不传 custom → 新随机串；传非空字符串 → 自定义密码（6–64 字符）。
   * 返回新明文密码。非法长度抛 'binding-password-length' 且不改动已存值。
   */
  const regenerate = (custom) => {
    ensure()
    let password
    let isCustom = false
    if (typeof custom === 'string' && custom.trim() !== '') {
      password = custom.trim()
      if (password.length < MIN_LEN || password.length > MAX_LEN) {
        throw new Error('binding-password-length')
      }
      isCustom = true
    } else {
      password = String(randomPassword())
    }
    log(isCustom ? 'binding password replaced with custom value' : 'binding password rotated')
    return write({ password, custom: isCustom, createdAt: now() })
  }

  /** 只暴露元信息，绝不把明文塞进概览接口（回显走 loopback-only 的 /pairing.json）。 */
  const describe = () => {
    const record = ensure()
    void record
    return { hasCustom: cached.custom === true, createdAt: cached.createdAt }
  }

  /** 供 loopback-only 接口回显明文；非 loopback 路由不得调用。 */
  const reveal = () => ensure()

  return { ensure, verify, regenerate, describe, reveal }
}
