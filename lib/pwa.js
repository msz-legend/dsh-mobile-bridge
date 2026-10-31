/**
 * PWA 资产：manifest 图标（PNG，零依赖）。
 *
 * 为什么手写 PNG：宿主运行环境里没有 sharp/canvas，引依赖会拖累安装；
 * 图标本身几何简单（圆角方块 + 位图字形），用 2x 超采样 + 盒滤波就能得到干净边缘。
 * 输出为 straight-alpha RGBA（边缘 RGB 用背景色填充，避免混入黑边）。
 */
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buffer) => {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const encodePng = (rgba, width, height) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 5x7 位图 "M"：移动桥接的识别符号
const GLYPH_M = ['X...X', 'XX.XX', 'X.X.X', 'X.X.X', 'X...X', 'X...X', 'X...X']

const GRADIENT_TOP = [0x1d, 0x4e, 0xd8]
const GRADIENT_BOTTOM = [0x0f, 0x17, 0x2a]

const lerp = (a, b, t) => Math.round(a + (b - a) * t)

/**
 * 画一枚图标。square=true 时无圆角、不透明（apple-touch-icon 用，iOS 自己裁圆角）；
 * 否则圆角外透明（PWA maskable/any 用，Android 裁成圆/方）。
 */
const drawIcon = (size, square) => {
  const s = size * 2 // 2x 超采样
  const buf = Buffer.alloc(s * s * 4)
  const radius = square ? 0 : s * 0.225
  const inRounded = (x, y) => {
    if (square) return true
    const rx = x < radius ? radius - x : x > s - radius ? x - (s - radius) : 0
    const ry = y < radius ? radius - y : y > s - radius ? y - (s - radius) : 0
    return rx * rx + ry * ry <= radius * radius
  }
  const glyphH = s * 0.42
  const cell = glyphH / 7
  const glyphW = cell * 5
  const gx0 = (s - glyphW) / 2
  const gy0 = (s - glyphH) / 2
  for (let y = 0; y < s; y += 1) {
    const t = y / (s - 1)
    const r = lerp(GRADIENT_TOP[0], GRADIENT_BOTTOM[0], t)
    const g = lerp(GRADIENT_TOP[1], GRADIENT_BOTTOM[1], t)
    const b = lerp(GRADIENT_TOP[2], GRADIENT_BOTTOM[2], t)
    for (let x = 0; x < s; x += 1) {
      const offset = (y * s + x) * 4
      let pixelR = r
      let pixelG = g
      let pixelB = b
      const gx = Math.floor((x - gx0) / cell)
      const gy = Math.floor((y - gy0) / cell)
      if (gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && GLYPH_M[gy][gx] === 'X') {
        pixelR = 0xff
        pixelG = 0xff
        pixelB = 0xff
      }
      // 边缘外的 RGB 也写背景色：透明区与不透明区的 RGB 连续，盒滤波不产生黑边
      buf[offset] = pixelR
      buf[offset + 1] = pixelG
      buf[offset + 2] = pixelB
      buf[offset + 3] = inRounded(x + 0.5, y + 0.5) ? 0xff : 0x00
    }
  }
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let ch = 0; ch < 4; ch += 1) {
        const sum =
          buf[(y * 2 * s + x * 2) * 4 + ch] +
          buf[(y * 2 * s + x * 2 + 1) * 4 + ch] +
          buf[((y * 2 + 1) * s + x * 2) * 4 + ch] +
          buf[((y * 2 + 1) * s + x * 2 + 1) * 4 + ch]
        out[(y * size + x) * 4 + ch] = sum >> 2
      }
    }
  }
  return encodePng(out, size, size)
}

const cache = new Map()

/** 生成（带缓存）指定尺寸的图标 PNG。square 用于 apple-touch-icon。 */
export function iconPng(size, { square = false } = {}) {
  const key = `${size}:${square ? 'square' : 'rounded'}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const png = drawIcon(size, square)
  cache.set(key, png)
  return png
}

/** PWA manifest（start_url/scope 取根路径：Web UI 本体就在根上）。 */
export function manifestJson(routeBase) {
  return JSON.stringify({
    name: 'DSH Mobile Bridge',
    short_name: 'DSH',
    description: 'DSH Desktop 移动接入：同一套 Web UI + 工具审批卡片',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: `${routeBase}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${routeBase}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  })
}
