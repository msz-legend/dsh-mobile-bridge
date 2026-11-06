/**
 * 宿主登录交换（共享模块）。
 *
 * 宿主 webServer 的 owner cookie 绑定进程 token，Desktop 重启后全部失效。
 * edge 对已配对设备的请求做透明续期：401 时重新登录、重放请求，
 * 手机侧无感知（README 承诺的「无需重新绑定」就是这条路径）。
 */
export function createHostLogin({ getLaunchUrl, log }) {
  let cachedCookies = undefined
  let fetching = undefined

  /** 取一份新鲜的宿主 owner cookies（Set-Cookie 原始串数组）。 */
  const login = (force = false) => {
    if (force === false && cachedCookies !== undefined) return Promise.resolve(cachedCookies)
    if (fetching !== undefined) return fetching
    fetching = (async () => {
      const launch = getLaunchUrl()
      if (launch === undefined) return undefined
      try {
        const response = await fetch(launch, { redirect: 'manual' })
        const cookies =
          typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean)
        cachedCookies = cookies.length > 0 ? cookies : undefined
        if (cachedCookies === undefined) log('host login returned no cookies')
        return cachedCookies
      } catch (error) {
        log('host login failed:', error?.message ?? error)
        return undefined
      } finally {
        fetching = undefined
      }
    })()
    return fetching
  }

  return {
    login,
    invalidate: () => {
      cachedCookies = undefined
    },
  }
}

/**
 * 把 Set-Cookie 串数组折成请求头里的 cookie 值。
 *
 * 同名 cookie 必须替换而不是追加：宿主校验时只读 Cookie 头里**第一个**同名段
 * （cookieValue 顺序扫描返回首个匹配），而 Desktop 重启后重新登录发的 cookie
 * 与手机浏览器 jar 里留存的失效 cookie 同名（端口不变时 authority 哈希相同）。
 * 若把新值追加在旧值之后，宿主永远读到旧值，重放依然 401 —— 外网手机端
 * 「session/prompt HTTP 401」的根因。这里按名去重、新值覆盖旧值。
 */
export const mergeCookieHeader = (originalCookie, setCookieList) => {
  const pairs = []
  const nameOf = (pair) => pair.slice(0, pair.indexOf('=')).trim()
  const push = (pair) => {
    const existing = pairs.findIndex((candidate) => nameOf(candidate) === nameOf(pair))
    if (existing >= 0) pairs.splice(existing, 1)
    pairs.push(pair)
  }
  if (typeof originalCookie === 'string' && originalCookie.trim() !== '') {
    for (const segment of originalCookie.split(';')) {
      const pair = segment.trim()
      if (pair.includes('=')) push(pair)
    }
  }
  for (const setCookie of setCookieList ?? []) {
    const pair = setCookie.split(';')[0].trim()
    if (pair.includes('=')) push(pair)
  }
  return pairs.join('; ')
}
