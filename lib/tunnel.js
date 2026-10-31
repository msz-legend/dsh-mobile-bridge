/**
 * 对外地址推导。
 *
 * 优先级：显式 config.publicBase → cloudflared 隧道 → Tailscale DNS 名 → 本机 LAN IPv4 → loopback。
 * cloudflared URL 由隧道管理器解析 trycloudflare 输出得到（quick 模式），传入即最高自动档；
 * token 模式没有可解析的 URL，用户应显式写 publicBase。
 * Tailscale 用 `tailscale status --json` 探测；未安装时静默退回 LAN，不影响插件加载。
 * 探测结果缓存，避免每次渲染配对页都起子进程。
 */
import { execFile } from 'node:child_process'
import os from 'node:os'

let cachedTailscale
let cachedAt = 0
const CACHE_MS = 60_000

const VIRTUAL_NAME = /(virtual|vmware|vbox|hyper-v|vethernet|loopback|bluetooth|warp|tailscale|zerotier|npcap|vgate|tun|tap|docker|wsl)/i
const VIRTUAL_ADDRESS = /^(169\.254\.|172\.16\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

const scoreOf = (entry) => {
  let score = 0
  if (entry.address.startsWith('192.168.')) score += 100
  else if (entry.address.startsWith('10.')) score += 60
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score += 30
  else score += 10
  if (VIRTUAL_NAME.test(entry.name)) score -= 100
  if (VIRTUAL_ADDRESS.test(entry.address)) score -= 100
  return score
}

export function lanAddresses() {
  const result = []
  const interfaces = os.networkInterfaces()
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      result.push({ name, address: address.address, score: scoreOf({ name, address: address.address }) })
    }
  }
  return result.sort((a, b) => b.score - a.score)
}

/** 最像一个「手机能连上的局域网地址」的那个。 */
export function preferredLanAddress() {
  const best = lanAddresses()[0]
  if (best === undefined || best.score <= 0) return undefined
  return best
}

export function detectTailscale(timeoutMs = 1500) {
  const now = Date.now()
  if (cachedTailscale !== undefined && now - cachedAt < CACHE_MS) return Promise.resolve(cachedTailscale)
  return new Promise((resolve) => {
    try {
      execFile('tailscale', ['status', '--json'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        let found
        if (!error) {
          try {
            const parsed = JSON.parse(stdout)
            const dnsName = parsed?.Self?.DNSName
            if (typeof dnsName === 'string' && dnsName.length > 0) {
              found = `https://${dnsName.replace(/\.$/, '')}`
            }
          } catch {
            found = undefined
          }
        }
        cachedTailscale = found
        cachedAt = Date.now()
        resolve(found)
      })
    } catch {
      cachedTailscale = undefined
      cachedAt = Date.now()
      resolve(undefined)
    }
  })
}

export async function resolvePublicBase(config, edgePort, bindings, log, tunnelUrl) {
  if (typeof config.publicBase === 'string' && config.publicBase.trim() !== '') {
    return config.publicBase.trim().replace(/\/+$/, '')
  }
  if (typeof tunnelUrl === 'string' && tunnelUrl.startsWith('https://')) return tunnelUrl
  const tailscale = await detectTailscale()
  if (tailscale) return tailscale
  const lan = (bindings ?? []).find((address) => address !== '127.0.0.1' && address !== '::1')
  if (lan !== undefined) {
    log(`publicBase auto-detected on LAN: ${lan} (port ${edgePort})`)
    return `http://${lan}:${edgePort}`
  }
  const preferred = preferredLanAddress()
  if (preferred !== undefined) {
    // 绑定是 loopback，但机器有 LAN 地址：如实提示需要一个可达的绑定
    log(`LAN address ${preferred.address} exists but edge is bound to loopback; set edgeHost to enable LAN access`)
  }
  return `http://127.0.0.1:${edgePort}`
}
