/**
 * 边缘网关：手机唯一入口。
 *
 * 职责：
 *   1. 设备令牌闸门（未配对一律拒绝，不把请求转给宿主）；
 *   2. 反向代理到 DSH 自己的 webServer，并把 Host/Origin 改写成 loopback；
 *   3. 透传 WebSocket 升级（`/api/remote.mux` 是流式输出的唯一通道，必须透传）；
 *   4. 配对接口的按 IP 限速与防爆破；
 *   5. 观察 `POST /api/session/create` 的响应，登记「远程发起」会话。
 *
 * 为什么改写 Host/Origin 就能免配置：宿主 Connection 的信任围栏接受
 * loopback 的 Host，并要求 Origin 与之同 authority。我们把两者都改写成
 * `127.0.0.1:<port>` 后，既不需要 connection.trustedHosts，也不需要 publicUrl。
 *
 * 多地址监听：同一个 handler 可以绑多个具体地址（loopback + LAN）。
 * 这样桌面本机自测走 127.0.0.1，手机在局域网走 LAN IP，两者同时可用。
 */
import http from 'node:http'
import net from 'node:net'
import { URL } from 'node:url'
import { preferredLanAddress } from './tunnel.js'

const PAIR_PREFIX = '/plugins/dsh-mobile-bridge/pair'
const DEVICE_COOKIE = 'dmb'

const parseCookies = (header) => {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key !== '') out[key] = decodeURIComponent(value)
  }
  return out
}

/** 按 IP 滑动窗口限速 + 超限熔断。 */
function createLimiter({ perMinute, blockMsOnExceed, log }) {
  const hits = new Map()

  const allow = (address) => {
    const key = String(address ?? 'unknown')
    const now = Date.now()
    const record = hits.get(key) ?? { windowStart: now, count: 0, blockedUntil: 0 }
    if (record.blockedUntil > now) return false
    if (now - record.windowStart > 60_000) {
      record.windowStart = now
      record.count = 0
    }
    record.count += 1
    if (record.count > perMinute) {
      record.blockedUntil = now + blockMsOnExceed
      hits.set(key, record)
      log(`rate limit tripped for ${key}`)
      return false
    }
    hits.set(key, record)
    if (hits.size > 2000) {
      for (const [k, v] of hits) {
        if (v.blockedUntil < now && now - v.windowStart > 120_000) hits.delete(k)
      }
    }
    return true
  }

  return { allow }
}

