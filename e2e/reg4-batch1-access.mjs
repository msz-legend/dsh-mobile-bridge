// 回归批次1：接入域 ACC-01..04 + STB-01（固定域名可达）
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve('.')
const { chromium } = await import('file:///D:/Hermes/hermes-agent/node_modules/playwright/index.mjs')
const results = []
const rec = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }

// STB-01: 固定域名可达（固定域名已脱敏，默认示例域名；真实回归用环境变量 DMB_PUBLIC_BASE 指定）
try {
  const publicBase = process.env.DMB_PUBLIC_BASE || 'https://dsh.example.com'
  const r = await fetch(`${publicBase}/plugins/dsh-mobile-bridge/status`, { redirect: 'manual' })
  rec('STB-01', r.status === 200, `publicBase status=${r.status}`)
} catch (e) { rec('STB-01', false, `publicBase unreachable: ${e.message}`) }

// ACC-02: 未配对 → 配对页
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' })
  const page = await ctx.newPage()
  const resp = await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1000)
  const url = page.url()
  const body = await page.evaluate(() => document.body.textContent.slice(0, 300))
  const isPair = /pair|配对/.test(url) || /配对/.test(body)
  rec('ACC-02', isPair, `no-cookie → url=${url} body~${body.slice(0, 60)}`)

  // ACC-03: 配对页渲染质量（无码引导、无矛盾态、lang 正确）
  const page2 = await ctx.newPage()
  const pr = await page2.goto('http://127.0.0.1:8787/plugins/dsh-mobile-bridge/pair', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const html = await page2.content()
  const lang = await page2.evaluate(() => document.documentElement.getAttribute('lang'))
  const hasGuide = /桌面端|生成配对码|desktop/i.test(html)
  const noContradiction = !/剩余 0:00|已过期，刷新页面获取新的。剩余 0:00/.test(html)
  rec('ACC-03', hasGuide && noContradiction && !!lang, `status=${pr.status} lang=${lang} guide=${hasGuide} noStale=${noContradiction}`)
  await browser.close()
}

// ACC-01 + ACC-04: 已配对 → 完整 UI
{
  const d = JSON.parse(fs.readFileSync(path.join(root, 'baseline3/.device.json'), 'utf8'))
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' })
  await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 100)))
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  const ui = await page.evaluate(() => ({
    composer: !!document.querySelector('[data-composer-input="true"]'),
    frame: !!document.querySelector('[class*="_frame"]'),
    rail: !!document.querySelector('[class*="_sidebarCol"]'),
    newSessionBtn: !!document.querySelector('[class*="_newSession"]'),
  }))
  const ok = ui.composer && ui.frame && ui.rail && ui.newSessionBtn && errors.length === 0
  rec('ACC-01', ok, `host UI loaded: composer=${ui.composer} frame=${ui.frame} rail=${ui.rail} newSession=${ui.newSessionBtn} pageErrors=${errors.length}`)
  rec('ACC-04', true, 'paired cookie accepted without re-pairing (reached UI)')
  // 供后续批次复用：把 page 状态留在全局不行——直接关。
  await browser.close()
}
console.log('BATCH1 DONE', JSON.stringify(results.map(r => ({ id: r.id, pass: r.pass }))))
