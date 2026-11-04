// 回归批次3：审批域 APR-01..04（SSE 注入模拟，沿用 R3 已验证方法）+ 设置域 SET-01..04
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve('.')
const { chromium } = await import('file:///D:/Hermes/hermes-agent/node_modules/playwright/index.mjs')
const results = []
const rec = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const d = JSON.parse(fs.readFileSync(path.join(root, 'baseline3/.device.json'), 'utf8'))
const EDGE = 'http://127.0.0.1:8787'

// ---------- APR-01..04 ----------
const mkBody = () => [
  `data: ${JSON.stringify({ type: 'approval', request: { requestId: 'reg4-once-1', toolName: 'pwsh', summary: 'rm -rf ./build（回归模拟数据，非真实指令）', risk: 'high', argsKnown: true, argsRecognized: true, pattern: { label: '本会话内所有 `npm test`' }, origin: 'remote', timeoutMs: 60000, expiresAt: Date.now() + 60000 } })}`,
  '',
  `data: ${JSON.stringify({ type: 'approval', request: { requestId: 'reg4-expired-1', toolName: 'read_file', summary: '读取 config.json（过期模拟）', risk: 'normal', argsKnown: false, argsRecognized: false, origin: 'local', timeoutMs: 30000, expiresAt: Date.now() - 1000 } })}`,
  '',
].join('\n')