export function createEdge({ config, log, pairing, hub, origins }) {
  const limiter = createLimiter({ perMinute: 20, blockMsOnExceed: 10 * 60_000, log })
  const servers = []

  const upstream = () => ({ host: '127.0.0.1', port: config.dshPort, authority: `127.0.0.1:${config.dshPort}` })

  /** 把外部请求头改写成 loopback authority，避免宿主 403。 */
  const rewriteHeaders = (rawHeaders, authority) => {
    const headers = {}
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]
      const value = rawHeaders[i + 1]
      const lower = String(name).toLowerCase()
      if (lower === 'host') {
        headers.host = authority
        continue
      }
      if (lower === 'origin') {
        headers.origin = `http://${authority}`
        continue
      }
      if (lower === 'referer') {
        headers.referer = `http://${authority}/`
        continue
      }
      if (lower === 'connection' || lower === 'proxy-connection' || lower === 'keep-alive') continue
      headers[lower] = value
    }
    return headers
  }

  const authenticate = (req) => {
    const cookies = parseCookies(req.headers.cookie)
    return pairing.authenticate(cookies[DEVICE_COOKIE])
  }

  /** 观察 session/create 的响应体，登记远程会话来源（决定离线时 fail closed 还是交还桌面）。 */
  const watchSessionCreate = (pathname, res) => {
    if (!pathname.endsWith('/session/create')) return
    const chunks = []
    let size = 0
    const originalWrite = res.write.bind(res)
    res.write = (chunk, encoding, callback) => {
      if (size < 64 * 1024 && chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? 'utf8')
        chunks.push(buffer)
        size += buffer.length
      }
      return originalWrite(chunk, encoding, callback)
    }
    res.on('finish', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const match = text.match(/"sessionId"\s*:\s*"([^"]+)"/)
        if (match) {
          origins.markRemote(match[1])
          log(`remote session registered: ${match[1]}`)
        }
      } catch {
        /* 观察失败不影响主流程 */
      }
    })
  }

  const proxy = (req, res) => {
    const target = upstream()
    const headers = rewriteHeaders(req.rawHeaders ?? [], target.authority)
    headers['x-dmb-forwarded-for'] = req.socket.remoteAddress ?? ''

    const upstreamRequest = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(res)
      },
    )

    upstreamRequest.on('error', (error) => {
      log('proxy error:', error?.message ?? error)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('mobile-bridge: upstream unavailable')
    })

    req.pipe(upstreamRequest)
  }

  const proxyUpgrade = (req, socket, head) => {
    const target = upstream()
    const headers = rewriteHeaders(req.rawHeaders ?? [], target.authority)
    headers.connection = 'Upgrade'

    const upstreamSocket = net.connect(target.port, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })

    upstreamSocket.on('error', (error) => {
      log('upgrade proxy error:', error?.message ?? error)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })
    socket.on('error', () => {
      try {
        upstreamSocket.destroy()
      } catch {
        /* ignore */
      }
    })
  }

  const requestHandler = (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://placeholder').pathname
    } catch {
      pathname = '/'
    }

    const device = authenticate(req)

    // 配对入口：未配对也可达，但严格限速
    if (pathname.startsWith(PAIR_PREFIX)) {
      if (!limiter.allow(req.socket.remoteAddress)) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('too many pairing attempts')
        return
      }
      proxy(req, res)
      return
    }

    // 其余一律要求已配对设备
    if (device === undefined) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(302, { location: PAIR_PREFIX })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('mobile-bridge: pair this device first')
      return
    }

    // 走到这里说明请求已带有效设备令牌 —— 只可能是手机侧，因此一律观察会话创建。
    // 注意不能用来源 IP 判断：Tailscale serve 会以 loopback 回源。
    watchSessionCreate(pathname, res)
    proxy(req, res)
  }

  const upgradeHandler = (req, socket, head) => {
    if (authenticate(req) === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head)
  }

  /** 需要绑定的地址集合：显式 edgeHost + （可选）局域网地址。 */
  const bindAddresses = () => {
    const list = []
    const push = (address) => {
      if (typeof address !== 'string' || address === '') return
      if (!list.includes(address)) list.push(address)
    }
    if (config.edgeHost === 'auto') {
      const lan = preferredLanAddress()
      push(lan === undefined ? '127.0.0.1' : lan.address)
      push('127.0.0.1')
    } else {
      push(config.edgeHost)
      if (config.enableLan !== false) {
        const lan = preferredLanAddress()
        if (lan !== undefined) push(lan.address)
      }
    }
    return list
  }

  let activeBindings = []

  const start = async () => {
    if (servers.length > 0) return { ok: true, bindings: activeBindings }
    const addresses = bindAddresses()
    const results = await Promise.all(
      addresses.map(
        (address) =>
          new Promise((resolve) => {
            const server = http.createServer(requestHandler)
            server.on('upgrade', upgradeHandler)
            const onError = (error) => {
              log(`edge bind failed on ${address}:${config.edgePort}: ${error?.message ?? error}`)
              resolve({ address, ok: false })
            }
            server.once('error', onError)
            server.listen(config.edgePort, address, () => {
              server.removeListener('error', onError)
              server.on('error', (error) => log(`edge error on ${address}: ${error?.message ?? error}`))
              servers.push(server)
              log(`edge listening on ${address}:${config.edgePort}`)
              resolve({ address, ok: true })
            })
          }),
      ),
    )
    activeBindings = results.filter((entry) => entry.ok).map((entry) => entry.address)
    return { ok: activeBindings.length > 0, bindings: activeBindings }
  }

  const stop = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            try {
              server.close(() => resolve())
            } catch {
              resolve()
            }
          }),
      ),
    )
    servers.length = 0
    activeBindings = []
  }

  return {
    start,
    stop,
    isListening: () => servers.length > 0,
    bindings: () => [...activeBindings],
  }
}
