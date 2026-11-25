/**
 * 任务结束态通知 + 提问提醒：
 *   1. 订阅宿主 `session/event`（`{ global: true }` 跳过 agent scope 过滤）；
 *   2. 只认 `turn/end` —— 它是唯一带精确终态原因（TurnEndReason）的事件：
 *      completed / aborted / blocked / error / max-tokens / interrupted / forked；
 *   3. 按 `sessionId + turn` 去重，每个 turn 只发一条；
 *   4. 子 agent 会话（`header.origin === 'subagent'`）跳过，避免内部 turn 噪声；
 *   5. 同在 `session/event` 上的 `assistant/message` 会缓存该轮最后一段最终回复，
 *      completed 通知附上「最终结果」；拿不到或消息被中断时退回原完成文案；
 *   6. `tool/call` 里名为 `ask_user_question` 的调用会解析 questions/options，
 *      发送「需要你的选择」提醒（按 callId 去重，只提醒不代替宿主回答流程）；
 *   7. 调 `notify.dispatch` 推给外部通道（ntfy/Bark/企业微信/飞书/钉钉/Telegram/webhook）。
 *      dispatch 自身绝不 throw，这里再包一层兜底，保证事件流不被观察者异常打断；
 *   8. 顺路捕获同在 `session/event` 流上的 `session/title` 事件缓存会话名称，
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
const MAX_FINAL_RESULT_CHARS = 500
const MAX_QUESTION_CHARS = 200
const MAX_DETAIL_LINE_CHARS = 160
const MAX_OPTION_LABEL_CHARS = 100
const MAX_ASK_BODY_CHARS = 900
/** 去重表上限；超出后删掉最早插入的一半，避免长期运行时无界增长。 */
const MAX_TRACKED_SESSIONS = 512
const MAX_TRACKED_QUESTIONS = MAX_TRACKED_SESSIONS * 2

const shortId = (id) => {
  if (typeof id !== 'string' || id === '') return '?'
  // 宿主会话 id 形如 session-90757a76-...；去掉前缀后短 id 才有意义
  const value = id.replace(/^session[-_]/i, '')
  return value.slice(0, 8)
}

