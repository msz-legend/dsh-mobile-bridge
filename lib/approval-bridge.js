/**
 * 审批桥接模块：
 *   1. 订阅宿主 `approval/request` waterfall（prepend + global）；
 *   2. 把请求序列化后经 SSE 推给手机（及桌面页）；
 *   3. 接收手机决策，通过「在 handler 里 resolve」回传宿主；
 *   4. 自带超时计时，超时 fail closed（`unavailable`）；
 *   5. 维护手机在线/离线，并按会话来源决定「fail closed」还是「交还桌面 UI」；
 *   6. 手机恰好在 SSE 重连间隙时，先给 offlineGraceMs 宽限等设备回来再决定，
 *      避免审批卡片落在断线窗口里被误杀；重连后 replayRequests 补发未决卡片。
 *
 * 关键约束（全部来自实际探测，不是猜测）：
 *   - `{ prepend: true }` 把监听器 unshift 到 hooks 数组最前，与插件激活顺序无关；
 *   - `{ global: true }` 跳过 agent scope 过滤（从 root ctx 注册又要收 agent 请求时是必须项）；
 *   - 宿主词表只有 `allowed-once | rejected | cancelled | unavailable`，
 *     非词表返回值会被归一成 `unavailable`，所以「always」也只能返回 `allowed-once`；
 *   - `approval/asked` / `approval/decided` 是 log-only 审计事件，**绝不**用作应答通道。
 */

const EXECUTE_TOOLS = new Set(['bash', 'pwsh', 'shell', 'terminal', 'run_code', 'subprocess'])
const WRITE_TOOLS = new Set(['write', 'edit', 'delete', 'move', 'apply_patch'])
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'fetch'])

const riskyPath = (args) => {
  if (args === null || typeof args !== 'object') return false
  for (const key of ['path', 'file_path', 'filePath', 'target', 'destination']) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const text = value.replace(/\\/g, '/')
    if (text.startsWith('/') || /^[A-Za-z]:\//.test(text)) return true
    if (text.split('/').includes('..')) return true
  }
  return false
}

export function riskOf(toolName, args) {
  const name = String(toolName ?? '').toLowerCase()
  if (EXECUTE_TOOLS.has(name) || WRITE_TOOLS.has(name)) return 'high'
  if (name === 'present') return 'normal'
  if (NETWORK_TOOLS.has(name)) return 'normal'
  if (riskyPath(args)) return 'high'
  return 'normal'
}

export function summarize(toolName, args) {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args.slice(0, 400)
  if (typeof args !== 'object') return String(args).slice(0, 400)
  const lines = []
  const push = (label, value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const text = value.trim().replace(/\s*\n\s*/g, ' ⏎ ')
    lines.push(`${label} ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`)
  }
  push('command:', args.command ?? args.cmd)
  push('path:', args.path ?? args.file_path ?? args.filePath ?? args.target)
  push('url:', args.url)
  push('query:', args.query ?? args.pattern)
  push('name:', args.name)
  if (lines.length === 0) {
    try {
      const json = JSON.stringify(args)
      return json.length > 400 ? `${json.slice(0, 400)}…` : json
    } catch {
      return ''
    }
  }
  return lines.join('\n')
}

