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
    // 官方 client-ui-* 包同款：宿主模块表提供 react-dom。
    // 卡片必须 portal 到 body —— position:fixed 在带 transform 的宿主容器里会被
    // 劫持 containing-block，真机（360dp）上卡片右半被裁出屏幕（实测踩过）。
    let reactDom = undefined
    try {
      reactDom = require('react-dom')
    } catch {
      /* 老宿主没有 react-dom 时退化为原位渲染 */
    }

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
      settingsTitle: ZH ? '手机桥接' : 'Mobile Bridge',
      paired: ZH ? '已配对设备' : 'Paired devices',
      online: ZH ? '在线' : 'online',
      pending: ZH ? '待审批' : 'Pending approvals',
      rules: ZH ? 'always 规则' : 'Always rules',
      timeout: ZH ? '审批超时' : 'Approval timeout',
      address: ZH ? '访问地址' : 'Access URL',
      pairCode: ZH ? '生成配对码' : 'New pairing code',
      pairHint: ZH ? '用手机扫描二维码，或打开地址后输入配对码。' : 'Scan the QR code, or open the URL and enter the code.',
      desktopOnly: ZH ? '仅在桌面端（本机）可生成配对码。' : 'Pairing codes can only be created on the desktop.',
      clientLoaded: ZH ? '手机端已加载' : 'Client half loaded',
      refresh: ZH ? '刷新' : 'Refresh',
      tunnel: ZH ? '公网隧道' : 'Tunnel',
      tunnelStarting: ZH ? '启动中…' : 'starting…',
      tunnelDown: ZH ? '未运行' : 'not running',
      pairRequestTitle: ZH ? '配对请求' : 'Pairing request',
      pairRequestBody: ZH ? '有一台设备通过配对码请求接入。' : 'A device is asking to pair with a valid code.',
      pairFrom: ZH ? '来源' : 'from',
      allow: ZH ? '允许' : 'Allow',
      allowedText: ZH ? '已允许，等待手机进入…' : 'Allowed — waiting for the phone…',
      deniedText: ZH ? '已拒绝。' : 'Denied.',
      close: ZH ? '关闭' : 'Close',
      openFullscreen: ZH ? '全屏查看' : 'Full screen',
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
.dmb-settings{padding:16px;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;width:100%;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;overflow:auto;max-height:100%;-webkit-overflow-scrolling:touch}
.dmb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,120px),1fr));gap:10px;margin:12px 0}
.dmb-cell{border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:10px 12px;background:rgba(127,127,127,.05);min-width:0;overflow-wrap:anywhere}
.dmb-cell b{display:block;font-size:19px;line-height:1.2;margin-top:2px;word-break:break-word}
.dmb-muted{color:var(--dsw-alias-label-tertiary,#666);font-size:12px;overflow-wrap:anywhere}
.dmb-addr{word-break:break-all;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,Consolas,monospace;background:rgba(127,127,127,.08);padding:8px 10px;border-radius:8px;margin:8px 0;max-width:100%;box-sizing:border-box}
.dmb-qr{display:block;width:100%;max-width:220px;margin:10px auto;border-radius:10px;background:#fff;padding:6px;box-sizing:border-box}
.dmb-settings .dmb-btn{margin-top:8px;width:100%;max-width:100%;box-sizing:border-box}
/* 窄屏全屏接管：宿主设置抽屉在 360dp 下把内容区压到 ~124px，插件入口改为 fixed 全屏层。
   只在「用户主动点悬浮按钮展开」时出现，默认不遮挡宿主设置页。 */
.dmb-fab{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147482000;
  display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:10px 16px;
  background:#2563eb;color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  box-shadow:0 8px 24px rgba(37,99,235,.42);cursor:pointer;max-width:calc(100vw - 28px)}
.dmb-sheet{position:fixed;inset:0;z-index:2147482100;background:var(--dsw-specific-input-major,#fff);
  color:var(--dsw-alias-label-primary,#111);display:flex;flex-direction:column;
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.dmb-sheet-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;
  border-bottom:1px solid rgba(127,127,127,.22)}
.dmb-sheet-title{font-weight:600;font-size:15px;margin-right:auto}
.dmb-sheet-close{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:10px;
  min-width:40px;min-height:40px;padding:0 12px;font-size:13px;font-weight:600;cursor:pointer}
.dmb-sheet-body{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.dmb-sheet-body .dmb-settings{max-width:720px;margin:0 auto}
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
      const [pairRequests, setPairRequests] = react.useState([])
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
            } else if (message.type === 'pair-request' && message.confirmId) {
              // broadcastLoopback 只发桌面；手机不会收到配对请求卡片
              setPairRequests((previous) =>
                previous.some((entry) => entry.confirmId === message.confirmId)
                  ? previous
                  : [...previous, message],
              )
            } else if (message.type === 'pair-request-resolved') {
              setPairRequests((previous) => previous.filter((entry) => entry.confirmId !== message.confirmId))
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
      return [items, setItems, pairRequests]
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

    /** 桌面确认卡：非 loopback 来源的手机配对需要人在电脑前点允许（/devices/confirm 仅 loopback 可达）。 */
    function PairCard(props) {
      const { request } = props
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(undefined)

      const resolve = (decision) => {
        if (busy) return
        setBusy(true)
        fetch(BASE + '/devices/confirm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmId: request.confirmId, decision }),
        })
          .then((response) => response.json().catch(() => ({})))
          .then((json) => {
            if (decision === 'allow') setNote(json?.ok === true ? T.allowedText : `${T.pairRequestTitle}: limit`)
            else setNote(T.deniedText)
          })
          .catch(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'dmb-overlay' },
        h(
          'div',
          { className: 'dmb-card', role: 'dialog', 'aria-label': T.pairRequestTitle },
          h(
            'div',
            { className: 'dmb-head' },
            h('span', { className: 'dmb-dot' }),
            T.pairRequestTitle,
          ),
          h(
            'div',
            { className: 'dmb-body' },
            h('div', { className: 'dmb-tool' }, request.name || 'phone'),
            h('div', { className: 'dmb-sum' }, `${T.pairRequestBody}\n${T.pairFrom}: ${request.source || '—'}`),
            note ? h('div', { className: 'dmb-pattern' }, note) : null,
          ),
          h(
            'div',
            { className: 'dmb-foot' },
            h('span', { className: 'dmb-timer' }),
            h(
              'button',
              { className: 'dmb-btn danger', disabled: busy, onClick: () => resolve('deny'), type: 'button' },
              T.reject,
            ),
            h(
              'button',
              { className: 'dmb-btn primary', disabled: busy, onClick: () => resolve('allow'), type: 'button' },
              T.allow,
            ),
          ),
        ),
      )
    }

    function ApprovalOverlay() {
      ensureStyle()
      const [items, setItems, pairRequests] = useApprovalFeed()
      let tree = null
      if (items.length > 0) {
        const request = items[0]
        const onDecide = (requestId, decision) => {
          setItems((previous) => previous.filter((entry) => entry.requestId !== requestId))
          return postDecision(requestId, decision).catch(() => undefined)
        }
        tree = h(Card, { request, onDecide })
      } else if (pairRequests.length > 0) {
        tree = h(PairCard, { request: pairRequests[0] })
      }
      if (tree === null) return null
      return reactDom ? reactDom.createPortal(tree, document.body) : tree
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

    function useOverview() {
      const [data, setData] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(BASE + '/overview', { credentials: 'same-origin' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((json) => {
              if (alive && json) setData(json)
            })
            .catch(() => undefined)
        }
        load()
        const timer = setInterval(load, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return data
    }

    function Cell(props) {
      return h('div', { className: 'dmb-cell' }, props.label, h('b', null, props.value))
    }

    /** 插件详情里的设置页：回答「手机桥接现在是什么状态、怎么再配一台」。 */
    function SettingsPanel() {
      ensureStyle()
      const data = useOverview()
      const [pairing, setPairing] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)

      const requestCode = () => {
        if (busy) return
        setBusy(true)
        fetch(BASE + '/pairing.json', { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((json) => setPairing(json))
          .catch(() => undefined)
          .finally(() => setBusy(false))
      }

      const desktop = data?.loopback === true
      const timeoutText =
        data?.timeout === undefined
          ? '—'
          : `${Math.round(data.timeout.local / 1000)}s / ${Math.round(data.timeout.remote / 1000)}s`

      return h(
        'div',
        { className: 'dmb-settings' },
        h('div', { className: 'dmb-muted' }, T.address),
        h('div', { className: 'dmb-addr' }, data?.publicBase ?? '—'),
        data?.tunnel?.enabled === true
          ? h(
              'div',
              { className: 'dmb-muted' },
              `${T.tunnel} · ${
                data.tunnel.running === true ? data.tunnel.url || T.tunnelStarting : T.tunnelDown
              }`,
            )
          : null,
        h(
          'div',
          { className: 'dmb-grid' },
          h(Cell, { label: T.paired, value: data === undefined ? '—' : `${data.devices.total}/${data.maxDevices}` }),
          h(Cell, { label: T.online, value: data === undefined ? '—' : String(data.devices.online) }),
          h(Cell, { label: T.pending, value: data === undefined ? '—' : String(data.pendingApprovals) }),
          h(Cell, { label: T.rules, value: data === undefined ? '—' : String(data.alwaysRules) }),
          h(Cell, { label: T.timeout, value: timeoutText }),
          h(Cell, { label: T.clientLoaded, value: data === undefined ? '—' : String(data.clientHalf) }),
        ),
        desktop
          ? h(
              'div',
              null,
              h(
                'button',
                { type: 'button', className: 'dmb-btn primary', onClick: requestCode, disabled: busy },
                T.pairCode,
              ),
              pairing?.code
                ? h(
                    'div',
                    null,
                    h('div', { className: 'dmb-muted' }, T.pairHint),
                    pairing.qrDataUrl
                      ? h('img', { className: 'dmb-qr', src: pairing.qrDataUrl, alt: T.pairCode })
                      : null,
                    h('div', { className: 'dmb-addr' }, `${pairing.publicBase ?? ''}`),
                    h('div', { className: 'dmb-addr' }, pairing.code),
                  )
                : null,
            )
          : h('div', { className: 'dmb-muted' }, T.desktopOnly),
      )
    }

    /**
     * 窄屏全屏接管入口。
     *
     * 宿主设置抽屉（.AnXs9G_panel）在 360dp 手机视口下只给内容区约 124px，
     * 插件面板再怎么自适应也读不清（实测 rect 宽 76px）。这里在设置页内挂一个
     * 悬浮按钮，点开把同一份 SettingsPanel 以 fixed 全屏 sheet 渲染到 body，
     * 彻底绕开宿主容器宽度限制；宿主抽屉本身不受影响，关掉 sheet 就回到原状。
     */
    function SettingsLauncher() {
      ensureStyle()
      const [open, setOpen] = react.useState(false)

      react.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = previous
        }
      }, [open])

      const sheet = open
        ? h(
            'div',
            { className: 'dmb-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': T.settingsTitle },
            h(
              'div',
              { className: 'dmb-sheet-head' },
              h('span', { className: 'dmb-sheet-title' }, T.settingsTitle),
              h(
                'button',
                { type: 'button', className: 'dmb-sheet-close', onClick: () => setOpen(false) },
                T.close,
              ),
            ),
            h('div', { className: 'dmb-sheet-body' }, h(SettingsPanel, null)),
          )
        : null

      return h(
        react.Fragment,
        null,
        h(
          'button',
          { type: 'button', className: 'dmb-fab', onClick: () => setOpen(true) },
          T.openFullscreen,
        ),
        sheet !== null && reactDom ? reactDom.createPortal(sheet, document.body) : sheet,
      )
    }

    /** 注册到 settings.section 的组件：抽屉内渲染概览，窄屏额外给一个全屏入口。 */
    function SettingsLaunchPanel() {
      ensureStyle()
      const [narrow, setNarrow] = react.useState(
        () => typeof window !== 'undefined' && window.innerWidth < 520,
      )
      react.useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onResize = () => setNarrow(window.innerWidth < 520)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])
      return h(
        react.Fragment,
        null,
        h(SettingsPanel, null),
        narrow ? h(SettingsLauncher, null) : null,
      )
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return
      // 先回执再注册：这样即使 slot 注册失败，宿主也能观测到「半身确实执行到了哪一步」。
      const slots = ctx?.slots ?? (typeof ctx?.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || slots === null) {
        sendHello('no-slots-service')
        return
      }
      const registrations = [
        ['shell.overlay', { name: 'shell.overlay', id: 'dsh-mobile-bridge-approval', order: 900, label: () => T.title }, ApprovalOverlay],
        ['settings.section', { name: 'settings.section', id: 'dsh-mobile-bridge', order: 120, label: () => T.settingsTitle }, SettingsLaunchPanel],
      ]
      const failed = []
      for (const [slotName, options, Component] of registrations) {
        try {
          slots.inject(slotName, () => slots.register(options, Component))
        } catch (error) {
          failed.push(`${slotName}:${String(error?.message ?? error).slice(0, 60)}`)
        }
      }
      sendHello(failed.length === 0 ? 'registered' : `partial:${failed.join(';')}`)
    }

    exports.apply = apply
    // 模块级 inject 是**服务键**（不是包名）：loader 据此在 activate 前把服务准备好。
    // 缺了它会表现为「entry did not activate」并阻塞整页 —— 这是实测踩过的坑。
    exports.inject = ['slots']
    exports.name = 'dsh-mobile-bridge'
    return module.exports
  },
})
