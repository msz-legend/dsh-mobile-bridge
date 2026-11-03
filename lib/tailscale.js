/**
 * Tailscale 一键接入的宿主侧封装。
 *
 * 只由 loopback（桌面本机）触发：检测安装/登录状态、发起登录、开启/关闭 Funnel、
 * 一键安装（winget）。命令一律走 execFile/spawn + 参数数组，不经过 shell。
 * 所有函数都接收可注入的 `bin`，便于测试；解析函数（parseStatus/parseFunnel）为纯函数。
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'

const WIN_BIN = 'C:\\Program Files\\Tailscale\\tailscale.exe'

export function tailscaleBin() {
  try {
    if (fs.existsSync(WIN_BIN)) return WIN_BIN
  } catch {
    /* ignore */
  }
  return 'tailscale'
}

const run = (bin, args, timeoutMs = 8000) =>
  new Promise((resolve) => {
    try {
      execFile(bin, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error === null ? undefined : String(error.message ?? error),
        })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: String(error?.message ?? error) })
    }
  })

/** 纯函数：解析 `tailscale status --json`。 */
export function parseStatus(jsonText) {
  let j
  try {
    j = JSON.parse(String(jsonText ?? ''))
  } catch {
    return { installed: true, loggedIn: false, raw: String(jsonText ?? '').slice(0, 200) }
  }
  const self = j.Self ?? {}
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []
  const ip = ips.find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x))
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : ''
  return {
    installed: true,
    backendState: j.BackendState,
    loggedIn: j.BackendState === 'Running' && dnsName !== '',
    online: self.Online !== false,
    ip,
    dnsName,
    hostname: self.HostName,
    health: Array.isArray(j.Health) ? j.Health : [],
  }
}

/** 纯函数：解析 `tailscale funnel status` 文本。 */
export function parseFunnel(text) {
  const s = String(text ?? '')
  const on = /Funnel on/i.test(s) || /Available on the internet/i.test(s)
  const m = s.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.ts\.net\/?/i)
  return { on, url: m ? m[0].replace(/\/$/, '') : undefined }
}

export async function tailscaleStatus({ bin = tailscaleBin() } = {}) {
  const r = await run(bin, ['status', '--json'], 8000)
  const errText = `${r.error ?? ''} ${r.stderr ?? ''}`
  if (!r.ok && /not recognized|ENOENT|No such file|is not recognized|cannot find|not found/i.test(errText)) {
    return { installed: false }
  }
  const status = parseStatus(r.stdout)
  if (status.installed === true) {
    const f = await run(bin, ['funnel', 'status'], 5000)
    status.funnel = parseFunnel(`${f.stdout}\n${f.stderr}`)
  }
  return status
}

/** 发起登录：spawn `tailscale up`，抓取授权链接；不阻塞（进程继续等待登录完成）。 */
export async function tailscaleLogin({ bin = tailscaleBin() } = {}) {
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    let p
    try {
      p = spawn(bin, ['up'], { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(/https:\/\/login\.tailscale\.com\/[a-z]\/[A-Za-z0-9]+/)
      if (m) finish({ ok: true, needLogin: true, url: m[0] })
    }
    p.stdout?.on('data', onData)
    p.stderr?.on('data', onData)
    p.on('error', (e) => finish({ ok: false, error: String(e?.message ?? e) }))
    setTimeout(() => finish({ ok: true, pending: true }), 8000)
  })
}

/** 开启公网 Funnel 到指定端口；未在 tailnet 启用时返回 needEnable + enableUrl。 */
export async function tailscaleEnableFunnel(port, { bin = tailscaleBin() } = {}) {
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    let p
    const finish = (v) => {
      if (done) return
      done = true
      try {
        p?.kill()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    try {
      p = spawn(bin, ['funnel', '--bg', String(port)], { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }
    const onData = (d) => {
      buf += d.toString()
      const en = buf.match(/https:\/\/login\.tailscale\.com\/f\/funnel\?[^\s'"]+/)
      if (en) return finish({ ok: false, needEnable: true, enableUrl: en[0] })
      if (/Available on the internet/i.test(buf)) {
        return finish({ ok: true, url: parseFunnel(buf).url })
      }
    }
    p.stdout?.on('data', onData)
    p.stderr?.on('data', onData)
    p.on('error', (e) => finish({ ok: false, error: String(e?.message ?? e) }))
    setTimeout(() => finish({ ok: true, pending: true, raw: buf.slice(0, 300) }), 15000)
  })
}

export async function tailscaleDisableFunnel({ bin = tailscaleBin() } = {}) {
  const r = await run(bin, ['funnel', '--https=443', 'off'], 8000)
  return { ok: r.ok, output: (r.stdout + r.stderr).trim().slice(0, 300) }
}

/** 一键安装（Windows winget）。可能因权限失败，返回原始输出供前端提示。 */
export async function tailscaleInstall() {
  const r = await run(
    'winget',
    ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
    180000,
  )
  return { ok: r.ok, output: (r.stdout + r.stderr).trim().slice(-600) }
}
