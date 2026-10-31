/**
 * 配对码与设备令牌。
 *
 * 配对码：6 位数字，5 分钟一次性，服务端不存明文（只存哈希后的比较值，
 * 实际上直接常量时间比较即可，因为码是短时有效的短串）。
 * 设备令牌：32 字节随机，服务端只存 sha256，可以按设备撤销。
 *
 * 为什么需要自建令牌：DSH 自带的进程 token / cookie 是 owner 级、30 天、
 * **不支持单设备吊销**。设备令牌是我们自己的外层闸门，撤销即失效。
 */
import crypto from 'node:crypto'

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

export function createPairing({ config, store, log, now = Date.now }) {
  let pending = undefined // { code, expiresAt, attempts }

  const clearCode = () => {
    pending = undefined
  }

  const current = () => {
    if (pending === undefined) return undefined
    if (now() > pending.expiresAt) {
      clearCode()
      return undefined
    }
    return { code: pending.code, expiresAt: pending.expiresAt, remainingMs: pending.expiresAt - now() }
  }

  const issueCode = () => {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    pending = { code, expiresAt: now() + config.pairingTtlMs, attempts: 0 }
    log(`pairing code issued, ttl=${Math.round(config.pairingTtlMs / 60000)}min`)
    return { code, expiresAt: pending.expiresAt, remainingMs: config.pairingTtlMs }
  }

  const listDevices = () => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    return devices.map(({ tokenHash, ...rest }) => rest)
  }

  const issueDevice = (name) => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    const active = devices.filter((entry) => entry.revoked !== true).length
    if (active >= config.maxDevices) {
      log(`pairing refused: device limit ${config.maxDevices} reached`)
      return undefined
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const deviceId = `dev_${crypto.randomBytes(6).toString('hex')}`
    devices.push({
      deviceId,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 48) : 'phone',
      tokenHash: sha256(token),
      createdAt: now(),
      lastSeen: now(),
      revoked: false,
    })
    store.writeDevices({ version: 1, devices })
    log(`device paired: ${deviceId}`)
    return { deviceId, token }
  }

  const verifyCode = (input) => {
    const active = current()
    if (active === undefined) return { ok: false, reason: 'no-code' }
    pending.attempts += 1
    if (pending.attempts > config.pairingMaxAttempts) {
      clearCode()
      log('pairing code burned after too many attempts')
      return { ok: false, reason: 'too-many-attempts' }
    }
    const given = String(input ?? '').replace(/\D/g, '')
    const expected = active.code
    const same =
      given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))
    if (!same) return { ok: false, reason: 'mismatch' }
    clearCode()
    return { ok: true }
  }

  const authenticate = (token) => {
    if (typeof token !== 'string' || token === '') return undefined
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    const hash = sha256(token)
    const device = devices.find((entry) => entry.tokenHash === hash && entry.revoked !== true)
    if (device === undefined) return undefined
    if (now() - (device.lastSeen ?? 0) > 60_000) {
      device.lastSeen = now()
      try {
        store.writeDevices(file)
      } catch {
        /* 统计用途，失败不影响鉴权 */
      }
    }
    return device
  }

  const revoke = (deviceId) => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    const device = devices.find((entry) => entry.deviceId === deviceId)
    if (device === undefined) return false
    device.revoked = true
    store.writeDevices({ version: 1, devices })
    return true
  }

  const revokeAll = () => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    for (const device of devices) device.revoked = true
    store.writeDevices({ version: 1, devices })
    return devices.length
  }

  return { issueCode, current, verifyCode, issueDevice, authenticate, listDevices, revoke, revokeAll, sha256 }
}
