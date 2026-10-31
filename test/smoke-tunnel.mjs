/**
 * cloudflared quick tunnel 手动真机冒烟（不依赖 DSH Desktop，不计入 npm test）。
 *
 *   node test/smoke-tunnel.mjs
 *
 * 流程：本地 HTTP 服务 → 用插件真实的 createCloudflared 起 quick tunnel →
 * 等 trycloudflare URL → 从公网 fetch 绕 CF 边缘一圈 → 验证响应原样返回。
 *
 * 二进制定位：环境变量 CLOUDFLARED_BIN → PATH → Windows 默认安装路径。
 */
import http from 'node:http'
import { execFile } from 'node:child_process'

const MARKER = 'dsh-mobile-bridge smoke ok'
const PORT = Number(process.env.SMOKE_PORT ?? 8788)

const DEFAULT_WIN = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'

const probe = (bin) =>
  new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (error) => resolve(error ? undefined : bin))
    } catch {
      resolve(undefined)
    }
  })

const BIN =
  process.env.CLOUDFLARED_BIN ??
  (await probe('cloudflared')) ??
  (await probe(DEFAULT_WIN))

if (BIN === undefined) {
  console.error('[smoke] cloudflared not found (set CLOUDFLARED_BIN or install via `winget install Cloudflare.cloudflared`)')
  process.exit(1)
}

const { createCloudflared } = await import('../lib/cloudflared.js')

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`${MARKER} path=${req.url}\n`)
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
console.log(`[smoke] local server on 127.0.0.1:${PORT}`)

const tunnel = createCloudflared({
  config: { tunnelEnabled: true, tunnelMode: 'quick', tunnelToken: '', tunnelBin: BIN },
  targetPort: PORT,
  log: (...parts) => console.log('[cloudflared]', ...parts),
  onUrl: (url) => console.log('[smoke] onUrl fired:', url),
})

const urlPromise = new Promise((resolve, reject) => {
  const started = Date.now()
  const tick = () => {
    const url = tunnel.url()
    if (url) return resolve(url)
    if (Date.now() - started > 30_000) return reject(new Error('tunnel URL not resolved in 30s'))
    setTimeout(tick, 500)
  }
  tick()
})

const state = await tunnel.start()
console.log('[smoke] start() status:', JSON.stringify({ running: state.running, mode: state.mode, binary: state.binary }))

let url
try {
  url = await urlPromise
} catch (error) {
  console.error('[smoke] FAIL:', error.message)
  await tunnel.stop()
  server.close()
  process.exit(1)
}
console.log('[smoke] tunnel URL:', url)

// 新隧道域名的 DNS 传播需要几秒（实测 ~8s），所以重试窗口要给足。
const deadline = Date.now() + 45_000
let attempt = 0
let body
while (Date.now() < deadline) {
  attempt += 1
  try {
    const response = await fetch(`${url}/smoke-ping?ts=${Date.now()}`, { signal: AbortSignal.timeout(8000) })
    const text = await response.text()
    console.log(`[smoke] attempt ${attempt}: HTTP ${response.status}`)
    if (response.ok) {
      body = text
      break
    }
  } catch (error) {
    console.log(`[smoke] attempt ${attempt}: ${String(error?.cause?.code ?? error?.message ?? error).slice(0, 120)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

let ok = false
if (typeof body === 'string' && body.includes(MARKER) && body.includes('path=/smoke-ping')) {
  ok = true
  console.log('[smoke] public roundtrip OK:', body.trim())
} else {
  console.error('[smoke] FAIL: public roundtrip never succeeded')
  console.error('[smoke] tunnel status at end:', JSON.stringify(tunnel.status()))
}

await tunnel.stop()
server.close()
console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
