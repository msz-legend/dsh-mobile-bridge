/**
 * 宿主登录交换（共享模块）。
 *
 * 宿主 webServer 的 owner cookie 绑定进程 token，Desktop 重启后全部失效。
 * edge 对已配对设备的请求做透明续期：401 时重新登录、重放请求，
 * 手机侧无感知（README 承诺的「无需重新扫码」就是这条路径）。
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

/** 把 Set-Cookie 串数组折成请求头里的 cookie 值（拼接到已有 cookie 之后）。 */
export const mergeCookieHeader = (originalCookie, setCookieList) => {
  const parts = []
  if (typeof originalCookie === 'string' && originalCookie.trim() !== '') parts.push(originalCookie.trim())
  for (const setCookie of setCookieList ?? []) {
    const pair = setCookie.split(';')[0]
    if (pair.includes('=') === false) continue
    parts.push(pair.trim())
  }
  return parts.join('; ')
}
