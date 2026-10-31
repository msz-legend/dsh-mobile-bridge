/**
 * 落盘层：设备令牌表与 always 规则表。
 *
 * 只用 node:fs，不引第三方持久化包 —— 插件必须能在任何 profile 组合下加载成功。
 * 所有文件权限 0600（Windows 上 chmod 只能切只读位，失败不致命）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MODE = 0o600

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true })

  const devicesFile = path.join(dir, 'devices.json')
  const alwaysFile = path.join(dir, 'always.json')

  const readJson = (file, fallback) => {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const value = JSON.parse(text)
      return value === null || typeof value !== 'object' ? fallback : value
    } catch {
      return fallback
    }
  }

  const writeJson = (file, value) => {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: MODE })
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, MODE)
    } catch {
      /* Windows 上受限，忽略 */
    }
  }

  return {
    dir,
    readDevices: () => readJson(devicesFile, { version: 1, devices: [] }),
    writeDevices: (value) => writeJson(devicesFile, value),
    readAlways: () => readJson(alwaysFile, { version: 1, rules: [] }),
    writeAlways: (value) => writeJson(alwaysFile, value),
  }
}
