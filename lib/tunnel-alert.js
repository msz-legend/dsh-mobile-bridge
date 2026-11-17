/**
 * 隧道持续失败推送告警（#10）。
 *
 * 背景：隧道（cloudflared/frpc）断掉后手机会静默失联 —— 用户在手机上只会看到
 * 「连接已中断」，但不知道要去电脑上处理。此告警器轮询隧道 status()，把
 * 「持续失败」主动推到已配置的外部通道（ntfy/Bark/企微/飞书/钉钉/Telegram…）。
 *
 * 触发条件（二者其一）：
 *  1. running 从 true → false（进程退出且未在重启窗口恢复）；
 *  2. lastError 变化（健康检查失败 / 异常退出，新错误才提醒）。
 * 节流：同一原因 10 分钟内最多提醒一次，避免重启风暴刷屏。
 *
 * fire-and-forget：notify.dispatch 自带兜底（绝不 throw），失败只记日志。
 */

const DEFAULT_POLL_MS = 30_000
const DEFAULT_THROTTLE_MS = 10 * 60_000

export function createTunnelAlert({
  tunnel,
  notify,
  log,
  pollMs = DEFAULT_POLL_MS,
  throttleMs = DEFAULT_THROTTLE_MS,
  now = Date.now,
} = {}) {
  let timer = undefined
  let lastRunning
  let lastErrorSignature = ''
  let lastNotifiedAt = 0
  let lastNotifiedSignature = ''
  let stopped = false
  let alertsSent = 0

  const signatureOf = (status) =>
    `${status?.running === true ? 'up' : 'down'}|${String(status?.lastError ?? '')}`

  const dispatch = (title, body) => {
    alertsSent += 1
    try {
      void Promise.resolve(
        notify?.dispatch?.({ title, body, path: '/' }),
      )?.catch?.(() => undefined)
    } catch {
      /* notify 不可用时静默跳过 */
    }
  }

  const maybeNotify = (status, reason, detail) => {
    if (stopped) return
    if (notify === undefined || typeof notify.dispatch !== 'function') return
    const signature = signatureOf(status)
    // 节流：同签名 10 分钟内只发一次（不同原因立即提醒，不受上一条影响）。
    if (signature === lastNotifiedSignature && now() - lastNotifiedAt < throttleMs) return
    lastNotifiedSignature = signature
    lastNotifiedAt = now()
    dispatch(
      `手机分身隧道${reason}`,
      `${detail}\n手机当前可能无法连接桌面端，请在电脑上检查「设置 → 手机分身 → 公网隧道」。`,
    )
  }

  const check = () => {
    if (stopped) return
    let status
    try {
      status = tunnel?.status?.()
    } catch (error) {
      log?.('tunnel-alert status error:', error?.message ?? error)
      return
    }
    if (status === undefined || status === null) return
    const running = status.running === true
    const lastError = typeof status.lastError === 'string' ? status.lastError : ''

    // 进程从运行态掉线（含健康检查达限被 kill）：立即提醒（由节流去重抖动）。
    if (lastRunning === true && running === false) {
      maybeNotify(status, '已断开', lastError !== '' ? lastError : '隧道进程已退出且未恢复。')
    } else if (running === false && lastError !== '') {
      // 未运行且带错误（启动失败 / 健康检查失败累积）：持续失败期间按节流窗口重复提醒，
      // 新错误签名立即提醒（不同签名不受上一条节流影响）。
      maybeNotify(status, '持续失败', lastError)
    }
    lastRunning = running
    lastErrorSignature = lastError
  }

  const start = () => {
    if (timer !== undefined || stopped) return
    timer = setInterval(check, pollMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return { start, stop, check, get alertsSent() { return alertsSent } }
}
