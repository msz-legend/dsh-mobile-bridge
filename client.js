/**
 * dsh-mobile-bridge — 浏览器半身。
 *
 * 只做一件事：把宿主推来的审批请求渲染成一张可操作的卡片，并把决策 POST 回去。
 *
 * 为什么用 shell.overlay（帧级底部抽屉）而不是像内置 ui-approval 那样接管
 * composer：接管 composer 会同时吃掉输入框和「停止」按钮，而审批期间用户仍可能
 * 需要停止；浮层不随滚动丢失，也不受会话视图切换影响，断线重连后可按 requestId 重建。
 *
 * 只依赖浏览器模块表里的 react，不引入任何额外运行时。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const BASE = '/plugins/dsh-mobile-bridge'
    const STYLE_ID = 'dsh-mobile-bridge-approval'
    const LANG = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
    const ZH = LANG.indexOf('zh') === 0
    const T = {
      title: ZH ? '工具审批' : 'Tool approval',
      waiting: ZH ? '等待你的决定' : 'Waiting for your decision',
      once: ZH ? '仅本次' : 'Allow once',
      always: ZH ? '始终允许' : 'Always allow',
      reject: ZH ? '拒绝' : 'Reject',
      timeout: ZH ? '已超时 —— 默认拒绝' : 'Timed out — rejected by default',
      remember: ZH ? '将记住：' : 'Will remember:',
      high: ZH ? '高风险' : 'High risk',
      normal: ZH ? '需要确认' : 'Needs confirmation',
      argsUnknown: ZH ? '（参数不可得，仅按工具名记忆）' : '(args unavailable; remembers tool only)',
      seconds: ZH ? '秒' : 's',
    }

    const CSS = `
.dmb-overlay{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;
  padding:0 10px calc(10px + env(safe-area-inset-bottom)) 10px;pointer-events:none}
.dmb-card{pointer-events:auto;width:100%;max-width:560px;background:var(--dsw-specific-input-major,#fff);
  color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-state-warn-secondary,#e0b44a);
  border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.dmb-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--dsw-alias-state-warn-tertiary,#fff7e6);
  color:var(--dsw-alias-state-warn-primary,#8a5a00);font-size:13px}
.dmb-dot{width:8px;height:8px;border-radius:50%;background:#e0a526}
.dmb-body{padding:12px 14px 0;max-height:42vh;overflow:auto}
.dmb-tool{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmb-badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:#fff1f2;color:#be123c;border:1px solid #fecdd3}
.dmb-badge.normal{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
.dmb-sum{margin-top:8px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
  color:var(--dsw-alias-label-tertiary,#555);background:rgba(127,127,127,.08);border-radius:8px;padding:8px 10px;max-height:22vh;overflow:auto}
.dmb-pattern{margin-top:8px;font-size:12px;color:#0f766e;background:rgba(13,148,136,.1);border-radius:8px;padding:6px 10px;word-break:break-all}
.dmb-foot{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-wrap:wrap}
.dmb-timer{margin-right:auto;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-tertiary,#666)}
.dmb-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:10px;
  padding:9px 14px;font-size:14px;font-weight:600;min-height:40px;cursor:pointer}
.dmb-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.dmb-btn.danger{color:#b91c1c;border-color:#fca5a5}
.dmb-btn[disabled]{opacity:.5;cursor:default}
@media (max-width:480px){.dmb-foot{gap:6px}.dmb-btn{flex:1 1 auto;padding:9px 10px}}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-mobile-bridge="' + STYLE_ID + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.dshMobileBridge = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function postDecision(requestId, decision) {
      try {
        return fetch(BASE + '/decision', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, decision }),
        })
      } catch (error) {
        return Promise.reject(error)
      }
    }

    function useApprovalFeed() {
      const [items, setItems] = react.useState([])
      react.useEffect(() => {
        if (typeof EventSource === 'undefined') return undefined
        let source
        let closed = false
        let retry

        const connect = () => {
          if (closed) return
          try {
            source = new EventSource(BASE + '/events', { withCredentials: true })
          } catch {
            retry = setTimeout(connect, 3000)
            return
          }
          source.onmessage = (event) => {
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message.type === 'approval' && message.request) {
              const request = message.request
              setItems((previous) =>
                previous.some((entry) => entry.requestId === request.requestId) ? previous : [...previous, request],
              )
            } else if (message.type === 'approval-resolved') {
              setItems((previous) => previous.filter((entry) => entry.requestId !== message.requestId))
            }
          }
          source.onerror = () => {
            try {
              source.close()
            } catch {
              /* ignore */
            }
            if (!closed) retry = setTimeout(connect, 3000)
          }
        }

        connect()
        return () => {
          closed = true
          if (retry !== undefined) clearTimeout(retry)
          try {
            source?.close()
          } catch {
            /* ignore */
          }
        }
      }, [])
      return [items, setItems]
    }

    function useCountdown(expiresAt) {
      const [left, setLeft] = react.useState(() => Math.max(0, Number(expiresAt ?? 0) - Date.now()))
      react.useEffect(() => {
        const tick = () => setLeft(Math.max(0, Number(expiresAt ?? 0) - Date.now()))
        tick()
        const timer = setInterval(tick, 500)
        return () => clearInterval(timer)
      }, [expiresAt])
      return left
    }

    function Card(props) {
      const { request, onDecide } = props
      const [busy, setBusy] = react.useState(false)
      const remaining = useCountdown(request.expiresAt)
      const expired = remaining <= 0
      const seconds = Math.ceil(remaining / 1000)
      const high = request.risk === 'high'

      const decide = (decision) => {
        if (busy || expired) return
        setBusy(true)
        onDecide(request.requestId, decision).finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'dmb-overlay' },
        h(
          'div',
          { className: 'dmb-card', role: 'dialog', 'aria-label': T.title },
          h(
            'div',
            { className: 'dmb-head' },
            h('span', { className: 'dmb-dot' }),
            expired ? T.timeout : T.waiting,
          ),
          h(
            'div',
            { className: 'dmb-body' },
            h(
              'div',
              { className: 'dmb-tool' },
              request.toolName || 'tool',
              h('span', { className: 'dmb-badge' + (high ? '' : ' normal') }, high ? T.high : T.normal),
            ),
            request.summary ? h('div', { className: 'dmb-sum' }, request.summary) : null,
            request.pattern
              ? h('div', { className: 'dmb-pattern' }, T.remember + ' ' + request.pattern.label)
              : null,
            request.argsRecognized === false
              ? h('div', { className: 'dmb-pattern' }, T.argsUnknown)
              : null,
          ),
          h(
            'div',
            { className: 'dmb-foot' },
            h('span', { className: 'dmb-timer' }, expired ? T.timeout : seconds + T.seconds),
            h(
              'button',
              { className: 'dmb-btn danger', disabled: busy || expired, onClick: () => decide('reject'), type: 'button' },
              T.reject,
            ),
            h(
              'button',
              { className: 'dmb-btn', disabled: busy || expired, onClick: () => decide('always'), type: 'button' },
              T.always,
            ),
            h(
              'button',
              { className: 'dmb-btn primary', disabled: busy || expired, onClick: () => decide('once'), type: 'button' },
              T.once,
            ),
          ),
        ),
      )
    }

    function ApprovalOverlay() {
      ensureStyle()
      const [items, setItems] = useApprovalFeed()
      if (items.length === 0) return null
      const request = items[0]

      const onDecide = (requestId, decision) => {
        setItems((previous) => previous.filter((entry) => entry.requestId !== requestId))
        return postDecision(requestId, decision).catch(() => undefined)
      }

      return h(Card, { request, onDecide })
    }

    function sendHello(note) {
      try {
        fetch(BASE + '/client-hello', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note, href: String(location.href).slice(0, 200) }),
        }).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return
      // 先回执再注册：这样即使 slot 注册失败，宿主也能观测到「半身确实执行到了哪一步」。
      const slots = ctx?.slots ?? (typeof ctx?.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || slots === null) {
        sendHello('no-slots-service')
        return
      }
      try {
        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-mobile-bridge-approval',
              order: 900,
              label: () => T.title,
            },
            ApprovalOverlay,
          ),
        )
        sendHello('registered')
      } catch (error) {
        sendHello(`register-failed:${String(error?.message ?? error).slice(0, 120)}`)
      }
    }

    exports.apply = apply
    // 模块级 inject 是**服务键**（不是包名）：loader 据此在 activate 前把服务准备好。
    // 缺了它会表现为「entry did not activate」并阻塞整页 —— 这是实测踩过的坑。
    exports.inject = ['slots']
    exports.name = 'dsh-mobile-bridge'
    return module.exports
  },
})
