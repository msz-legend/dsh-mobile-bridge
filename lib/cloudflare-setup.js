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