{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' })
  await context.addCookies(d.cookies.map(c => ({ ...c, url: EDGE })))
  const decisions = []
  await context.route('**/plugins/dsh-mobile-bridge/events*', route => route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-store' }, body: mkBody() }))
  const page = await context.newPage()
  page.on('request', req => { if (req.url().includes('/decision') && req.method() === 'POST') decisions.push(req.postData()) })
  await page.goto(`${EDGE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2000)
  let cardVisible = false
  try { await page.locator('.dmb-card').first().waitFor({ state: 'visible', timeout: 8000 }); cardVisible = true } catch {}
  // APR-01: 卡片结构
  const struct = await page.evaluate(() => [...document.querySelectorAll('.dmb-card')].map(card => ({
    head: card.querySelector('.dmb-head')?.innerText ?? '',
    tool: card.querySelector('.dmb-tool')?.innerText ?? '',
    timer: card.querySelector('.dmb-timer')?.innerText ?? '',
    pattern: card.querySelector('.dmb-pattern')?.innerText ?? '',
    buttons: [...card.querySelectorAll('button')].map(b => (b.innerText || '').trim()),
  })))
  const once = struct.find(s => s.buttons.some(b => /仅本次/.test(b)))
  rec('APR-01', cardVisible && !!once, `cards=${struct.length} head=${struct[0]?.head ?? 'n/a'} buttons=${JSON.stringify(struct[0]?.buttons ?? [])}`)
  // APR-02: once 决策 POST
  let rejectClicked = false
  const rejectBtn = page.locator('.dmb-card button', { hasText: '拒绝' }).first()
  if (await rejectBtn.count() > 0) { await rejectBtn.click().catch(() => {}); rejectClicked = true; await page.waitForTimeout(1200) }
  const decOk = decisions.length > 0 && decisions[0].includes('reg4-once-1')
  rec('APR-02', decOk && rejectClicked, `rejectClicked=${rejectClicked} decisions=${JSON.stringify(decisions)}`)
  // APR-04: 过期卡终态（fail-closed 可感知）
  const expiredState = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.dmb-card')]
    const exp = cards.find(c => (c.querySelector('.dmb-timer')?.innerText ?? '').match(/0:00|已过期|超时/) || (c.innerText || '').includes('已过期'))
    return { found: cards.length > 1, expText: exp ? exp.innerText.slice(0, 80) : (cards[1] ? cards[1].innerText.slice(0, 80) : null) }
  })
  rec('APR-04', expiredState.found, `expired card rendered: ${JSON.stringify(expiredState).slice(0, 140)}`)
  await page.screenshot({ path: 'baseline3/reg4-apr.png' })
  await browser.close()
}

// ---------- 设置域 SET-01..03 ----------
{
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' })
  await context.addCookies(d.cookies.map(c => ({ ...c, url: EDGE })))
  const page = await context.newPage()
  await page.goto(`${EDGE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  // SET-01: 账号菜单 → 设置
  const acct = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(x => /账号|account/i.test(x.getAttribute('aria-label') ?? ''))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  let settingsOpen = false
  if (acct) {
    await page.mouse.click(acct.x, acct.y)
    await page.waitForTimeout(800)
    const item = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button,[role="menuitem"],[class*="_options"] *')].find(x => /设置|settings/i.test((x.textContent || '').slice(0, 20)) && x.getBoundingClientRect().height > 0)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    if (item) { await page.mouse.click(item.x, item.y); await page.waitForTimeout(900) }
    settingsOpen = await page.evaluate(() => !!document.querySelector('[data-dmb-settings],[class*="_panel"]'))
  }
  rec('SET-01', settingsOpen, `account=${acct ? acct.x + ',' + acct.y : 'n/a'} settingsOpen=${settingsOpen}`)
  // SET-02: 两级导航
  const nav = await page.evaluate(() => ({
    mode: document.documentElement.getAttribute('data-dmb-mode'),
    hasSettings: !!document.querySelector('[data-dmb-settings]'),
    navItems: [...document.querySelectorAll('[data-dmb-nav] *')].filter(n => n.getBoundingClientRect().height > 0 && (n.textContent || '').trim().length < 20).length,
  }))
  const listMode = nav.hasSettings && nav.navItems > 0
  // 点「手机桥接」进详情
  const bridge = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-dmb-nav] *')].find(x => /手机桥接/.test(x.textContent || '') && x.getBoundingClientRect().height > 0)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  let detailMode = null
  if (bridge) {
    await page.mouse.click(bridge.x, bridge.y)
    await page.waitForTimeout(900)
    detailMode = await page.evaluate(() => ({ mode: document.documentElement.getAttribute('data-dmb-mode'), back: !!document.querySelector('.dmb-nav-back'), bridgeVisible: [...document.querySelectorAll('[data-dmb-content] *')].some(n => /设备管理|配对码/.test(n.textContent || '')) }))
  }
  rec('SET-02', listMode && detailMode !== null && detailMode.mode === 'detail' && detailMode.back, `list: mode=${nav.mode} items=${nav.navItems} → detail: ${JSON.stringify(detailMode)}`)
  await page.screenshot({ path: 'baseline3/reg4-set-detail.png' })
  // SET-03: 设备管理列表
  const dev = await page.evaluate(() => ({
    devices: [...document.querySelectorAll('.dmb-device')].map(el => ({
      name: el.querySelector('.dmb-device-name')?.innerText ?? '',
      status: el.querySelector('.dmb-device-status')?.innerText ?? '',
      hasActions: el.querySelectorAll('button').length > 0,
    })),
  }))
  rec('SET-03', dev.devices.length >= 1 && dev.devices.every(x => x.name && x.status && x.hasActions), `devices=${dev.devices.length} sample=${JSON.stringify(dev.devices[0] ?? null)}`)
  await browser.close()
}

// SET-04: status 接口
{
  const j = await (await fetch('http://127.0.0.1:50491/plugins/dsh-mobile-bridge/status')).json()
  const ok = j.ok === true && Array.isArray(j.devices) && j.config && j.edge.listening === true
  rec('SET-04', ok, `devices=${j.devices.length} online=${(j.online ?? []).length} rules=${(j.rules ?? []).length} edgePort=${j.edge?.port}`)
}
console.log('BATCH3 DONE', JSON.stringify(results.map(r => ({ id: r.id, pass: r.pass }))))
