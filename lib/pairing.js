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
  // 公网/局域网配对的桌面确认请求（对齐 Cloud Link 的「桌面确认」语义）：
  // 码是「看到了桌面屏幕」，桌面点确认才是「人在电脑前」。同一时刻只允许一个待确认请求。
  let confirmPending = undefined

  const clearCode = () => {
    pending = undefined
  }

  const liveConfirm = () => {
    if (confirmPending === undefined) return undefined
    // 过期即清（pollConfirm 不会发放过期 token，留着只会永久阻塞下一次配对）
    if (now() > confirmPending.expiresAt) {
      confirmPending = undefined
      return undefined
    }
    return confirmPending
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

  /** 清理已撤销记录（不影响未撤销设备）；返回被清除的条数。 */
  const purgeRevoked = () => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    const kept = devices.filter((entry) => entry.revoked !== true)
    const purged = devices.length - kept.length
    if (purged > 0) store.writeDevices({ version: 1, devices: kept })
    return purged
  }

  /**
   * 公网/局域网配对：码验证通过后先挂起，等桌面确认再真正发设备。
   * token 在确认时生成，等手机轮询领走；确认页超时/拒绝/超限都会落终态。
   */
  const stageConfirm = (name, source) => {
    if (liveConfirm() !== undefined) return undefined
    confirmPending = {
      confirmId: `cfm_${crypto.randomBytes(8).toString('hex')}`,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 48) : 'phone',
      source: typeof source === 'string' && source.trim() !== '' ? source.trim().slice(0, 64) : '',
      requestedAt: now(),
      expiresAt: now() + (config.pairConfirmTtlMs ?? 120_000),
      token: undefined,
      deviceId: undefined,
      outcome: undefined, // 'denied' | 'limit' | 已发 token
    }
    log(`pairing confirmation staged for "${confirmPending.name}" from ${confirmPending.source || 'unknown'}`)
    return {
      confirmId: confirmPending.confirmId,
      name: confirmPending.name,
      source: confirmPending.source,
      expiresAt: confirmPending.expiresAt,
    }
  }

  /** 桌面确认入口（仅 loopback 可调）。 */
  const resolveConfirm = (confirmId, allow) => {
    const record = liveConfirm()
    if (record === undefined || String(confirmId ?? '') !== record.confirmId) return { ok: false, reason: 'unknown' }
    if (record.outcome !== undefined || record.token !== undefined) return { ok: false, reason: 'already-resolved' }
    if (allow !== true) {
      record.outcome = 'denied'
      log('pairing confirmation denied on desktop')
      return { ok: true }
    }
    const device = issueDevice(record.name)
    if (device === undefined) {
      record.outcome = 'limit'
      return { ok: false, reason: 'limit' }
    }
    record.token = device.token
    record.deviceId = device.deviceId
    log(`pairing confirmation allowed on desktop: ${device.deviceId}`)
    return { ok: true, deviceId: device.deviceId }
  }

  /** 手机轮询：领走确认后的设备令牌（不用 liveConfirm，让过期返回明确的 'expired'）。 */
  const pollConfirm = (confirmId) => {
    const record = confirmPending
    if (record === undefined || String(confirmId ?? '') !== record.confirmId) {
      return { ok: false, state: 'unknown' }
    }
    if (record.outcome === 'denied') {
      confirmPending = undefined
      return { ok: false, state: 'denied' }
    }
    if (record.outcome === 'limit') {
      confirmPending = undefined
      return { ok: false, state: 'limit' }
    }
    if (now() > record.expiresAt) {
      confirmPending = undefined
      return { ok: false, state: 'expired' }
    }
    if (record.token === undefined) return { ok: false, state: 'waiting' }
    const token = record.token
    const deviceId = record.deviceId
    confirmPending = undefined
    return { ok: true, token, deviceId }
  }

  const pendingConfirm = () => {
    const record = liveConfirm()
    if (record === undefined) return undefined
    return {
      confirmId: record.confirmId,
      name: record.name,
      source: record.source,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
      remainingMs: Math.max(0, record.expiresAt - now()),
      resolved: record.outcome ?? (record.token !== undefined ? 'allowed' : undefined),
    }
  }

  return {
    issueCode,
    current,
    verifyCode,
    issueDevice,
    authenticate,
    listDevices,
    revoke,
    revokeAll,
    purgeRevoked,
    stageConfirm,
    resolveConfirm,
    pollConfirm,
    pendingConfirm,
    sha256,
  }
}
