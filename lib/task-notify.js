/**
 * 任务结束态通知：
 *   1. 订阅宿主 `session/event`（`{ global: true }` 跳过 agent scope 过滤）；
 *   2. 只认 `turn/end` —— 它是唯一带精确终态原因（TurnEndReason）的事件：
 *      completed / aborted / blocked / error / max-tokens / interrupted / forked；
 *   3. 按 `sessionId + turn` 去重，每个 turn 只发一条；
 *   4. 子 agent 会话（`header.origin === 'subagent'`）跳过，避免内部 turn 噪声；
 *   5. 调 `notify.dispatch` 推给外部通道（ntfy/Bark/企业微信/飞书/钉钉/Telegram/webhook）。
 *      dispatch 自身绝不 throw，这里再包一层兜底，保证事件流不被观察者异常打断。
 *   6. 顺路捕获同在 `session/event` 流上的 `session/title` 事件缓存会话名称，
 *      推送文案优先展示名称；拿不到时退回宿主 `getTitle` 回调（ctx.sessionTitle），再退短 id。
 *
 * 为什么不用 `agent/status`：running→idle 拿不到 completed/aborted/error 的区别，
 * 而 `turn/end` 的 reason.kind 是权威终态，且 `session/event` 是 post-commit 的
 * fire-and-forget 追加流，观察者失败会被宿主 log 并隔离，不会让提交失败。
 */

const REASON_TITLES = {
  completed: '任务完成',
  error: '任务出错',
  aborted: '任务已中止',
  blocked: '任务被阻断',
  'max-tokens': '任务达到上限',
  interrupted: '任务被中断',
  forked: '任务已分叉',
}

const MAX_DETAIL_CHARS = 200
/** 去重表上限；超出后删掉最早插入的一半，避免长期运行时无界增长。 */
const MAX_TRACKED_SESSIONS = 512

const shortId = (id) => {
  if (typeof id !== 'string' || id === '') return '?'
  // 宿主会话 id 形如 session-90757a76-...；去掉前缀后短 id 才有意义
  const value = id.replace(/^session[-_]/i, '')
  return value.slice(0, 8)
}

const truncate = (text) => {
  const value = String(text ?? '')
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value
}

const cancelCauseText = (reason) => {
  if (reason === null || typeof reason !== 'object') return ''
  switch (reason.kind) {
    case 'user':
      return '用户中止'
    case 'parent':
      return '父任务中止'
    case 'hook':
      return typeof reason.reason === 'string' && reason.reason !== '' ? `钩子中止（${truncate(reason.reason)}）` : '钩子中止'
    case 'disposed':
      return '会话已释放'
    case 'legacy':
      return '旧版中止'
    default:
      return ''
  }
}

const errorText = (failure) => {
  if (failure === null || typeof failure !== 'object') return ''
  if (typeof failure.message === 'string' && failure.message !== '') return truncate(failure.message)
  if (typeof failure.code === 'string' && failure.code !== '') return truncate(failure.code)
  return ''
}

/** 把 turn/end 的 reason 翻成通知标题与正文。纯函数，便于单测。 */
export function describeTurnEnd(sessionId, turn, reason, sessionTitle) {
  // 会话名称可读性远高于短 id；拿到名称就优先展示名称，拿不到退回短 id。
  const where = typeof sessionTitle === 'string' && sessionTitle !== ''
    ? `会话「${sessionTitle}」第 ${turn} 轮`
    : `会话 ${shortId(sessionId)} 第 ${turn} 轮`
  const kind = reason?.kind ?? 'completed'
  switch (kind) {
    case 'completed':
      return { title: REASON_TITLES.completed, body: `${where}已完成` }
    case 'error': {
      const detail = errorText(reason?.error)
      return { title: REASON_TITLES.error, body: detail ? `${where}出错：${detail}` : `${where}出错` }
    }
    case 'aborted': {
      const detail = cancelCauseText(reason?.reason)
      return { title: REASON_TITLES.aborted, body: detail ? `${where}被中止（${detail}）` : `${where}被中止` }
    }
    case 'blocked':
      return { title: REASON_TITLES.blocked, body: `${where}被阻断` }
    case 'max-tokens':
      return { title: REASON_TITLES['max-tokens'], body: `${where}达到 token 上限` }
    case 'interrupted':
      return { title: REASON_TITLES.interrupted, body: `${where}被中断` }
    case 'forked':
      return { title: REASON_TITLES.forked, body: `${where}已分叉` }
    default:
      return { title: '任务结束', body: `${where}结束（${kind}）` }
  }
}

export function createTaskNotifier({ notify, log, getTitle } = {}) {
  /** sessionId -> 已通知的最后一轮；只用于去重，不用于恢复。 */
  const notified = new Map()
  /** sessionId -> 最近一次 session/title 事件的标题；进程重启前的标题靠 getTitle 兜底。 */
  const titles = new Map()

  /** 解析会话名称：先取 session/title 事件缓存，再退到 getTitle 回调（宿主 sessionTitle 服务）。 */
  const resolveTitle = (session) => {
    const sessionId = session?.id
    const cached = typeof sessionId === 'string' ? titles.get(sessionId) : undefined
    if (typeof cached === 'string' && cached !== '') return cached
    if (typeof getTitle !== 'function') return undefined
    try {
      const value = getTitle(session)
      if (typeof value === 'string' && value !== '') {
        if (typeof sessionId === 'string') titles.set(sessionId, value)
        return value
      }
    } catch {
      /* getTitle 失败不阻断通知 */
    }
    return undefined
  }

  const handle = (session, event) => {
    if (notify === undefined) return
    // 会话标题事件：缓存后即可返回（log-only 事件，不带 turn 终态）。
    if (event?.type === 'session/title') {
      const title = event.data?.title
      if (typeof title === 'string' && title !== '' && typeof session?.id === 'string') {
        titles.set(session.id, title)
      }
      return
    }
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (session?.header?.origin === 'subagent') return
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    if (notified.get(sessionId) === turn) return
    notified.set(sessionId, turn)
    if (notified.size > MAX_TRACKED_SESSIONS) {
      const excess = notified.size - MAX_TRACKED_SESSIONS
      let removed = 0
      for (const key of notified.keys()) {
        if (removed >= excess) break
        notified.delete(key)
        removed += 1
      }
    }
    const { title, body } = describeTurnEnd(sessionId, turn, event.data?.reason, resolveTitle(session))
    log(`task notify: ${sessionId} turn ${turn} ${title}`)
    try {
      void Promise.resolve(notify.dispatch({ title, body, path: '/' })).catch((error) => {
        log('task notify dispatch failed:', error?.message ?? error)
      })
    } catch (error) {
      log('task notify dispatch threw:', error?.message ?? error)
    }
  }

  return {
    handle,
    describeTurnEnd,
    dispose() {
      notified.clear()
      titles.clear()
    },
  }
}
