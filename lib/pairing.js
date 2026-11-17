/**
 * 设备令牌管理。
 *
 * 绑定闸门由 lib/binding.js 的「绑定密码」负责：密码正确即调 issueDevice，
 * 不再有一次性的 6 位配对码、扫码自动提交或桌面确认状态机。
 *
 * 设备令牌：32 字节随机，服务端只存 sha256，可以按设备撤销。
 * 为什么需要自建令牌：DSH 自带的进程 token / cookie 是 owner 级、30 天、
 * **不支持单设备吊销**。设备令牌是我们自己的外层闸门，撤销即失效。
 */
import crypto from 'node:crypto'

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

export function createPairing({ config, store, log, now = Date.now }) {
  const listDevices = () => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    return devices.map(({ tokenHash, ...rest }) => rest)
  }

  /** 从 UA 推导可读的默认设备名：iOS/iPadOS/Android/桌面各不相同，推导不出时回退 'phone'。 */
  const defaultNameFromUa = (ua) => {
    const text = String(ua ?? '')
    if (/iPad|Tablet/i.test(text)) return 'iPad'
    if (/Android/i.test(text)) return 'Android'
    if (/iPhone|iPod/i.test(text)) return 'iPhone'
    if (/Windows/i.test(text)) return 'Windows'
    if (/Macintosh|Mac OS X/i.test(text)) return 'Mac'
    if (/Linux/i.test(text)) return 'Linux'
    return 'phone'
  }

  /** 同名去重：'iPhone' 已存在时新设备命名为 'iPhone 2'、'iPhone 3'……（上限 99 防失控）。 */
  const dedupeName = (name, devices) => {
    const taken = new Set(devices.filter((entry) => entry.revoked !== true).map((entry) => entry.name))
    if (!taken.has(name)) return name
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${name} ${index}`
      if (!taken.has(candidate)) return candidate
    }
    return `${name} ${Math.random().toString(36).slice(2, 6)}`
  }

  const issueDevice = (name, uaHint) => {
    const file = store.readDevices()
    const devices = Array.isArray(file?.devices) ? file.devices : []
    const active = devices.filter((entry) => entry.revoked !== true).length
    if (active >= config.maxDevices) {
      log(`pairing refused: device limit ${config.maxDevices} reached`)
      return undefined
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const deviceId = `dev_${crypto.randomBytes(6).toString('hex')}`
    const requested = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 48) : defaultNameFromUa(uaHint)
    devices.push({
      deviceId,
      name: dedupeName(requested, devices),
      tokenHash: sha256(token),
      createdAt: now(),
      lastSeen: now(),
      revoked: false,
    })
    store.writeDevices({ version: 1, devices })
    log(`device bound: ${deviceId}`)
    return { deviceId, token }
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

  return {
    issueDevice,
    authenticate,
    listDevices,
    revoke,
    revokeAll,
    purgeRevoked,
    sha256,
  }
}
