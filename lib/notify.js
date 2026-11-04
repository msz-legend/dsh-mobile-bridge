/**
 * 审批系统通知：Service Worker 脚本文本生成（零依赖）。
 *
 * 为什么需要 SW：Android Chrome 禁止页面直接 new Notification()（会抛
 * TypeError: Failed to construct 'Notification'），通知必须经
 * SW registration.showNotification() 发出；iOS 16.4+ 的网页通知同样要求
 * 添加到主屏幕的 PWA + SW。routes.js 以 GET BASE/sw.js 分发这份文本。
 *
 * SW 职责只有两件：
 *   1. 被 registration.showNotification() 用（无需 push 订阅，纯本地通知）；
 *   2. 点击通知 → 聚焦已开的桥接页，没有才开新窗口。
 * SW 不缓存任何资源、不拦截任何 fetch —— 对桥接页面零影响。
 */

/** 生成 sw.js 文本。routeBase 仅用于点击通知时的 fallback 打开路径。 */
export function serviceWorkerScript(routeBase) {
  const fallback = String(routeBase || '/').replace(/\\/g, '/')
  return `/* dsh-mobile-bridge notification SW (generated; do not cache) */
const FALLBACK_URL = ${JSON.stringify(fallback)}
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
// L1：页面经 registration.showNotification() 发的本地通知（点击聚焦）。
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      if (client.url && new URL(client.url).origin === self.location.origin) {
        await client.focus()
        try { client.postMessage({ type: 'dmb-notification-clicked' }) } catch {}
        return
      }
    }
    try { await self.clients.openWindow(FALLBACK_URL) } catch {}
  })())
})
// L2：桌面端 Web Push（页面完全关闭也能收到）。
// payload = JSON { title, body, url }；解析失败时退化为通用文案。
self.addEventListener('push', (event) => {
  let title = 'DSH'
  let body = ''
  let url = FALLBACK_URL
  try {
    const payload = event.data ? event.data.json() : {}
    if (typeof payload.title === 'string' && payload.title !== '') title = payload.title
    if (typeof payload.body === 'string') body = payload.body
    if (typeof payload.url === 'string' && payload.url !== '') url = payload.url
  } catch {}
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: 'dmb-push',
    requireInteraction: true,
    data: { url },
  }))
})
`
}
