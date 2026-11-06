/**
 * SakuraFrp（natfrp.com）免费穿透后端。
 *
 * 托管一个 frpc 子进程：`frpc -f <访问密钥>:<隧道ID>`，
 * 从 stdout/stderr 解析「访问地址」（例如 http://frp-xxx.natfrp.cloud:12345），
 * 健康探测失败达阈值自动重启进程（复用 createCloudflared 的进程托管模式）。
 *
 * 机密（访问密钥）只出现在进程参数与内存中，持久化仅经由 tunnel.json（0600）。
 */
import { spawn, execFile } from 'node:child_process'

const RESTART_CAP_MS = 30_000
const STABLE_MS = 5 * 60_000
const KILL_GRACE_MS = 2_000
const TAIL_CHARS = 2000

/** 节点域名形如 *.natfrp.cloud / *.frp-N.top；官网 www.natfrp.com 不是访问地址。 */
const TUNNEL_HOST = /https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:natfrp\.cloud|frp-\d+\.top)(?::\d+)?/i
const OFFICIAL = /^https?:\/\/(?:www\.)?natfrp\.com(?:[/:?#]|$)/i

/** 从 frpc 日志行里提取访问地址（取最后一次出现；无则 undefined）。 */
export function parseFrpcUrl(text) {
  if (typeof text !== 'string' || text === '') return undefined
  let found
  for (const match of text.matchAll(new RegExp(TUNNEL_HOST.source, 'gi'))) {
    const url = match[0]
    if (OFFICIAL.test(url)) continue
    found = url
  }
  return found
}

/** frpc 是否可用（execFile --version，超时 8s）。 */
export function detectSakuraBin(bin = 'frpc') {
  return new Promise((resolve) => {
    execFile(bin, ['-v'], { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve({ installed: false, version: undefined })
        return
      }
      resolve({ installed: true, version: String(stdout ?? '').trim() || 'unknown' })
    })
  })
}

export function createSakuraFrp({
  config,
  targetPort,
  log,
  onUrl,
  healthUrl,
  healthIntervalMs = 60_000,
  healthFailLimit = 3,
  probe,
  bin,
  binArgs,
}) {
  const binary = bin ?? config.sakuraBin ?? 'frpc'
  const extraArgs = Array.isArray(binArgs) ? binArgs : []
  let child
  let currentUrl
  let stopped = false
  let restartTimer
  let healthTimer
  let healthFails = 0
  let restarts = 0
  let startedAt
  let lastError
  let tail = ''

  const status = () => ({
    enabled: config.tunnelMode === 'sakura' && config.tunnelEnabled === true,
    mode: 'sakura',
    running: child !== undefined,
    url: currentUrl,
    binary,
    pid: child?.pid,
    startedAt,
    lastError,
    restarts,
  })

  const consume = (chunk) => {
    tail = (tail + String(chunk)).slice(-TAIL_CHARS)
    const found = parseFrpcUrl(tail)
    if (found === undefined || found === currentUrl) return
    currentUrl = found
    healthFails = 0
    log(`sakura tunnel address: ${currentUrl}`)
    onUrl?.(currentUrl)
  }

  const healthCheck = async () => {
    if (child === undefined || stopped) return
    const target = typeof healthUrl === 'function' ? healthUrl() : healthUrl
    if (typeof target !== 'string' || target === '') return
    try {
      const ok = await probe(target, 8000)
      if (ok) {
        healthFails = 0
        return
      }
    } catch {
      /* 探测异常按失败计 */
    }
    healthFails += 1
    if (healthFails >= healthFailLimit) {
      log(`sakura tunnel unhealthy x${healthFails}, restarting`)
      child.kill()
    }
  }

  const scheduleRestart = () => {
    if (stopped) return
    restarts += 1
    const delay = Math.min(RESTART_CAP_MS, 500 * 2 ** Math.min(restarts, 8))
    if (Date.now() - (startedAt ?? 0) > STABLE_MS) restarts = 1
    restartTimer = setTimeout(() => {
      if (stopped) return
      log('sakura tunnel process exited, restarting')
      void start()
    }, delay)
  }

  const start = async () => {
    if (config.tunnelMode !== 'sakura' || config.tunnelEnabled !== true) {
      return { enabled: false, running: false }
    }
    if (child !== undefined) return status()
    if (config.sakuraToken === '' || config.sakuraTunnelId === '') {
      const message = 'tunnelMode=sakura requires sakuraToken and sakuraTunnelId'
      lastError = message
      throw new Error(message)
    }
    stopped = false
    tail = ''
    currentUrl = undefined
    const args = [...extraArgs, '-f', `${config.sakuraToken}:${config.sakuraTunnelId}`]
    child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    startedAt = Date.now()
    log(`sakura tunnel started (pid ${child.pid})`)
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('exit', (code) => {
      child = undefined
      if (stopped) return
      lastError = `frpc exited with code ${code ?? 'signal'}`
      scheduleRestart()
    })
    if (typeof probe === 'function') {
      healthTimer = setInterval(() => void healthCheck(), healthIntervalMs)
      healthTimer.unref?.()
    }
    return status()
  }

  const stop = async () => {
    stopped = true
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
    if (healthTimer !== undefined) {
      clearInterval(healthTimer)
      healthTimer = undefined
    }
    const dying = child
    child = undefined
    if (dying === undefined) return
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, KILL_GRACE_MS)
      dying.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      dying.kill()
      if (process.platform === 'win32') {
        // Windows 下 kill() 只杀直接子进程；taskkill /T 兜底整棵进程树。
        try {
          execFile('taskkill', ['/PID', String(dying.pid), '/T', '/F'], { timeout: 4000 }, () => resolve())
        } catch {
          /* kill() 已发出，忽略 */
        }
      }
    })
    log('sakura tunnel stopped')
  }

  return { start, stop, status, url: () => currentUrl }
}
