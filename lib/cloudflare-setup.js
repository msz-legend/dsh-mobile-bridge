/**
 * Cloudflare 命名隧道（固定域名）一键接入的辅助。
 *
 * 目标：让用户在设置页填入「连接器 token + 固定域名」即可把公网地址固定下来。
 * token 是敏感凭据，只写本地 <storeDir>/tunnel.json（0600），绝不进仓库/配置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { probeUrl } from './cloudflared.js'

export function readTunnelFile(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function writeTunnelFile(dir, value) {
  const file = path.join(dir, 'tunnel.json')
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows 上受限，忽略 */
  }
}

/** 纯函数：校验命名隧道入参。 */
export function validateCloudflareSetup(payload) {
  const token = typeof payload?.token === 'string' ? payload.token.trim() : ''
  const publicBase =
    typeof payload?.publicBase === 'string' ? payload.publicBase.trim().replace(/\/+$/, '') : ''
  if (token.length < 20) return { ok: false, error: 'token-too-short' }
  if (/^https:\/\/[^\s]+$/i.test(publicBase) !== true) return { ok: false, error: 'publicBase-must-be-https' }
  return { ok: true, token, publicBase }
}

export function detectCloudflared(bin = 'cloudflared') {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (error, stdout) => {
        resolve({ installed: error === null, version: error === null ? String(stdout ?? '').trim() : undefined })
      })
    } catch {
      resolve({ installed: false })
    }
  })
}

export async function probePublic(url) {
  if (typeof url !== 'string' || url === '') return undefined
  return probeUrl(url, 8000)
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

/** 纯函数：解析 `sc query cloudflared` / `systemctl is-active` 输出。 */
export function parseServiceStatus(result) {
  const out = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  if (/1060|does not exist|指定的服务未安装|not installed|No such file/i.test(out)) {
    return { installed: false, running: false }
  }
  const running = /\bRUNNING\b/i.test(out) || String(result?.stdout ?? '').trim() === 'active'
  const installed = out.trim() !== '' && (/SERVICE_NAME|STATE/i.test(out) || running)
  return { installed, running }
}

/** 查询系统服务 cloudflared 是否已安装/运行（Windows 用 sc，其它用 systemctl）。 */
export async function cloudflaredServiceStatus(bin = 'cloudflared') {
  if (process.platform === 'win32') {
    return parseServiceStatus(await run('sc', ['query', 'cloudflared'], 8000))
  }
  const r = await run('systemctl', ['is-active', 'cloudflared'], 5000)
  const active = String(r.stdout).trim() === 'active'
  return { installed: active || /active/i.test(String(r.stdout)), running: active }
}

/**
 * 把命名隧道注册为系统服务（`cloudflared service install <token>`）。
 * 需要管理员权限；权限不足时返回 needsAdmin，前端提示手动操作。
 */
export async function cloudflaredServiceInstall(token, bin = 'cloudflared') {
  const r = await run(bin, ['service', 'install', token], 60000)
  const out = (r.stdout + r.stderr).trim()
  const needsAdmin =
    r.ok !== true && /access is denied|administrator|拒绝访问|elevation|管理员|privilege/i.test(out)
  const service = await cloudflaredServiceStatus(bin)
  return { ok: r.ok, needsAdmin, output: out.slice(-600), service }
}

export async function cloudflaredServiceUninstall(bin = 'cloudflared') {
  const r = await run(bin, ['service', 'uninstall'], 30000)
  return { ok: r.ok, output: (r.stdout + r.stderr).trim().slice(-600) }
}