export function createApprovalBridge({ config, hub, always, args, origins, log, now = Date.now, notify }) {
  const pending = new Map()
  let counter = 0

  const newId = () => {
    counter += 1
    return `apr_${counter.toString(36)}_${now().toString(36)}`
  }

  const settle = (entry, outcome) => {
    if (entry.done === true) return false
    entry.done = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    try {
      entry.offAbort?.()
    } catch {
      /* ignore */
    }
    entry.offAbort = undefined
    pending.delete(entry.id)
    entry.resolve(outcome)
    hub.broadcast({ type: 'approval-resolved', requestId: entry.id, outcome })
    return true
  }

  /** 交还桌面：把请求重新委托给后续 answerer（dsh-api-remotes 会转发给桌面 owner 页面）。 */
  const delegate = (entry) => {
    Promise.resolve()
      .then(() => entry.next())
      .then(
        (value) => settle(entry, value),
        (error) => {
          log('delegation failed:', error?.message ?? error)
          settle(entry, 'unavailable')
        },
      )
  }

  /** 手机决策入口。 */
  const decide = ({ requestId, decision, deviceId }) => {
    const entry = pending.get(String(requestId ?? ''))
    if (entry === undefined) return { ok: false, error: 'unknown-request' }
    if (entry.done === true) return { ok: false, error: 'already-settled' }
    if (decision === 'once') {
      settle(entry, 'allowed-once')
      log(`approval ${entry.id} allowed-once by ${deviceId ?? 'desktop'}`)
      return { ok: true, outcome: 'allowed-once' }
    }
    if (decision === 'reject') {
      settle(entry, 'rejected')
      log(`approval ${entry.id} rejected by ${deviceId ?? 'desktop'}`)
      return { ok: true, outcome: 'rejected' }
    }
    if (decision === 'always') {
      const rule = always.add({
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        args: entry.args,
        scope: config.alwaysScope,
      })
      // 对宿主仍然只能返回唯一合法授权值
      settle(entry, 'allowed-once')
      log(`approval ${entry.id} allowed-once + remembered ${rule?.label ?? entry.toolName}`)
      return { ok: true, outcome: 'allowed-once', rule }
    }
    return { ok: false, error: 'bad-decision' }
  }

  /** waterfall 监听器本体。 */
  const handler = (req, next) => {
    const sessionId = req?.agent?.id === undefined ? '' : String(req.agent.id)
    const toolName = String(req?.toolName ?? '')
    const callId = req?.callId === undefined ? '' : String(req.callId)
    const observed = args.take(callId)
    const toolArgs = observed?.args
    const origin = origins.originOf(sessionId)

    // 1) always 规则命中：不再打扰任何人，但对宿主仍返回唯一合法授权值。
    const remembered = always.match(sessionId, toolName, toolArgs)
    if (remembered !== undefined) {
      log(`approval short-circuited by rule "${remembered.label}" (${toolName})`)
      return 'allowed-once'
    }

    // 3) 推给设备并等待（2 的宽限到期后若设备回来了也走这里）。
    const startDeviceFlow = (resolve) => {
      const id = newId()
      const timeoutMs = origin === 'remote' ? config.approvalTimeoutRemoteMs : config.approvalTimeoutMs
      const expiresAt = now() + timeoutMs
      // always 的记忆粒度是「工具名 + 参数指纹」。参数不可识别时明确退化成「仅工具名」，
      // 并把这件事显示在卡片上 —— 不能让用户以为放行范围比实际更窄。
      const recognized = always.fingerprint(toolName, toolArgs)
      const pattern = recognized === undefined
        ? { key: `tool:${toolName}`, label: `${toolName}（仅工具名，参数不可识别）` }
        : { key: recognized.key, label: recognized.label }

      const signal = req?.signal
      if (signal !== undefined && signal.aborted === true) {
        resolve('cancelled')
        return
      }

      const entry = {
        id,
        sessionId,
        toolName,
        callId,
        args: toolArgs,
        origin,
        resolve,
        next,
        done: false,
        timer: undefined,
        offAbort: undefined,
      }

      entry.timer = setTimeout(() => {
        log(`approval ${id} timed out after ${timeoutMs}ms -> unavailable (fail closed)`)
        settle(entry, 'unavailable')
      }, timeoutMs)

      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          log(`approval ${id} cancelled by host signal`)
          settle(entry, 'cancelled')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.offAbort = () => signal.removeEventListener('abort', onAbort)
      }

      const request = {
        requestId: id,
        sessionId,
        sessionTitle: undefined,
        toolName,
        callId,
        reason: req?.reason,
        displayReason: req?.displayReason,
        summary: summarize(toolName, toolArgs),
        risk: riskOf(toolName, toolArgs),
        argsKnown: toolArgs !== undefined,
        argsRecognized: recognized !== undefined,
        pattern,
        origin,
        timeoutMs,
        expiresAt,
        issuedAt: now(),
      }
      entry.request = request
      pending.set(id, entry)
      hub.broadcast({ type: 'approval', request })
      // 全局通知（L2 Web Push + L3 外部通道）：与 SSE 无关，页面关着也能收到。
      // fire-and-forget，绝不阻塞审批流；dispatch 内部自行吞错。
      if (notify !== undefined && typeof notify.dispatch === 'function') {
        void notify.dispatch({
          title: '工具审批',
          body: `有工具调用等待你的审批：${toolName}`,
          path: '/',
        })
      }
    }

    /** 宽限到期仍无设备：远程 fail closed，本地交还桌面。 */
    const finishWithoutDevice = (resolve) => {
      if (origin === 'remote') {
        log(`approval for remote session ${sessionId} failed closed (no paired device online)`)
        resolve('unavailable')
        return
      }
      Promise.resolve()
        .then(() => next())
        .then(resolve, (error) => {
          log('delegation failed:', error?.message ?? error)
          resolve('unavailable')
        })
    }

    // 2) 没有在线设备：先给一个宽限期等手机重连（SSE 断线重连通常在数秒内完成），
    //    避免审批恰好落在重连间隙就被 fail closed / 误交桌面。宽限为 0 时维持旧行为。
    if (!hub.hasOnlineDevice()) {
      const graceMs = config.offlineGraceMs ?? 0
      if (graceMs > 0) {
        log(`no device online; grace ${graceMs}ms for a device to reconnect`)
        return new Promise((resolve) => {
          const signal = req?.signal
          let finished = false
          let timer
          let offOnline = () => {}
          let offAbort = () => {}
          const finish = (fn) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            try {
              offOnline()
            } catch {
              /* ignore */
            }
            try {
              offAbort()
            } catch {
              /* ignore */
            }
            fn()
          }
          // 注意不能 unref：事件循环只剩这个计时器时 Node 会直接退出，
          // 宽限（默认 5s）就永远等不到触发。与上方审批超时计时器行为保持一致。
          timer = setTimeout(() => finish(() => finishWithoutDevice(resolve)), graceMs)
          offOnline = hub.onceDeviceOnline(() =>
            finish(() => {
              log(`device reconnected within grace; pushing approval for ${sessionId || 'unknown session'}`)
              startDeviceFlow(resolve)
            }),
          )
          if (signal !== undefined && typeof signal.addEventListener === 'function') {
            const onAbort = () => finish(() => resolve('cancelled'))
            signal.addEventListener('abort', onAbort, { once: true })
            offAbort = () => signal.removeEventListener('abort', onAbort)
            if (signal.aborted === true) {
              finish(() => resolve('cancelled'))
            }
          }
        })
      }
      // 宽限禁用：维持旧的「立即决定」同步语义
      if (origin === 'remote') {
        log(`approval for remote session ${sessionId} failed closed (no paired device online)`)
        return 'unavailable'
      }
      return next()
    }

    return new Promise((resolve) => startDeviceFlow(resolve))
  }

  /** 手机全部离线时的兜底：远程会话 fail closed，本地会话交还桌面。 */
  hub.onOffline(() => {
    for (const entry of [...pending.values()]) {
      if (entry.origin === 'remote') {
        log(`approval ${entry.id} failed closed: last device went offline (remote session)`)
        settle(entry, 'unavailable')
      } else {
        log(`approval ${entry.id} handed back to desktop: last device went offline`)
        delegate(entry)
      }
    }
  })

  return {
    handler,
    decide,
    /**
     * SSE 重连回放：把所有未决审批原样补发给刚连上的客户端。
     * 卡片按 requestId 幂等，客户端已渲染过的会去重，不会出现双卡。
     */
    replayRequests: (send) => {
      for (const entry of [...pending.values()]) {
        if (entry.done === true || entry.request === undefined) continue
        send({ type: 'approval', request: entry.request })
      }
    },
    pending: () => [...pending.values()].map((entry) => ({
      requestId: entry.id,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      origin: entry.origin,
    })),
    pendingCount: () => pending.size,
  }
}
