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
import { createApprovalBridge } from './lib/approval-bridge.js'
import { createEdge } from './lib/edge.js'
import { createCloudflared } from './lib/cloudflared.js'
import { createHostLogin } from './lib/host-login.js'
import { registerRoutes, DEVICE_COOKIE } from './lib/routes.js'
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
  pairingTtlMs: 5 * 60 * 1000,
  pairingMaxAttempts: 3,
  approvalTimeoutMs: 60_000,
  approvalTimeoutRemoteMs: 30_000,
  offlineGraceMs: 5_000,
  pairConfirmTtlMs: 2 * 60_000,
  autoApprovePairing: false,
  alwaysScope: 'session',
  maxDevices: 5,
  enableLan: true,
  tunnelEnabled: false,
  tunnelMode: 'quick',
  tunnelToken: '',
  tunnelBin: 'cloudflared',
  tunnelProtocol: '',
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
  config.pairingTtlMs = asPositiveInt(input.pairingTtlMs, DEFAULTS.pairingTtlMs)
  config.pairingMaxAttempts = asPositiveInt(input.pairingMaxAttempts, DEFAULTS.pairingMaxAttempts)
  config.approvalTimeoutMs = asPositiveInt(input.approvalTimeoutMs, DEFAULTS.approvalTimeoutMs)
  config.approvalTimeoutRemoteMs = asPositiveInt(input.approvalTimeoutRemoteMs, DEFAULTS.approvalTimeoutRemoteMs)
  config.offlineGraceMs = asPositiveInt(input.offlineGraceMs, DEFAULTS.offlineGraceMs)
  config.pairConfirmTtlMs = asPositiveInt(input.pairConfirmTtlMs, DEFAULTS.pairConfirmTtlMs)
  config.autoApprovePairing = input.autoApprovePairing === true
  config.alwaysScope = input.alwaysScope === 'global' ? 'global' : 'session'
  config.maxDevices = asPositiveInt(input.maxDevices, DEFAULTS.maxDevices)
  config.enableLan = input.enableLan !== false
  config.tunnelEnabled = input.tunnelEnabled === true
  config.tunnelMode = input.tunnelMode === 'token' ? 'token' : 'quick'
  config.tunnelToken = typeof input.tunnelToken === 'string' ? input.tunnelToken.trim() : ''
  config.tunnelBin = typeof input.tunnelBin === 'string' && input.tunnelBin.trim() !== '' ? input.tunnelBin.trim() : DEFAULTS.tunnelBin
  config.tunnelProtocol =
    input.tunnelProtocol === 'http2' || input.tunnelProtocol === 'quic' ? input.tunnelProtocol : DEFAULTS.tunnelProtocol
  config.dshPort = 0
  return config
}

/**
 * 读取本地隧道机密（命名隧道 token 与固定域名）。
 *
 * 为什么放本地文件而不是配置：token 是敏感凭据，绝不能写进仓库/cordis.patch.yml 被提交。
 * 文件：<storeDir>/tunnel.json  =>  { "token": "...", "publicBase": "https://dsh.example.com" }
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
  const hub = createEventHub(log)
  const origins = createSessionOrigin(log)
  const args = createArgsObserver(ctx, log)
  /** 浏览器半身的加载回执，用于自证客户端确实注册成功。 */
  const clientHello = { count: 0, lastAt: 0, href: undefined, note: undefined }

  // 审批桥接：Host 侧唯一需要真正参与宿主逻辑的模块。
  const bridge = createApprovalBridge({ config, hub, always, args, origins, log })
  const disposeApproval = ctx.on('approval/request', bridge.handler, { prepend: true, global: true })
  log(`approval bridge attached (timeout local=${config.approvalTimeoutMs}ms remote=${config.approvalTimeoutRemoteMs}ms)`)

  // 心跳：保持 SSE 连接与中间代理不空闲超时。
  const heartbeat = setInterval(() => hub.heartbeat(), 20_000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  let publicBaseCache
  let tunnel
  const getPublicBase = async () => {
    if (typeof publicBaseCache === 'string') return publicBaseCache
    publicBaseCache = await resolvePublicBase(config, config.edgePort, edge?.bindings?.() ?? [], log, tunnel?.url?.())
    log(`publicBase = ${publicBaseCache}`)
    return publicBaseCache
  }

  // cloudflared 隧道：quick 模式拿到 URL 后立即刷新 publicBase（配对二维码跟着变）。
  tunnel = createCloudflared({
    config,
    targetPort: config.edgePort,
    log,
    // 健康看护：token 模式探测固定域名；quick 模式探测解析出的临时地址。
    healthUrl: () => config.publicBase || tunnel?.url?.(),
    onUrl: (url) => {
      publicBaseCache = undefined
      log(`publicBase switched to tunnel: ${url}`)
      void getPublicBase()
    },
  })

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
        getEdgeStatus: () => ({
          listening: edge?.isListening?.() === true,
          host: config.edgeHost,
          port: config.edgePort,
          bindings: edge?.bindings?.() ?? [],
        }),
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
