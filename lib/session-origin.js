/**
 * 会话来源标记：区分「远程（手机经 edge 发起）」与「本地（桌面发起）」。
 *
 * 这个标记只影响一件事：手机离线/超时时的兜底策略。
 *   - 远程会话：必须 fail closed（返回 unavailable），不得静默放行、也不得回退桌面；
 *   - 本地会话：交还桌面 UI（next()），手机只是旁观者。
 */
export function createSessionOrigin(log) {
  const remote = new Set()

  return {
    markRemote(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return
      remote.add(String(sessionId))
      if (remote.size > 2000) {
        const oldest = remote.values().next()
        if (!oldest.done) remote.delete(oldest.value)
      }
    },
    isRemote: (sessionId) => remote.has(String(sessionId ?? '')),
    originOf: (sessionId) => (remote.has(String(sessionId ?? '')) ? 'remote' : 'local'),
    list: () => [...remote],
  }
}
