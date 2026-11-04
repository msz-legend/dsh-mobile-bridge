// 回归批次4：体验域 UX-01..04 + STB-02（桌面无副作用）+ STB-03（门禁）
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve('.')
const { chromium } = await import('file:///D:/Hermes/hermes-agent/node_modules/playwright/index.mjs')
const results = []
const rec = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const d = JSON.parse(fs.readFileSync(path.join(root, 'baseline3/.device.json'), 'utf8'))
const EDGE = 'http://127.0.0.1:8787'
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'

// UX-01: 「› 展开」提示三态
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: UA })
  await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
  const page = await ctx.newPage()
  await page.goto(`${EDGE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  const hint = () => page.evaluate(() => { const h = document.querySelector('.dmb-rail-hint'); return h ? getComputedStyle(h).display : 'missing' })
  const s0 = await hint()
  await page.mouse.click(26, 25); await page.waitForTimeout(900)
  const s1 = await hint()
  await page.mouse.click(350, 400); await page.waitForTimeout(900)
  const s2 = await hint()
  rec('UX-01', s0 === 'flex' && s1 === 'none' && s2 === 'flex', `collapsed=${s0} expanded=${s1} re-collapsed=${s2}`)
  await browser.close()
}

// UX-02: 触屏按压反馈
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: UA })
  await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
  const page = await ctx.newPage()
  await page.goto(`${EDGE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  const pressed = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    if (!btn) return null
    const before = getComputedStyle(btn).filter
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise(r => setTimeout(r, 80))
    const during = getComputedStyle(btn).filter
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return { changed: before !== during, before, during }
  })
  rec('UX-02', pressed !== null && pressed.changed, `button press filter ${pressed ? pressed.before + '→' + pressed.during : 'n/a'}`)
  await browser.close()
}

// UX-03: 提问卡片窄屏铺满（用宿主 qcard 类名探测 CSS 规则存在 + 渲染回归走 DOM 注入）
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: UA })
  await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
  const page = await ctx.newPage()
  await page.goto(`${EDGE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1200)
  const css = await page.evaluate(() => {
    let found = false
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) { if (r.selectorText && r.selectorText.includes('.wnLwla_frame')) { found = true; break } } } catch {}
      if (found) break
    }
    return found
  })
  // 注入模拟卡片验证 CSS 生效
  const width = await page.evaluate(() => {
    const frame = document.createElement('div')
    frame.className = 'wnLwla_frame'
    document.body.appendChild(frame)
    const w = frame.getBoundingClientRect().width
    frame.remove()
    return Math.round(w)
  })
  rec('UX-03', css && width >= 360, `qcard CSS present=${css} injected frame width=${width}(expect ≥360 全宽)`)
  await browser.close()
}

// UX-04: PWA 元数据
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: UA })
  const page = await ctx.newPage()
  await page.goto(`${EDGE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const meta = await page.evaluate(() => ({
    viewport: document.querySelector('meta[name="viewport"]')?.content ?? null,
    themeColorMedia: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.getAttribute('media')),
    manifest: !!document.querySelector('link[rel="manifest"]'),
    appleTouch: !!document.querySelector('link[rel="apple-touch-icon"]'),
  }))
  const ok = meta.viewport && meta.themeColorMedia.length >= 2 && meta.themeColorMedia.every(Boolean) && meta.manifest && meta.appleTouch
  rec('UX-04', ok, `viewport=${meta.viewport ? 'ok' : 'missing'} themeColor.media=${JSON.stringify(meta.themeColorMedia)} manifest=${meta.manifest} appleTouch=${meta.appleTouch}`)
  await browser.close()
}

// STB-02: 桌面 1440 无副作用
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 100)))
  await page.goto(`${EDGE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1800)
  const state = await page.evaluate(() => ({
    narrow: document.documentElement.getAttribute('data-dmb-narrow'),
    scrim: (() => { const s = document.querySelector('.dmb-scrim'); return s ? getComputedStyle(s).display : 'missing' })(),
    hint: (() => { const h = document.querySelector('.dmb-rail-hint'); return h ? getComputedStyle(h).display : 'missing' })(),
    overlayAttrs: document.querySelectorAll('[data-dmb-overlay]').length,
    sidebarOpen: document.documentElement.getAttribute('data-dmb-sidebar-open'),
  }))
  const ok = state.narrow === null && state.scrim === 'none' && state.hint === 'none' && state.overlayAttrs === 0 && state.sidebarOpen === null && pageErrors.length === 0
  rec('STB-02', ok, `desktop1440: narrow=${state.narrow} scrim=${state.scrim} hint=${state.hint} overlays=${state.overlayAttrs} errors=${pageErrors.length}`)
  await browser.close()
}

console.log('BATCH4 DONE', JSON.stringify(results.map(r => ({ id: r.id, pass: r.pass }))))
