/**
 * SakuraFrp（natfrp.com）免费穿透后端。
 *
 * 托管一个 frpc 子进程：`frpc -f <访问密钥>:<隧道ID>`，
 * 从 stdout/stderr 解析「连接地址」，健康探测失败达阈值自动重启进程
 * （复用 createCloudflared 的进程托管模式）。
 *
 * 官方 frpc 日志（0.51.0-sakura-14+）里连接地址有三种形态，见
 * https://doc.natfrp.com/bestpractice/domain-bind.html 与 /app/http.html：
 *   1. `使用 >>www.example.nyat.app:10086<< 连接你的隧道`（子域绑定，无协议）
 *   2. `或使用 IP 地址连接: >>114.51.4.191:10086<<`（IP 备选，优先级低于域名）
 *   3. `http://cn-hk-nf-1.natfrp.cloud:51906`（节点域名，带协议）
 * 另外 `已从服务器为 xxx 加载证书` 表示 frpc 开启了自动 HTTPS，此时对外地址是 https。
 * `*.natfrp.com`（官网 / doc / api / launcher）不是访问地址，必须排除。
 *
 * 机密（访问密钥）只出现在进程参数与内存中，持久化仅经由 tunnel.json（0600）。
 */
import { spawn, execFile } from 'node:child_process'

const RESTART_CAP_MS = 30_000
const STABLE_MS = 5 * 60_000
const KILL_GRACE_MS = 2_000
const TAIL_CHARS = 2000

/** 官网及其子域：日志里的下载页/文档链接不能当成隧道地址。 */
const OFFICIAL_HOST = /(?:^|\.)natfrp\.com$/i
/** SakuraFrp 分配的节点域名 / 免费子域。 */
const NODE_HOST = /(?:^|\.)(?:natfrp\.cloud|nyat\.app)$|(?:^|\.)frp-[a-z0-9-]+\.(?:top|com|net|cn)$/i
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const PRIVATE_HOST = /^(?:localhost|::1|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i
/** frpc 自动 HTTPS / 已签证书的日志证据。 */
const HTTPS_HINT = /加载证书|自动\s*HTTPS|开启\s*HTTPS|已启用\s*HTTPS|HSTS/i
const EXPLICIT_URL = /(https?):\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?/gi
const MARKED_ADDR = />>\s*([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?)\s*<</gi

/** 日志里是否出现 frpc 自动 HTTPS 的证据（供长日志分段消费时保持粘性）。 */
export function frpcHttpsHint(text) {
  return typeof text === 'string' && HTTPS_HINT.test(text)
}

const splitHostPort = (raw) => {
  const match = /^(.+?)(?::(\d{1,5}))?$/.exec(raw)
  return { host: match[1], port: match[2] ?? '' }
}

/** 候选优先级：带 >> << 标记的域名 > 节点域名 URL > 公网 IP；官网/私网/杂项 URL 一律排除。 */
const rankOf = (host, marked) => {
  if (OFFICIAL_HOST.test(host) || PRIVATE_HOST.test(host) || !host.includes('.')) return -1
  if (IPV4.test(host)) return 1
  if (marked) return 4
  return NODE_HOST.test(host) ? 3 : -1
}

/**
 * 从 frpc 日志里提取对外访问地址。
 *
 * - 取「优先级最高」的候选；同级取最后一次出现（frpc 会先打印旧地址再打印最终地址）。
 * - `>>host:port<<` 标记里的域名优先于 `或使用 IP 地址连接: >>IP:port<<`。
 * - 标记形式无协议：有自动 HTTPS 证据、或域名是 *.nyat.app（官方开启 HSTS 预加载）时用 https，否则 http。
 */
export function parseFrpcUrl(text, { httpsHint = false } = {}) {
  if (typeof text !== 'string' || text === '') return undefined
  const tls = httpsHint || frpcHttpsHint(text)
  let best
  const consider = (index, rawHost, port, scheme, marked) => {
    const rank = rankOf(rawHost, marked)
    if (rank < 0) return
    const authority = `${rawHost}${port === '' ? '' : `:${port}`}`
    const url = `${scheme}://${authority}`
    if (best === undefined || rank > best.rank || (rank === best.rank && index >= best.index)) {
      best = { rank, index, url }
    }
  }
  for (const match of text.matchAll(EXPLICIT_URL)) {
    consider(match.index, match[2], match[3] ?? '', match[1].toLowerCase(), false)
  }
  for (const match of text.matchAll(MARKED_ADDR)) {
    const { host, port } = splitHostPort(match[1])
    const scheme = tls || /(?:^|\.)nyat\.app$/i.test(host) ? 'https' : 'http'
    consider(match.index, host, port, scheme, true)
  }
  return best?.url
}

/**
 * frpc 是否可用。
 *
 * 官方 Linux 教程用 `frpc -v`，新版（≥0.51.0-sakura-14）用 `./frpc -V`；
 * 两个都试，stdout/stderr 任一有版本输出即算可用。
 */
export function detectSakuraBin(bin = 'frpc') {
  const probe = (flag) => new Promise((resolve) => {
    execFile(bin, [flag], { timeout: 8000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(undefined)
        return
      }
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
      resolve(text === '' ? 'unknown' : text.split(/\r?\n/)[0].trim())
    })
  })
  return (async () => {
    for (const flag of ['-v', '-V']) {
      const version = await probe(flag)
      if (version !== undefined) return { installed: true, version }
    }
    return { installed: false, version: undefined }
  })()
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
  // 自动 HTTPS 的证据可能出现在地址之前且被日志滚动切掉，一旦见到就粘住
  let tlsHint = false

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
    const text = String(chunk)
    if (frpcHttpsHint(text)) tlsHint = true
    tail = (tail + text).slice(-TAIL_CHARS)
    const found = parseFrpcUrl(tail, { httpsHint: tlsHint })
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
    tlsHint = false
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
