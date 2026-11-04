// 回归批次2：会话域 SES-01..06（窄屏侧栏/切换/新建/发送流式停止/自动键盘/scrim）
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve('.')
const { chromium } = await import('file:///D:/Hermes/hermes-agent/node_modules/playwright/index.mjs')
const results = []
const rec = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const d = JSON.parse(fs.readFileSync(path.join(root, 'baseline3/.device.json'), 'utf8'))

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' })
await ctx.addCookies(d.cookies.map(c => ({ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' })))
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 120)))
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1800)

const snap = () => page.evaluate(() => {
  const frame = document.querySelector('[class*="_frame"]')
  const rows = [...document.querySelectorAll('[class*="_sessionRow"]')].filter(n => { const b = n.getBoundingClientRect(); return b.height > 0 && b.y > 0 && b.y < 740 })
  return {
    collapsed: frame ? frame.hasAttribute('data-sidebar-collapsed') : null,
    open: document.documentElement.getAttribute('data-dmb-sidebar-open'),
    scrim: getComputedStyle(document.querySelector('.dmb-scrim')).display,
    visibleRows: rows.length,
  }
})
const openSidebar = async () => { await page.mouse.click(26, 25); await page.waitForTimeout(900) }

// SES-01: 初始收起 → 点开 → 浮层 + scrim；点 scrim 收起
{
  const s0 = await snap()
  await openSidebar()
  const s1 = await snap()
  await page.mouse.click(350, 400); await page.waitForTimeout(900)
  const s2 = await snap()
  const pass = s0.collapsed === true && s0.scrim === 'none' && s1.open === '1' && s1.scrim === 'block' && s2.collapsed === true && s2.scrim === 'none'
  rec('SES-01', pass, `initial(collapsed=${s0.collapsed},scrim=${s0.scrim}) → open(open=${s1.open},scrim=${s1.scrim}) → scrimTap(collapsed=${s2.collapsed},scrim=${s2.scrim})`)
}

// SES-02: 切换会话
{
  await openSidebar()
  const target = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"]')].filter(n => { const b = n.getBoundingClientRect(); return b.height > 0 && b.y > 0 && b.y < 740 })
    const x = rows.find(n => (n.textContent || '').includes('定时任务'))
    if (!x) return null
    const b = x.getBoundingClientRect()
    return { y: Math.round(b.y + b.height / 2) }
  })
  if (target) {
    await page.mouse.click(140, target.y)
    await page.waitForTimeout(1500)
  }
  const st = await page.evaluate(() => ({
    header: (() => { const h = document.querySelector('[class*="_titleRow"]'); return h ? (h.textContent || '').slice(0, 14) : null })(),
    collapsed: document.querySelector('[class*="_frame"]').hasAttribute('data-sidebar-collapsed'),
  }))
  rec('SES-02', target !== null && st.header && st.header.includes('定时任务') && st.collapsed, `tap session row → header="${st.header}" sidebarCollapsed=${st.collapsed}`)
}

// SES-03: 新建会话
{
  await openSidebar()
  const btn = await page.evaluate(() => {
    const b = document.querySelector('[class*="_newSession"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (btn) { await page.mouse.click(btn.x, btn.y); await page.waitForTimeout(1200) }
  const st = await page.evaluate(() => {
    const h = document.querySelector('[class*="_titleRow"]')
    return { header: h ? (h.textContent || '').slice(0, 20) : '(no title)', composer: !!document.querySelector('[data-composer-input="true"]') }
  })
  rec('SES-03', btn !== null && st.composer, `newSession btn at (${btn ? btn.x + ',' + btn.y : 'n/a'}) → header="${st.header}" composer=${st.composer}`)
}

// SES-04: 发送 → 流式 → 停止
{
  const sent = await page.evaluate(() => {
    const el = document.querySelector('[data-composer-input="true"]')
    if (!el) return false
    el.focus()
    document.execCommand('insertText', false, '回归测试：请回复一个字')
    return true
  })
  await page.waitForTimeout(400)
  // 找发送键（composer 附近的最后一个 button，或 aria-label 发送）
  const send = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label]')].find(x => /发送|send/i.test(x.getAttribute('aria-label') ?? ''))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: b.disabled }
  })
  let streaming = false, stopped = false
  if (send && !send.disabled) {
    await page.mouse.click(send.x, send.y)
    await page.waitForTimeout(2500)
    streaming = await page.evaluate(() => !!document.querySelector('[class*="_stop"], button[aria-label*="停止"], button[aria-label*="stop" i]'))
    if (streaming) {
      const stop = await page.evaluate(() => {
        const b = document.querySelector('button[aria-label*="停止"], button[aria-label*="stop" i], [class*="_stop"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (stop) { await page.mouse.click(stop.x, stop.y); await page.waitForTimeout(1000); stopped = true }
    }
  }
  const finalState = await page.evaluate(() => ({ composer: !!document.querySelector('[data-composer-input="true"]') }))
  rec('SES-04', sent && send !== null && finalState.composer, `sent=${sent} sendBtn=${send ? 'found(disabled=' + send.disabled + ')' : 'missing'} stopBtnSeen=${streaming} stopped=${stopped} composerAfter=${finalState.composer}`)
}

// SES-05: 点会话不自动聚焦输入框
{
  await openSidebar()
  const focusedBefore = await page.evaluate(() => document.activeElement === document.querySelector('[data-composer-input="true"]'))
  const target = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"]')].filter(n => { const b = n.getBoundingClientRect(); return b.height > 0 && b.y > 0 && b.y < 740 })
    const x = rows[0]
    if (!x) return null
    const b = x.getBoundingClientRect()
    return { y: Math.round(b.y + b.height / 2) }
  })
  if (target) { await page.mouse.click(140, target.y); await page.waitForTimeout(1200) }
  const focusedAfter = await page.evaluate(() => document.activeElement === document.querySelector('[data-composer-input="true"]'))
  rec('SES-05', focusedBefore === false && focusedAfter === false, `composer focused before=${focusedBefore} after session pick=${focusedAfter}`)
}

// SES-06: 主内容点击 no-op（不引起侧栏变化/无遮罩残留）
{
  const s0 = await snap()
  await page.mouse.click(180, 400); await page.waitForTimeout(700)
  const s1 = await snap()
  // 命中检查：中央应命中真实内容而非遮罩
  const hit = await page.evaluate(() => { const el = document.elementFromPoint(180, 400); return el ? el.tagName + ':' + String(el.className ?? '').slice(0, 30) : null })
  rec('SES-06', s0.collapsed === s1.collapsed && s1.scrim === 'none' && hit && !hit.includes('dmb-scrim'), `collapsed ${s0.collapsed}→${s1.collapsed} scrim=${s1.scrim} hit@center=${hit}`)
}

rec('STB-03-partial', pageErrors.length === 0, `pageErrors=${pageErrors.length}${pageErrors.length ? ' :: ' + pageErrors[0] : ''}`)
await page.screenshot({ path: 'baseline3/reg4-batch2-final.png' })
await browser.close()
console.log('BATCH2 DONE', JSON.stringify(results.map(r => ({ id: r.id, pass: r.pass }))))