const truncateTo = (text, max) => {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const truncate = (text) => truncateTo(text, MAX_DETAIL_CHARS)

const pruneMap = (map, max) => {
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

const pruneSet = (set, max) => {
  while (set.size > max) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
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

/** AssistantMessage.content 里只有 TextBlock 是可直接推送的最终文字；reasoning / tool call 不进通知。 */
const assistantText = (message) => {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 带 tool-call 的 assistant 消息是中间步骤，宿主会继续执行工具，不是本轮最终回复。 */
const isIntermediateAssistantMessage = (message) => {
  const content = message?.content
  return Array.isArray(content) && content.some((block) => block?.type === 'tool-call')
}

const parseQuestionArguments = (raw) => {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (raw !== null && typeof raw === 'object') return raw
  return undefined
}

/**
 * 把 ask_user_question 的调用参数翻成通知文案。纯函数，便于单测。
 * 参数既接受模型原始 JSON 字符串，也接受已解析对象；questions 缺失时返回 undefined。
 */
export function describeUserQuestion(sessionId, rawArguments, sessionTitle, turn) {
  const parsed = parseQuestionArguments(rawArguments)
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  if (questions.length === 0) return undefined

  const name = typeof sessionTitle === 'string' && sessionTitle !== ''
    ? `会话「${sessionTitle}」`
    : `会话 ${shortId(sessionId)}`
  const turnText = typeof turn === 'number' && Number.isFinite(turn) ? ` 第 ${turn} 轮` : ''
  const blocks = []

  for (const [index, item] of questions.entries()) {
    const question = truncateTo(item?.question, MAX_QUESTION_CHARS)
    if (question === '') continue
    const header = typeof item?.header === 'string' && item.header !== ''
      ? `[${truncateTo(item.header, 40)}] `
      : ''
    const detail = typeof item?.detail === 'string' && item.detail !== ''
      ? `\n  说明：${truncateTo(item.detail, MAX_DETAIL_LINE_CHARS)}`
      : ''
    const rawOptions = Array.isArray(item?.options) ? item.options : []
    const options = []
    for (const [optionIndex, option] of rawOptions.entries()) {
      const label = truncateTo(option?.label, MAX_OPTION_LABEL_CHARS)
      if (label === '') continue
      const description = typeof option?.description === 'string' && option.description !== ''
        ? ` — ${truncateTo(option.description, MAX_DETAIL_LINE_CHARS)}`
        : ''
      options.push(`  ${optionIndex + 1}. ${label}${description}`)
    }
    const optionBlock = options.length > 0
      ? `\n  选项：\n${options.join('\n')}`
      : '\n  （无选项，可直接回复）'
    blocks.push(`${index + 1}. ${header}${question}${detail}${optionBlock}`)
  }

  if (blocks.length === 0) return undefined
  const body = `${name}${turnText}等待你的回答：\n${blocks.join('\n\n')}`
  return { title: '需要你的选择', body: truncateTo(body, MAX_ASK_BODY_CHARS) }
}

/** 把 turn/end 的 reason 翻成通知标题与正文。纯函数，便于单测。 */
export function describeTurnEnd(sessionId, turn, reason, sessionTitle, finalResult) {
  // 会话名称可读性远高于短 id；拿到名称就优先展示名称，拿不到退回短 id。
  const where = typeof sessionTitle === 'string' && sessionTitle !== ''
    ? `会话「${sessionTitle}」第 ${turn} 轮`
    : `会话 ${shortId(sessionId)} 第 ${turn} 轮`
  const kind = reason?.kind ?? 'completed'
  switch (kind) {
    case 'completed': {
      const result = typeof finalResult === 'string' ? finalResult.trim() : ''
      return {
        title: REASON_TITLES.completed,
        body: result
          ? `${where}已完成\n最终结果：${truncateTo(result, MAX_FINAL_RESULT_CHARS)}`
          : `${where}已完成`,
      }
    }
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
  /** `${sessionId}\u0000${turn}` -> 该轮最后一段 assistant 文本；turn/end 消费后删除。 */
  const results = new Map()
  /** 已提醒过的 ask_user_question callId；Set 插入序即提醒顺序，便于裁剪。 */
  const askedCalls = new Set()

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

  const send = (title, body) => {
    try {
      void Promise.resolve(notify.dispatch({ title, body, path: '/' })).catch((error) => {
        log('task notify dispatch failed:', error?.message ?? error)
      })
    } catch (error) {
      log('task notify dispatch threw:', error?.message ?? error)
    }
  }

  const isRootTurnSession = (session) =>
    typeof session?.id === 'string' && session.id !== '' && session?.header?.origin !== 'subagent'

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

    // 最终回复缓冲：只取未中断的 assistant/message，同一 turn 的后续 step 覆盖前一段。
    if (event?.type === 'assistant/message') {
      if (!isRootTurnSession(session)) return
      const data = event.data
      const turn = data?.turn
      if (typeof turn !== 'number' || !Number.isFinite(turn)) return
      if (data?.interrupted === true) return
      if (isIntermediateAssistantMessage(data?.message)) return
      const text = assistantText(data?.message)
      if (text === '') return
      results.set(`${session.id}\u0000${turn}`, text)
      pruneMap(results, MAX_TRACKED_SESSIONS * 2)
      return
    }

    // 提问提醒：ask_user_question 的 tool/call 是宿主 durable event，不受 waterfall 顺序影响。
    if (event?.type === 'tool/call') {
      if (!isRootTurnSession(session)) return
      const data = event.data
      if (data?.name !== 'ask_user_question') return
      const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : undefined
      if (callId !== undefined) {
        if (askedCalls.has(callId)) return
        askedCalls.add(callId)
        pruneSet(askedCalls, MAX_TRACKED_QUESTIONS)
      }
      const described = describeUserQuestion(session.id, data.arguments, resolveTitle(session), data.turn)
      if (described === undefined) return
      log(`task notify: ${session.id} ask_user_question ${callId ?? '-'}`)
      send(described.title, described.body)
      return
    }

    if (event?.type !== 'turn/end') return
    if (!isRootTurnSession(session)) return
    const sessionId = session.id
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    const resultKey = `${sessionId}\u0000${turn}`
    const finalResult = results.get(resultKey)
    if (notified.get(sessionId) === turn) {
      results.delete(resultKey)
      return
    }
    notified.set(sessionId, turn)
    pruneMap(notified, MAX_TRACKED_SESSIONS)
    results.delete(resultKey)
    const { title, body } = describeTurnEnd(
      sessionId,
      turn,
      event.data?.reason,
      resolveTitle(session),
      finalResult,
    )
    log(`task notify: ${sessionId} turn ${turn} ${title}`)
    send(title, body)
  }

  return {
    handle,
    describeTurnEnd,
    describeUserQuestion,
    dispose() {
      notified.clear()
      titles.clear()
      results.clear()
      askedCalls.clear()
    },
  }
}
