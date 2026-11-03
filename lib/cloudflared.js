/**
 * cloudflared 隧道管理器：公网档通道。
 *
 * 两种模式：
 *   quick  零账号临时隧道 `cloudflared tunnel --url http://127.0.0.1:<edgePort>`，
 *          从进程输出解析 https://<random>.trycloudflare.com 作为 publicBase；
 *   token  远程管理的命名隧道 `cloudflared tunnel run --token <token>`，
 *          域名在 Cloudflare 后台配置，publicBase 需要用户显式提供。
 *
 * 设计约束：
 *   - spawn 不经 shell，参数全部走数组，token 不写日志；
 *   - 意外退出按指数退避自动重启（封顶 30s，稳定 5 分钟后计数清零）；
 *   - stop() 幂等，插件卸载（scoped.effect 清理）时必须干净收尾。
 */
import { execFile, spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

const QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi
/** cloudflared 自身的服务端点也会以 *.trycloudflare.com 出现在日志里，不是隧道地址。 */
const NON_TUNNEL_HOSTS = /^(?:api|www|update)\.trycloudflare\.com$/i
const RESTART_CAP_MS = 30_000
const STABLE_MS = 5 * 60_000
const KILL_GRACE_MS = 2_000
const STDERR_TAIL_CHARS = 2000

/** 从 cloudflared 的输出里提取 quick tunnel 地址（跳过 api/www/update 等服务端点）。 */
export function parseTunnelUrl(text) {
  if (typeof text !== 'string') return undefined
  for (const match of text.matchAll(QUICK_URL)) {
    const url = match[0]
    if (!NON_TUNNEL_HOSTS.test(url.slice(8))) return url
  }
  return undefined
}

/**
 * 探测一个公网地址是否可达（隧道是否真的通）。
 * 任意 HTTP 响应（含 401/403）都算「通」——入口活着；只有网络错误或 5xx/530 才算不健康。
 * 用于健康看护：进程还活着但隧道已死（cloudflared 卡住 / Cloudflare 边缘 1033）时也能发现并重启。
 */
export function probeUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const lib = url.startsWith('https:') ? https : http
      const req = lib.request(
        url,
        { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'dsh-mobile-bridge-health' } },
        (res) => {
          res.resume()
          finish(!(Number(res.statusCode) >= 500))
        },
      )
      req.on('timeout', () => {
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        finish(false)
      })
      req.on('error', () => finish(false))
      req.end()
    } catch {
      finish(false)
    }
  })
}

