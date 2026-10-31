/**
 * always 规则表：把「始终允许」落成可解释、可撤销的规则。
 *
 * 宿主没有 allow-always 语义（`ApprovalOutcome` 只有 allowed-once），所以「记住」必须
 * 由插件自己保存；命中规则时不再打扰人，但**对宿主仍然返回 `allowed-once`** ——
 * 因为那是唯一的合法授权值，返回别的词会被服务归一成 `unavailable`（即拒绝）。
 *
 * 规则粒度：工具名 + 参数指纹。指纹只从稳定字段提取（command / path / url / query），
 * 拿不到就退化成「仅工具名」，并在卡片上如实标注，不假装记住了参数。
 */
const MAX_RULES = 300

const COMMAND_KEYS = ['command', 'cmd', 'script']
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'destination', 'source']
const URL_KEYS = ['url', 'uri', 'href']
const QUERY_KEYS = ['query', 'pattern', 'search']

const firstString = (args, keys) => {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

const normalizePath = (value) => {
  const text = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = text.lastIndexOf('/')
  if (slash <= 0) return text
  return text.slice(0, slash)
}

const normalizeCommand = (value) => {
  const tokens = value.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  if (tokens.length === 1) return tokens[0]
  const second = tokens[1].startsWith('-') ? '' : tokens[1]
  return second === '' ? tokens[0] : `${tokens[0]} ${second}`
}

/**
 * 提取 (toolName, args) 的稳定指纹。
 * @returns {{kind: string, value: string, label: string, key: string} | undefined}
 */
export function fingerprint(toolName, args) {
  const name = String(toolName ?? '')
  const command = firstString(args, COMMAND_KEYS)
  if (command !== undefined) {
    const value = normalizeCommand(command)
    if (value !== '') return { kind: 'cmd', value, label: `${name} · ${value} *`, key: `cmd:${value}` }
  }
  const filePath = firstString(args, PATH_KEYS)
  if (filePath !== undefined) {
    const value = normalizePath(filePath)
    if (value !== '') return { kind: 'path', value, label: `${name} · ${value}/**`, key: `path:${value}` }
  }
  const url = firstString(args, URL_KEYS)
  if (url !== undefined) {
    try {
      const host = new URL(url).host
      if (host !== '') return { kind: 'url', value: host, label: `${name} · ${host}`, key: `url:${host}` }
    } catch {
      /* 非法 URL 退化成工具级 */
    }
  }
  const query = firstString(args, QUERY_KEYS)
  if (query !== undefined) {
    return { kind: 'query', value: query, label: `${name} · "${query}"`, key: `query:${query}` }
  }
  return undefined
}

export function createAlways({ store, config, log }) {
  let rules = Array.isArray(store.readAlways()?.rules) ? store.readAlways().rules : []

  const persist = () => {
    try {
      store.writeAlways({ version: 1, rules })
    } catch (error) {
      log('always persist failed:', error?.message ?? error)
    }
  }

  const sameScope = (rule, sessionId) => rule.scope === 'global' || rule.sessionId === sessionId

  const match = (sessionId, toolName, args) => {
    if (rules.length === 0) return undefined
    const own = fingerprint(toolName, args)
    const toolOnlyKey = `tool:${toolName}`
    for (const rule of rules) {
      if (rule.toolName !== toolName) continue
      if (!sameScope(rule, String(sessionId ?? ''))) continue
      if (rule.key === toolOnlyKey) return rule
      if (own !== undefined && rule.key === own.key) return rule
    }
    return undefined
  }

  const add = ({ sessionId, toolName, args, scope }) => {
    const own = fingerprint(toolName, args)
    const key = own === undefined ? `tool:${toolName}` : own.key
    const label = own === undefined ? `${toolName}（仅工具名，参数不可识别）` : own.label
    const effectiveScope = scope === 'global' ? 'global' : 'session'
    const next = {
      id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      toolName: String(toolName ?? ''),
      key,
      label,
      scope: effectiveScope,
      sessionId: effectiveScope === 'session' ? String(sessionId ?? '') : undefined,
      createdAt: Date.now(),
    }
    const existing = rules.find(
      (rule) => rule.toolName === next.toolName && rule.key === next.key && sameScope(rule, next.sessionId ?? ''),
    )
    if (existing !== undefined) return existing
    rules = [...rules, next]
    if (rules.length > MAX_RULES) rules = rules.slice(rules.length - MAX_RULES)
    persist()
    log(`always rule added: ${next.label} (${next.scope}${next.sessionId ? ` · ${next.sessionId}` : ''})`)
    return next
  }

  const list = () => [...rules]

  const revoke = (id) => {
    const before = rules.length
    rules = rules.filter((rule) => rule.id !== id)
    if (rules.length !== before) persist()
    return rules.length !== before
  }

  const clear = () => {
    rules = []
    persist()
  }

  return { match, add, list, revoke, clear, fingerprint }
}
