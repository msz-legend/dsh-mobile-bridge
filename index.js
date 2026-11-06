/**
 * dsh-mobile-bridge — Host 半身。
 *
 * 目标：让手机浏览器在「不重建前端」的前提下接入本机 DSH Desktop。
 * 做法：自建一个边缘网关（edge）把手机流量反代到宿主 webServer，
 * 手机加载的仍是**同一个 Web UI**（同源 WS、同源 HTTP RPC），
 * 于是会话列表、新建会话、流式输出、停止输出全部零改动复用；
 * 只有「审批」需要桥接，因为宿主词表没有 always、且手机不在宿主进程里。
 *
 * 不导出 Config：避免依赖 schemastery 的模块解析，插件在任何 profile 组合下都能加载。
 * 配置由 cordis.patch.yml 的 config 传入，本文件内做默认值归一化。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from './lib/store.js'
import { createEventHub } from './lib/events.js'
import { createArgsObserver } from './lib/args-observer.js'
import { createSessionOrigin } from './lib/session-origin.js'
import { createAlways } from './lib/always.js'
import { createPairing } from './lib/pairing.js'
import { createBindingManager } from './lib/binding.js'
import { createApprovalBridge } from './lib/approval-bridge.js'
import { createEdge } from './lib/edge.js'
import { createCloudflared } from './lib/cloudflared.js'
import { createSakuraFrp } from './lib/sakurafrp.js'
import { createHostLogin } from './lib/host-login.js'
import { registerRoutes, DEVICE_COOKIE } from './lib/routes.js'
import { createNotifyDispatcher } from './lib/push.js'
import { resolvePublicBase } from './lib/tunnel.js'
import { installIndexInjection } from './lib/index-inject.js'

export const name = 'dsh-mobile-bridge'

/** 只依赖 Cordis 内核（ctx.on / ctx.inject / ctx.effect），不硬依赖任何 DSH Service。 */
export const inject = []

const DEFAULTS = {
  enabled: true,
  edgeHost: '127.0.0.1',
  edgePort: 8787,
  publicBase: '',
  storeDir: '',
  approvalTimeoutMs: 60_000,
  approvalTimeoutRemoteMs: 30_000,
  offlineGraceMs: 5_000,
  alwaysScope: 'session',
  maxDevices: 5,
  enableLan: true,
  tunnelEnabled: false,
  tunnelMode: 'quick',
  tunnelToken: '',
  tunnelBin: 'cloudflared',
  tunnelProtocol: '',
  sakuraToken: '',
  sakuraTunnelId: '',
  sakuraBin: 'frpc',
  sakuraDomain: '',
}

const asPositiveInt = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function normalize(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }
  if (input.enabled === false) config.enabled = false
  if (typeof input.edgeHost === 'string' && input.edgeHost.trim() !== '') config.edgeHost = input.edgeHost.trim()
  config.edgePort = asPositiveInt(input.edgePort, DEFAULTS.edgePort)
  if (typeof input.publicBase === 'string') config.publicBase = input.publicBase.trim()
  if (typeof input.storeDir === 'string' && input.storeDir.trim() !== '') config.storeDir = input.storeDir.trim()
  config.approvalTimeoutMs = asPositiveInt(input.approvalTimeoutMs, DEFAULTS.approvalTimeoutMs)
  config.approvalTimeoutRemoteMs = asPositiveInt(input.approvalTimeoutRemoteMs, DEFAULTS.approvalTimeoutRemoteMs)
  config.offlineGraceMs = asPositiveInt(input.offlineGraceMs, DEFAULTS.offlineGraceMs)
  config.alwaysScope = input.alwaysScope === 'global' ? 'global' : 'session'
  config.maxDevices = asPositiveInt(input.maxDevices, DEFAULTS.maxDevices)
  config.enableLan = input.enableLan !== false
  config.tunnelEnabled = input.tunnelEnabled === true
  config.tunnelMode =
    input.tunnelMode === 'token' || input.tunnelMode === 'sakura' ? input.tunnelMode : 'quick'
  config.tunnelToken = typeof input.tunnelToken === 'string' ? input.tunnelToken.trim() : ''
  config.tunnelBin = typeof input.tunnelBin === 'string' && input.tunnelBin.trim() !== '' ? input.tunnelBin.trim() : DEFAULTS.tunnelBin
  config.tunnelProtocol =
    input.tunnelProtocol === 'http2' || input.tunnelProtocol === 'quic' ? input.tunnelProtocol : DEFAULTS.tunnelProtocol
  config.sakuraToken = typeof input.sakuraToken === 'string' ? input.sakuraToken.trim() : ''
  config.sakuraTunnelId = typeof input.sakuraTunnelId === 'string' ? input.sakuraTunnelId.trim() : ''
  config.sakuraBin = typeof input.sakuraBin === 'string' && input.sakuraBin.trim() !== '' ? input.sakuraBin.trim() : DEFAULTS.sakuraBin
  config.sakuraDomain = typeof input.sakuraDomain === 'string' ? input.sakuraDomain.trim() : ''
  config.dshPort = 0
  return config
}