export function createCloudflared({
  config,
  targetPort,
  log,
  onUrl,
  healthUrl,
  healthIntervalMs = 60_000,
  healthFailLimit = 3,
  probe = probeUrl,
}) {
  const bin = config.tunnelBin || 'cloudflared'
  let child = undefined
  let stopping = false
  let currentUrl = undefined
  let found = false
  let startedAt = 0
  let lastError = undefined
  let restarts = 0
  let restartTimer = undefined
  let killTimer = undefined
  let healthTimer = undefined
  let healthFails = 0

  const status = () => ({
    enabled: config.tunnelEnabled === true,
    mode: config.tunnelMode,
    running: child !== undefined,
    url: currentUrl,
    binary: bin,
    pid: child?.pid,
    startedAt: startedAt > 0 ? startedAt : undefined,
    lastError,
    restarts,
  })

  const stopHealth = () => {
    if (healthTimer !== undefined) {
      clearInterval(healthTimer)
      healthTimer = undefined
    }
    healthFails = 0
  }
  const currentHealthUrl = () => (typeof healthUrl === 'function' ? healthUrl() : healthUrl)
  // 周期探测「隧道是否真的通」：连续失败达到阈值就杀掉子进程，交给 exit 的退避重启逻辑拉起来。
  const startHealth = () => {
    stopHealth()
    const first = currentHealthUrl()
    if (typeof first !== 'string' || first === '') return
    healthTimer = setInterval(() => {
      if (stopping || child === undefined) return
      const target = currentHealthUrl()
      if (typeof target !== 'string' || target === '') return
      void probe(target, 8000)
        .then((ok) => {
          if (stopping) return
          if (ok === true) {
            healthFails = 0
            return
          }
          healthFails += 1
          lastError = `health check failed (${healthFails}/${healthFailLimit}): ${target}`
          log(lastError)
          if (healthFails >= healthFailLimit && child !== undefined) {
            healthFails = 0
            log('health check threshold reached; restarting cloudflared')
            try {
              child.kill()
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => undefined)
    }, healthIntervalMs)
    if (typeof healthTimer.unref === 'function') healthTimer.unref()
  }
  const clearTimers = () => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer)
      killTimer = undefined
    }
    stopHealth()
  }

  const spawnTunnel = () => {
    found = false
    // 协议：quick 隧道默认走 QUIC(udp/7844)；装了 Cloudflare WARP 这类接管流量的
    // 客户端时，QUIC 常被劫持导致 "control stream error: context deadline exceeded"，
    // 隧道反复重连、地址不断变化，手机端表现为 HTTP 530。此时切 http2(tcp/443) 更稳。
    const protocol = typeof config.tunnelProtocol === 'string' && config.tunnelProtocol !== '' ? config.tunnelProtocol : ''
    const protocolArgs = protocol !== '' ? ['--protocol', protocol] : []
    const args =
      config.tunnelMode === 'token'
        ? ['tunnel', '--no-autoupdate', ...protocolArgs, 'run', '--token', config.tunnelToken]
        : ['tunnel', '--no-autoupdate', ...protocolArgs, '--url', `http://127.0.0.1:${targetPort}`]
    let proc
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      lastError = error?.message ?? String(error)
      log('cloudflared spawn failed:', lastError)
      return
    }
    child = proc
    startedAt = Date.now()
    log(`cloudflared started (pid ${proc.pid}, mode ${config.tunnelMode})`)
    startHealth()

    let tail = ''
    const consume = (chunk) => {
      const text = chunk.toString('utf8')
      // 始终保留 stderr 尾巴：进程意外退出时带进日志，否则失败原因无从排查。
      tail = `${tail}${text}`.slice(-STDERR_TAIL_CHARS)
      if (found || config.tunnelMode !== 'quick') return
      const url = parseTunnelUrl(tail)
      if (url === undefined) return
      found = true
      currentUrl = url
      log(`quick tunnel ready: ${url}`)
      try {
        onUrl?.(url)
      } catch {
        /* 回调失败不影响隧道 */
      }
      startHealth()
    }
    proc.stdout?.on('data', consume)
    proc.stderr?.on('data', consume)

    proc.on('error', (error) => {
      lastError = error?.message ?? String(error)
      log('cloudflared process error:', lastError)
    })

    proc.on('exit', (code, signal) => {
      child = undefined
      currentUrl = undefined
      stopHealth()
      if (stopping) return
      if (Date.now() - startedAt > STABLE_MS) restarts = 0
      const delay = Math.min(RESTART_CAP_MS, 1000 * 2 ** Math.min(restarts, 5))
      restarts += 1
      lastError = `exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'}); tail: ${tail.slice(-STDERR_TAIL_CHARS).replace(/\s+/g, ' ').trim()}`
      log(`cloudflared ${lastError}; restarting in ${delay}ms`)
      restartTimer = setTimeout(() => {
        restartTimer = undefined
        if (!stopping) spawnTunnel()
      }, delay)
      if (typeof restartTimer.unref === 'function') restartTimer.unref()
    })
  }

  const detectBinary = (timeoutMs = 8000) =>
    new Promise((resolve) => {
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        execFile(bin, ['--version'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
          if (error) {
            lastError = `cloudflared binary not runnable (${bin}): ${error.message ?? error}`
            log(lastError)
            finish(false)
            return
          }
          log(`cloudflared detected: ${String(stdout ?? '').trim() || 'unknown version'}`)
          finish(true)
        })
      } catch (error) {
        lastError = error?.message ?? String(error)
        finish(false)
      }
    })

  const start = async () => {
    if (config.tunnelEnabled !== true) return status()
    if (child !== undefined) return status()
    if (config.tunnelMode === 'token' && config.tunnelToken === '') {
      lastError = 'tunnelMode=token requires tunnelToken'
      log(lastError)
      return status()
    }
    const ok = await detectBinary()
    if (!ok) return status()
    stopping = false
    spawnTunnel()
    return status()
  }

  const stop = () => {
    stopping = true
    clearTimers()
    const running = child
    if (running === undefined) return Promise.resolve()
    try {
      running.kill()
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      // Windows 下 kill() 不保证收掉整棵进程树；宽限 2s 后 taskkill 兜底。
      killTimer = setTimeout(() => {
        killTimer = undefined
        if (running.exitCode !== null && running.exitCode !== undefined) return
        try {
          execFile('taskkill', ['/pid', String(running.pid), '/T', '/F'], { windowsHide: true }, () => {})
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }
    return Promise.resolve()
  }

  return { start, stop, status, url: () => currentUrl }
}
