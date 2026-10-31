/**
 * 参数旁路：在任何审批发生之前，把 (callId → 工具参数) 记下来。
 *
 * 为什么需要它：宿主 `ApprovalRequestEvent` 明确不带工具参数（见
 * `@deepseek-ai/dsh-user-approval` README「The request carries no tool arguments」），
 * 而本插件要做「always 记住 (工具, 参数 pattern)」并给手机展示参数摘要。
 *
 * `tools/pre-execute` 在分发前运行、能拿到已解析的 `exec.arguments`，且它在
 * approval 之前 —— 所以这里挂一个纯观察者：只记录，然后无条件 `next()`，
 * 不改变任何既有决策语义。
 */
const MAX_ENTRIES = 512

export function createArgsObserver(ctx, log) {
  const cache = new Map()

  const dispose = ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      try {
        const callId = exec?.callId === undefined || exec?.callId === null ? '' : String(exec.callId)
        if (callId) {
          cache.delete(callId)
          cache.set(callId, {
            tool: String(exec.name ?? ''),
            args: exec.arguments,
            sessionId: exec.agent?.id === undefined ? '' : String(exec.agent.id),
            at: Date.now(),
          })
          while (cache.size > MAX_ENTRIES) {
            const oldest = cache.keys().next()
            if (oldest.done) break
            cache.delete(oldest.value)
          }
        }
      } catch (error) {
        log('args observer failed:', error?.message ?? error)
      }
      return next()
    },
    { prepend: true, global: true },
  )

  return {
    take(callId) {
      if (callId === undefined || callId === null || callId === '') return undefined
      return cache.get(String(callId))
    },
    size: () => cache.size,
    dispose,
  }
}