/**
 * 读取本地隧道机密（Cloudflare 命名隧道 token 与固定域名、SakuraFrp 访问密钥）。
 *
 * 为什么放本地文件而不是配置：机密绝不能写进仓库/cordis.patch.yml 被提交。
 * 文件：<storeDir>/tunnel.json  =>  { "token": "...", "publicBase": "https://dsh.example.com", "sakura": { "token": "...", "tunnelId": "...", "domain": "" } }
 * 仅在配置里对应项为空时才采用；读取失败静默（保持 quick/LAN 等既有行为）。
 */
function readLocalTunnelConfig(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function apply(ctx, raw) {
  const rawInput = raw !== null && typeof raw === 'object' ? raw : {}
  const storeDirHint =
    typeof rawInput.storeDir === 'string' && rawInput.storeDir.trim() !== ''
      ? rawInput.storeDir.trim()
      : path.join(os.homedir(), '.dsh', 'dsh-mobile-bridge')
  const localTunnel = readLocalTunnelConfig(storeDirHint)
  const merged = { ...rawInput }
  if (
    (typeof merged.tunnelToken !== 'string' || merged.tunnelToken.trim() === '') &&
    typeof localTunnel.token === 'string' &&
    localTunnel.token.trim() !== ''
  ) {
    merged.tunnelToken = localTunnel.token.trim()
  }
  if (
    (typeof merged.publicBase !== 'string' || merged.publicBase.trim() === '') &&
    typeof localTunnel.publicBase === 'string' &&
    localTunnel.publicBase.trim() !== ''
  ) {
    merged.publicBase = localTunnel.publicBase.trim()
  }
  // 本地 tunnel.json 里的 SakuraFrp 机密（{ token, tunnelId, domain }）：仅配置为空时补。
  const localSakura = localTunnel.sakura !== null && typeof localTunnel.sakura === 'object' ? localTunnel.sakura : {}
  if (
    (typeof merged.sakuraToken !== 'string' || merged.sakuraToken.trim() === '') &&
    typeof localSakura.token === 'string' &&
    localSakura.token.trim() !== ''
  ) {
    merged.sakuraToken = localSakura.token.trim()
  }
  if (
    (typeof merged.sakuraTunnelId !== 'string' || merged.sakuraTunnelId.trim() === '') &&
    typeof localSakura.tunnelId === 'string' &&
    localSakura.tunnelId.trim() !== ''
  ) {
    merged.sakuraTunnelId = localSakura.tunnelId.trim()
  }
  if (
    (typeof merged.sakuraDomain !== 'string' || merged.sakuraDomain.trim() === '') &&
    typeof localSakura.domain === 'string' &&
    localSakura.domain.trim() !== ''
  ) {
    merged.sakuraDomain = localSakura.domain.trim()
  }
  // 本地 tunnel.json 里同时有 token + 固定域名 → 视为命名隧道模式（重启后持续生效，无需改仓库配置）。
  if (
    typeof merged.tunnelToken === 'string' && merged.tunnelToken.trim() !== '' &&
    typeof merged.publicBase === 'string' && merged.publicBase.trim() !== ''
  ) {
    merged.tunnelMode = 'token'
    // 隧道已交给系统服务（serviceManaged）时由 Windows 服务托管连接，插件不再自行拉起 cloudflared。
    merged.tunnelEnabled = localTunnel.serviceManaged === true ? false : true
  }
  // 用户在设置页显式选择了 SakuraFrp：模式标记优先于上面的 cloudflared 推断，保证重启后仍生效。
  // auto（无自定义域名）时清空 publicBase，让 resolvePublicBase 采用 frpc 上报的随机子域；
  // custom 时直接采用用户填的域名。
  if (
    localTunnel.mode === 'sakura' &&
    typeof merged.sakuraToken === 'string' && merged.sakuraToken.trim() !== '' &&
    typeof merged.sakuraTunnelId === 'string' && merged.sakuraTunnelId.trim() !== ''
  ) {
    merged.tunnelMode = 'sakura'
    merged.tunnelEnabled = true
    merged.publicBase = typeof localSakura.domain === 'string' ? localSakura.domain.trim() : ''
  }
  const config = normalize(merged)
  if (!config.enabled) return

  const log = (...parts) => {
    try {
      // eslint-disable-next-line no-console
      console.log('[dsh-mobile-bridge]', ...parts)
    } catch {
      /* ignore */
    }
  }

  const storeDir = config.storeDir === '' ? path.join(os.homedir(), '.dsh', 'dsh-mobile-bridge') : config.storeDir
  const store = createStore(storeDir)
  const always = createAlways({ store, config, log })
  const pairing = createPairing({ config, store, log })
  // 绑定密码：首次运行生成随机值落盘 <storeDir>/binding.json(0600)，手机凭密码自助绑定。
  const binding = createBindingManager({ dir: storeDir, log })
  binding.ensure()
  const hub = createEventHub(log)
  const origins = createSessionOrigin(log)
  const args = createArgsObserver(ctx, log)
  /** 浏览器半身的加载回执，用于自证客户端确实注册成功。 */
  const clientHello = { count: 0, lastAt: 0, href: undefined, note: undefined }

  // 审批桥接：Host 侧唯一需要真正参与宿主逻辑的模块。
  // 通知调度器：审批卡出现时 POST 到用户配置的外部推送通道（ntfy/Bark/企业微信自建应用/飞书/
  // 钉钉/企业微信/Telegram/通用 webhook），不依赖浏览器 —— 任何手机装个 APP 就能收。
  const notify = createNotifyDispatcher({
    storeDir: storeDirHint,
    log,
    // publicBase 是异步解析的（隧道晚启动），dispatch 时实时取已缓存值。
    publicBase: () => publicBaseCache ?? config.publicBase ?? '',
  })
  const bridge = createApprovalBridge({ config, hub, always, args, origins, log, notify })
  const disposeApproval = ctx.on('approval/request', bridge.handler, { prepend: true, global: true })
  log(`approval bridge attached (timeout local=${config.approvalTimeoutMs}ms remote=${config.approvalTimeoutRemoteMs}ms)`)

  // 心跳：保持 SSE 连接与中间代理不空闲超时。
  const heartbeat = setInterval(() => hub.heartbeat(), 20_000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  let publicBaseCache
  let tunnelImpl
  const getPublicBase = async () => {
    if (typeof publicBaseCache === 'string') return publicBaseCache
    publicBaseCache = await resolvePublicBase(config, config.edgePort, edge?.bindings?.() ?? [], log, tunnelImpl?.url?.())
    log(`publicBase = ${publicBaseCache}`)
    return publicBaseCache
  }

  // 隧道工厂：按 tunnelMode 产出同构的 {start,stop,status,url}。
  // cloudflared（quick/token）与 SakuraFrp（frpc）共用同一份健康看护约定。
  const buildTunnel = () => {
    if (config.tunnelMode === 'sakura') {
      return createSakuraFrp({
        config,
        targetPort: config.edgePort,
        log,
        healthUrl: () => config.publicBase || tunnelImpl?.url?.(),
        onUrl: (url) => {
          publicBaseCache = undefined
          log(`publicBase switched to tunnel: ${url}`)
          void getPublicBase()
        },
      })
    }
    return createCloudflared({
      config,
      targetPort: config.edgePort,
      log,
      // 健康看护：token 模式探测固定域名；quick 模式探测解析出的临时地址。
      healthUrl: () => config.publicBase || tunnelImpl?.url?.(),
      onUrl: (url) => {
        publicBaseCache = undefined
        log(`publicBase switched to tunnel: ${url}`)
        void getPublicBase()
      },
    })
  }

  tunnelImpl = buildTunnel()
  // 稳定代理：rebuildTunnel 换实现时，routes/edge 持有的 tunnel 引用仍指向当前实例。
  const tunnel = {
    start: (...args) => tunnelImpl.start(...args),
    stop: (...args) => tunnelImpl.stop(...args),
    status: (...args) => tunnelImpl.status(...args),
    url: (...args) => tunnelImpl.url(...args),
  }

  // 隧道重建（一键接入/换模式用）：停掉当前进程，确认退出后按新 config 重新构建并拉起。
  const rebuildTunnel = async () => {
    try {
      await tunnelImpl.stop()
    } catch {
      /* ignore */
    }
    for (let index = 0; index < 20; index += 1) {
      if (tunnelImpl.status().running !== true) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    publicBaseCache = undefined
    tunnelImpl = buildTunnel()
    try {
      await tunnelImpl.start()
    } catch {
      /* ignore */
    }
    publicBaseCache = undefined
  }

  let edge
  let routes

  ctx.inject(['webServer', 'connection'], (scoped) => {
    try {
      const port = scoped.webServer.port
      config.dshPort = port
      const getLaunchUrl = () => {
        try {
          return scoped.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
        } catch (error) {
          log('authenticatedUrl unavailable:', error?.message ?? error)
          return undefined
        }
      }
      const hostLogin = createHostLogin({ getLaunchUrl, log })

      routes = registerRoutes(scoped, {
        config,
        pairing,
        binding,
        hub,
        bridge,
        always,
        store,
        log,
        getPublicBase,
        getLaunchUrl,
        hostLogin,
        clientHello,
        tunnel,
        // Tailscale 一键接入：把固定地址立即应用到运行中的 config，并清缓存让二维码即时更新。
        setPublicBase: (url) => {
          config.publicBase = typeof url === 'string' ? url : ''
          publicBaseCache = undefined
        },
        rebuildTunnel,
        getEdgeStatus: () => ({
          listening: edge?.isListening?.() === true,
          host: config.edgeHost,
          port: config.edgePort,
          bindings: edge?.bindings?.() ?? [],
        }),
        notify,
      })

      edge = createEdge({ config, log, pairing, hub, origins, hostLogin })
      edge.start().then((result) => {
        publicBaseCache = undefined
        if (result?.ok !== true) {
          log(`edge did not start: the plugin still serves pairing routes on the host, but no phone can reach it`)
          return
        }
        log(`edge bindings: ${result.bindings.join(', ')}`)
        void getPublicBase()
        if (config.tunnelEnabled) {
          void tunnel.start()
        }
      })

      const disposeInject = installIndexInjection(scoped.webServer, log)
      log(`routes mounted at /plugins/dsh-mobile-bridge (host port ${port}), cookie=${DEVICE_COOKIE}`)

      scoped.effect(
        () => () => {
          try {
            disposeInject()
          } catch {
            /* ignore */
          }
          try {
            routes?.dispose?.()
          } catch {
            /* ignore */
          }
          try {
            edge?.stop?.()
          } catch {
            /* ignore */
          }
          try {
            tunnel?.stop?.()
          } catch {
            /* ignore */
          }
        },
        'dsh-mobile-bridge: routes + edge + tunnel + index injection',
      )
    } catch (error) {
      log('activation failed:', error?.message ?? error, error?.stack ?? '')
    }
  })

  ctx.effect(
    () => () => {
      clearInterval(heartbeat)
      try {
        disposeApproval?.()
      } catch {
        /* ignore */
      }
      try {
        args?.dispose?.()
      } catch {
        /* ignore */
      }
    },
    'dsh-mobile-bridge: approval bridge + timers',
  )

  return undefined
}
