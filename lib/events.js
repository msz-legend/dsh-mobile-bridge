/**
 * 设备在线状态 + SSE 推送总线。
 *
 * 审批卡片走 SSE(下行) + POST(上行)，不走 WebSocket：宿主 webServer 的
 * upgrade 路由是「一条 socket 只能有一个协议主人」，/api/remote.mux 已经被
 * API Gateway 占据；再抢一条升级路径风险大、收益小，而审批是低频小载荷，
 * SSE 天然支持断线重连，edge 反代也只需管道转发响应体。
 */
export function createEventHub(log) {
  const clients = new Set()
  let offlineHook = () => {}
  let onlineWaiters = []

  const flushOnlineWaiters = () => {
    if (onlineWaiters.length === 0) return
    const waiters = onlineWaiters
    onlineWaiters = []
    for (const waiter of waiters) {
      try {
        waiter()
      } catch (error) {
        log('online waiter failed:', error?.message ?? error)
      }
    }
  }

  const add = (res, device) => {
    const client = { res, device }
    clients.add(client)
    if (device) flushOnlineWaiters()
    res.on('close', () => {
      clients.delete(client)
      if (clients.size === 0) {
        try {
          offlineHook()
        } catch (error) {
          log('offline hook failed:', error?.message ?? error)
        }
      }
    })
    return client
  }

  const write = (client, payload) => {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      clients.delete(client)
      return false
    }
  }

  const broadcast = (payload) => {
    for (const client of [...clients]) write(client, payload)
  }

  /** 只发给桌面页（不带设备令牌的连接）：配对确认等桌面专属事件用。 */
  const broadcastLoopback = (payload) => {
    for (const client of [...clients]) {
      if (client.device) continue
      write(client, payload)
    }
  }

  /** 给单个连接补发（SSE 重连后回放 pending 审批卡）。 */
  const sendTo = (client, payload) => write(client, payload)

  /** 设备上线即触发（已在线则立刻触发）；返回解绑函数。审批的离线宽限靠它等手机回来。 */
  const onceDeviceOnline = (hook) => {
    if (hasOnlineDevice()) {
      hook()
      return () => {}
    }
    onlineWaiters.push(hook)
    return () => {
      onlineWaiters = onlineWaiters.filter((entry) => entry !== hook)
    }
  }

  const heartbeat = () => {
    for (const client of [...clients]) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }

  const onlineDeviceIds = () => new Set([...clients].filter((client) => client.device).map((client) => client.device.deviceId))

  /**
   * 「有已配对设备在线」——注意与 `hasOnline()` 不同：
   * 桌面页面也会连 SSE（它是 owner，没带设备 cookie），它在线**不代表手机在线**。
   * 审批的离线兜底必须看这个值，否则远程会话会在手机离线时被误判为「有应答者」。
   */
  const hasOnlineDevice = () => clients.size > 0 && [...clients].some((client) => client.device)

  /** 撤销设备时立刻踢掉它已经建立的流，保证「撤销即时生效」而不只是拒绝新请求。 */
  const disconnectDevice = (deviceId) => {
    let closed = 0
    for (const client of [...clients]) {
      if (client.device?.deviceId !== deviceId) continue
      clients.delete(client)
      try {
        client.res.write(`data: ${JSON.stringify({ type: 'revoked' })}\n\n`)
        client.res.end()
      } catch {
        /* ignore */
      }
      closed += 1
    }
    return closed
  }

  const disconnectAll = () => {
    let closed = 0
    for (const client of [...clients]) {
      clients.delete(client)
      try {
        client.res.write(`data: ${JSON.stringify({ type: 'revoked' })}\n\n`)
        client.res.end()
      } catch {
        /* ignore */
      }
      closed += 1
    }
    return closed
  }

  return {
    add,
    broadcast,
    broadcastLoopback,
    sendTo,
    onceDeviceOnline,
    heartbeat,
    onlineDeviceIds,
    hasOnline: () => clients.size > 0,
    hasOnlineDevice,
    disconnectDevice,
    disconnectAll,
    count: () => clients.size,
    onOffline: (hook) => {
      offlineHook = hook
    },
  }
}
