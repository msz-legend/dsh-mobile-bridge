# DSH Mobile Bridge

用手机浏览器安全接入本机的 **DSH Desktop**：扫码配对、复用同一套 Web UI、流式回显、停止输出，以及**工具审批卡片**（仅本次 / 始终允许 / 拒绝）。

不重建前端：手机加载的就是桌面那份 Web UI，因此 `/api/remote.mux` 的 WebSocket、`session/follow` 的流式帧、`session.create` / `session.prompt` 的 Prompt 路径全部原样复用。

---

## 它解决什么问题

DSH Desktop 的 Web 载体只监听 `127.0.0.1`（启动参数硬编码 `--host 127.0.0.1 --port 0`），手机无法直连；而宿主又没有「手机审批」这条通路。本插件做两件事：

1. **边缘网关（edge）**：在 `127.0.0.1:8787`（可选同时绑定 LAN IP）监听，把手机流量反代到宿主，并做设备令牌闸门。
2. **审批桥接**：作为 `approval/request` waterfall 的监听器参与宿主决策，把请求推给手机卡片，把手机决策回传；超时与离线按 fail closed 处理。

## 架构

```
手机浏览器
   │  https://<random>.trycloudflare.com  （公网档：cloudflared 隧道，CF 边缘终止 TLS）
   │  https://<tailnet>/                  （隐私档：Tailscale serve 终止 TLS）
   │  http://<LAN IP>:8787                （本地档：局域网直连）
   ▼
edge (127.0.0.1:8787 / LAN IP:8787)      ← 设备令牌闸门 + 限速 + 安全头 + 反代
   │  改写 Host/Origin → 127.0.0.1:<dshPort>
   ▼
DSH webServer 127.0.0.1:<随机端口>
   ├── /                      现有 Web UI（同源 WS、同源 RPC）
   ├── /api/remote.mux        WebSocket（流式输出）
   └── /plugins/dsh-mobile-bridge/...   配对页 / SSE / 决策 / 状态

宿主 approval/request waterfall
   └── 本插件 handler { prepend: true, global: true }
         ├─ always 规则命中 → 直接 allowed-once（不再打扰）
         ├─ 无在线设备 + 远程会话 → unavailable（fail closed）
         ├─ 无在线设备 + 本地会话 → next()（交还桌面 UI）
         └─ 有设备 → SSE 推卡片 → 等决策 → 返回 allowed-once/rejected
```

### 为什么「零配置」

宿主的信任围栏校验的是 **`Host` 头**（允许 loopback / 监听绑定地址 / `trustedHosts`），并要求 `Origin` 与之同 authority。edge 在反代时把两者都改写成 `127.0.0.1:<dshPort>`，于是：

- 不需要 `connection.trustedHosts`
- 不需要 `web-runtime.publicUrl`
- 不需要改 `webserver.host`（Desktop 的硬编码监听与内嵌页不受影响）

插件的 `cordis.patch.yml` 只**插入一行**，不覆盖、不禁用任何既有行。

## 安装

```sh
# 在 DSH Desktop 里，把本目录作为 bundle 安装
#   plugin_manager action=install_bundle target=<本目录绝对路径>
```

或手工把它写进 profile 的 `dependencies`（`link:<本目录>`）与 `dsh.profile.bundles`，然后重启 Desktop。

依赖只有一个：`qrcode`（用于生成配对二维码；缺失时页面自动降级为「地址 + 配对码」文本）。

## 配对

1. 桌面打开 `http://127.0.0.1:<dshPort>/plugins/dsh-mobile-bridge/pair`（或在会话里让 agent 调用同域接口），会显示 **6 位一次性配对码 + 二维码**，有效期 5 分钟。
2. 手机扫码，或在手机上打开 `${publicBase}/plugins/dsh-mobile-bridge/pair` 输入配对码。
3. 配对成功：手机拿到**长期设备令牌**（HttpOnly Cookie，1 年）；同时 edge 服务端完成 DSH 登录交换，把宿主的 owner cookie 一并种下，随后 302 进入 Web UI。

配对码限制：5 分钟 TTL、一次性、同码最多 3 次尝试即作废；配对接口按 IP 每分钟 20 次限速，超限熔断 10 分钟；默认最多 5 台设备。

### 桌面确认（手机 / 局域网来源）

从手机（或任何经 edge 的非本机来源）提交配对时，码验证通过后**不会立即发设备**，而是：

1. 手机进入「等待桌面确认」页（自动轮询）；
2. 桌面 DSH 窗口底部弹出**配对请求卡片**（设备名 + 来源），点「允许」或「拒绝」；
3. 允许后手机自动拿到设备令牌并进入 Web UI；拒绝/超时（2 分钟）则手机端收到明确提示。

桌面本机（loopback）直接提交配对码仍是即时生效（那是你在自己电脑前操作）。

### 撤销

```sh
# 查看设备与在线状态（仅 loopback 可读）
curl http://127.0.0.1:<dshPort>/plugins/dsh-mobile-bridge/status

# 撤销某台设备（立即生效：该设备再也进不来）
curl -X POST -H 'content-type: application/json' \
  -d '{"deviceId":"dev_xxx"}' \
  http://127.0.0.1:<dshPort>/plugins/dsh-mobile-bridge/devices/revoke
```

## 外网接入

三个档位，按需选：**cloudflared（公网默认）**、Tailscale（隐私优先）、LAN 直连（本地）。

### cloudflared（公网档，推荐）

手机不在局域网时的默认通道：零账号、免费、自动 TLS、出站连接穿一切 NAT。TLS 在 Cloudflare 边缘终止，语音输入 / 剪贴板 / PWA 安装等 HTTPS-only 能力随之解锁。

```sh
# 1) 安装 cloudflared
winget install Cloudflare.cloudflared

# 2) 在 cordis.patch.yml 里打开开关
#    tunnelEnabled: true
# 3) 重启 DSH Desktop，quick tunnel 自动启动
```

quick 模式（`tunnelMode: 'quick'`，默认）：插件自动起 `cloudflared tunnel --url http://127.0.0.1:8787`，从输出解析 `https://<random>.trycloudflare.com` 并把它作为 `publicBase` —— 设置页、配对页、二维码里的地址都会自动切过去。地址每次重启会变，适合自用。

> 实测注意：新隧道域名解析到公网 DNS 需要 **约 5–10 秒**（此前扫码若立刻报 DNS 错误，等几秒重开即可）；cloudflared 首次起进程偶发退出（code=1），插件会自动重启并解析新地址，日志里有 stderr 尾巴可查因。

token 模式（`tunnelMode: 'token'`）：固定域名用这个。在 Cloudflare 后台建 tunnel、把域名指到 `http://127.0.0.1:8787`，然后把 token 填进 `tunnelToken`、把域名写进 `publicBase`。

隧道进程意外退出会自动重启（指数退避，封顶 30s）；插件卸载时随之停止。

不动 DSH 也能单独验证通道：

```sh
node test/smoke-tunnel.mjs   # 本地起服务 + 真 quick tunnel + 公网回环验证，打印 PASS/FAIL
```

### Tailscale（隐私档）

只有自己的设备要访问、且不想经过任何第三方时用 **`tailscale serve`（仅 tailnet 可见）**，不要用 Funnel。

```sh
# 1) 本机与手机安装 Tailscale 并登录同一账号
# 2) 把 tailnet 内地址转发到 edge
tailscale serve --bg http://127.0.0.1:8787
# 3) 确认 publicBase
curl http://127.0.0.1:<dshPort>/plugins/dsh-mobile-bridge/status
```

插件会自动探测 `tailscale status --json` 里的 DNS 名作为 `publicBase`；探测不到就退回 LAN 地址。也可以在 `cordis.patch.yml` 里显式写死：

```yaml
- id: dsh-mobile-bridge
  name: 'dsh-mobile-bridge'
  config:
    publicBase: 'https://<machine>.<tailnet>.ts.net'
```

### publicBase 优先级

显式 `publicBase` → cloudflared quick tunnel 地址 → Tailscale DNS 名 → LAN 地址 → loopback。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `edgeHost` | `'127.0.0.1'` | edge 监听地址；写 `'auto'` 则自动选 LAN IP + loopback |
| `edgePort` | `8787` | edge 端口 |
| `enableLan` | `true` | 除 loopback 外，是否额外绑定本机 LAN IP（手机局域网直连） |
| `publicBase` | `''` | 对外地址；留空 = 自动探测（cloudflared → Tailscale → LAN → loopback） |
| `tunnelEnabled` | `false` | 是否启动 cloudflared 隧道（公网档通道） |
| `tunnelMode` | `'quick'` | `quick` = 零账号临时隧道（地址每次重启变化）；`token` = 命名隧道 |
| `tunnelToken` | `''` | `token` 模式的隧道凭据（`cloudflared tunnel run --token`，别写进公开仓库） |
| `tunnelBin` | `'cloudflared'` | cloudflared 可执行文件路径（不在 PATH 时写绝对路径） |
| `pairingTtlMs` | `300000` | 配对码有效期 |
| `pairingMaxAttempts` | `3` | 同一配对码允许的尝试次数 |
| `approvalTimeoutMs` | `60000` | 本地会话审批超时 |
| `approvalTimeoutRemoteMs` | `30000` | 远程会话审批超时 |
| `offlineGraceMs` | `5000` | 无设备在线时的重连宽限：等手机 SSE 重连回来再决定，避免审批落在断线间隙被误杀 |
| `pairConfirmTtlMs` | `120000` | 手机/LAN 来源配对的桌面确认有效期 |
| `alwaysScope` | `'session'` | `always` 规则作用域：`session` / `global` |
| `maxDevices` | `5` | 最大配对设备数 |
| `storeDir` | `~/.dsh/dsh-mobile-bridge` | 设备表与 always 规则的落盘目录（0600） |

## 审批语义

宿主 `ApprovalOutcome` 只有 `allowed-once | rejected | cancelled | unavailable`，**`allowed-once` 是唯一授权值**。所以：

| 卡片动作 | 对宿主的返回值 | 记忆 |
|---|---|---|
| 仅本次 | `allowed-once` | 不记忆 |
| 始终允许 | `allowed-once` | 记下 `(工具名, 参数指纹)`，之后同类请求不再弹卡 |
| 拒绝 | `rejected` | 不记忆 |
| 超时 | `unavailable` | fail closed |
| 手机离线 + 远程会话 | `unavailable` | 不静默放行、不交还桌面 |
| 手机离线 + 本地会话 | `next()` | 交还桌面原生审批卡 |

离线判定有 **`offlineGraceMs`（默认 5s）宽限**：审批到达时若恰好没有设备在线（SSE 重连间隙、手机刚唤醒），先等一拍，设备回来就照常推卡；到期仍无人再按上表分流。SSE 重连后服务端会**回放全部未决审批卡**（按 requestId 幂等去重），断线窗口里错过的卡片不会丢。

「始终允许」的参数指纹只从稳定字段提取：`command`（取命令前两段）、`path`（取目录）、`url`（取 host）、`query`。识别不了就退化为「仅工具名」，并在卡片上明确标注 —— 不让用户误判放行范围。

**审批应答通道**：`approval/request` waterfall 的返回值本身（claim）或 `next()`（委托）。`approval/asked` / `approval/decided` 是 log-only 审计事件，本插件只读不用作答。

## 安全红线

- 通过 cookie / token 进来的浏览器 Peer 是 **`owner`**，而宿主 `ctx.remoteAccess` 的 RBAC 只约束**非 owner**。**因此隧道暴露 = owner 级 RCE**。
- 防线依次是：edge 设备令牌闸门（未配对请求不转发给宿主）→ 配对码只在桌面端显示（公网上拿不到码，3 次尝试即作废）→ **手机/局域网来源的配对还需桌面点击确认**（码证明"看到了桌面屏幕"，桌面确认证明"人在电脑前"）→ 配对接口按访客真实 IP 限速熔断。quick tunnel 的 trycloudflare 地址本身**不构成保密**（随机但公开可达），真正的边界是设备令牌。
- 经 cloudflared 进来的流量源地址都是 127.0.0.1，edge 据此以 `cf-connecting-ip`（Cloudflare 边缘注入、客户端伪造会被剥掉）作为限速键，避免单攻击者熔断全体配对。
- 明文 HTTP（LAN 档）下 cookie 在途不加密；cloudflared / Tailscale 形态下 TLS 在边缘终止，公网段全程加密，本机到 edge 仍是明文 HTTP（不出机器）。
- edge 对所有响应附加 `nosniff` / `no-referrer` / `SAMEORIGIN`（含 `frame-ancestors 'self'`），只限制「别人嵌入」，不影响宿主自己的同源 iframe 预览；不设 permissions-policy，避免预关宿主 UI 的麦克风/剪贴板能力。
- token 凭据经命令行参数传给 cloudflared，本机进程列表可见 —— 自用可接受，介意的话等宿主支持凭据文件或改用 quick 模式。

## 移动端适配

`webServer.tapIndex` 注入（只作用于 Web 入口，Electron 不受影响）：

- `<meta name="viewport" ... viewport-fit=cover>`
- `AbortSignal.any` / `AbortSignal.timeout` polyfill（旧 iOS/Chrome 缺失会让页面直接崩）
- 安全区 `env(safe-area-inset-bottom)`、窄屏 `min-height: 100dvh`、输入框 16px 防聚焦缩放
- **PWA 标签**：manifest / apple-touch-icon / theme-color（图标与 manifest 由插件路由同源分发）
- **触屏常显**：`@media (hover:none)` 下把宿主藏在 `:hover` 后的控件常显（代码复制按钮、标签关闭钮；用 CSS-module 前缀 `[class*="_copySlot_"]` 匹配，宿主改名时规则自然失效）

### 安装到主屏（PWA）

公网/HTTPS 档（cloudflared 或 Tailscale）下：

- **Android Chrome**：菜单 → 「添加到主屏幕」→ 全屏独立窗口运行
- **iOS Safari**：分享 → 「添加到主屏幕」

> 不做离线缓存（Service Worker 无法挂在根路径——`/` 归宿主管），可安装 + 全屏已覆盖主屏使用体验。

## 已知限制

- **审批必须有 `ask` 策略才会发生**。若 profile 的 preset 是 `danger-full-access`（`approval: never`），宿主在进入 waterfall 之前就确定性拒绝，插件收不到请求 —— 这不是插件故障。要测审批请把会话 preset 切到 `read-only` / `workspace-write`。
- 手机端「始终允许」不能跨重启保留设备的 `always` 规则？—— 可以：规则落盘在 `~/.dsh/dsh-mobile-bridge/always.json`。
- 桌面页也会连 SSE 并显示同一张卡（便于桌面上快速处理）；「手机是否在线」按**是否带设备令牌**判断，桌面在线不会被误判为手机在线。
- 宿主重启后进程 token 变化：edge 在前端 401 时会重新走登录交换；设备令牌不变，无需重新扫码。

## 目录

```
index.js               Host 入口（apply / 装配 / 生命周期）
client.js              浏览器半身（审批卡 + EventSource）
lib/edge.js            edge 网关（反代 / WS 透传 / 令牌闸门 / 限速 / 会话来源观察）
lib/approval-bridge.js 审批桥接（本次需求的核心）
lib/always.js          always 规则表与参数指纹
lib/args-observer.js   tools/pre-execute 旁路，捕获 (callId → 参数)
lib/session-origin.js  远程 / 本地会话标记
lib/pairing.js         配对码与设备令牌
lib/routes.js          配对页 / SSE / 决策 / 状态路由
lib/index-inject.js    移动端 polyfill 与样式注入
lib/cloudflared.js     cloudflared 隧道管理（quick/token、自动重启、URL 解析）
lib/tunnel.js          publicBase 探测（cloudflared / Tailscale / LAN）
lib/store.js           0600 落盘
```

## 验证

```sh
# 模块级行为测试（once/always/reject/超时/离线分流 + 隧道 URL 解析/容错）
npm test
```

实测通过的链路（curl 模拟手机经 LAN 访问）：未配对 302 → 配对 303 → 首页 200（含注入）→ Remote RPC 200 返回真实会话列表 → `/api/remote.mux` 升级 **101** → SSE `hello` → 未知决策 409。

## 设置页

插件在 **设置 → 手机桥接** 注册了一个分区，显示：访问地址、已配对设备数/上限、在线设备、待审批数、always 规则数、审批超时（本地/远程）、浏览器半身加载次数。

- **桌面端（loopback 直连）**：额外提供「生成配对码」按钮，直接出二维码与 6 位码。
- **手机端**：只读视图，提示"仅在桌面端可生成配对码"。

> 安全边界：`/pairing.json`、`/status`、`/devices/revoke*`、`/rules/revoke` 只允许**真正来自本机**的请求。edge 以 loopback 回源，因此仅凭 socket 源地址无法区分"手机"与"桌面"——这些接口额外要求请求**不带** `x-dmb-forwarded-for`（该头由 edge 强制写入，客户端无法伪造）。已验证：经 edge 的手机身份访问上述接口返回 403，桌面直连返回 200。

## 右侧栏移动化：实测结论 —— 原生已支持，无需重建

原方案（阶段④）假设「窄屏下右侧栏不可用，需要插件自建全屏移动面板复用 Remote API」。**真机走查（412×915 触屏视口）推翻了该假设**：

- 宿主右栏在窗口 <768px 时**自动全屏**，会话 header 的「打开右侧边栏」按钮触屏可达
- **工作区文件**：目录树渲染正常，工具栏（自动刷新/重新读取）可用
- **文件预览**：点开文本文件，内容等宽渲染，多 tab 并存、可关闭
- **终端**：xterm 渲染，cmd.exe 启动，`echo` 命令经软键盘输入正常回显（PTY 全链路穿透 edge）
- **浏览器**：tab 打开、URL 输入框正常
- 触屏唯一盲点是「hover 才显示」的控件（复制/关标签），已由本插件的触屏常显规则修复

结论：右侧栏是宿主的能力，插件**零代码**复用；走查脚本在 `probe/rightbar*.mjs`（Playwright，412×915 触屏视口，配对 → 进会话 → 开右栏 → 逐 tab 截图）。

## 移动端功能对齐

同一套 Web UI 在窄屏下会收起侧栏为图标轨、把部分控件压成图标按钮，但**功能不减**。实测（412×915 视口 + Android 真机）与桌面逐项一致：

| 功能 | 桌面 | 手机 | 说明 |
|---|---|---|---|
| 会话列表（按工作区分组） | ✅ | ✅ | 侧栏需先点"打开侧边栏" |
| 新建会话 / 发送 / 流式 | ✅ | ✅ | 同一 Prompt 路径 |
| 停止输出 | ✅ | ✅ | 会话视图内 |
| 工具审批卡片 | ✅ | ✅ | 本插件 `shell.overlay` 抽屉 |
| 插件列表 / 已安装插件详情 | ✅ | ✅ | 详情含版本、组件、来源 |
| 模型选择 + 推理等级 | ✅ | ✅ | 手机为图标按钮，点开有完整菜单 |
| 审批权限档 | ✅ | ✅ | 同上，点开有 4 档 |
| 手机桥接设置页 | ✅ | ✅ | 手机只读 |
| 右侧栏（文件/预览/终端/浏览器） | ✅ | ✅ | <768px 自动全屏，真机实测见上节 |
| 代码复制 / 标签关闭 | ✅ | ✅ | 触屏常显规则修复（原 hover-only） |
| PWA 安装（主屏全屏） | — | ✅ | HTTPS 档下 Chrome/Safari 添加到主屏幕 |

### 审批卡唯一性

一次审批在任何屏幕上**只出现一张卡**，由 waterfall 语义保证：设备在线时插件以 `prepend` 先答，桌面原生审批 UI 不会介入（只有我们的卡片）；宽限到期且无设备时本地会话走 `next()` 交给桌面原生卡（我们的卡片从未广播）；远程会话则 fail closed。桌面页与手机会看到同一张 DMB 卡（设计如此，便于在电脑前快速处理）。

## 真机验证记录（华为 Android，360dp 视口，USB + adb reverse）

2026-11-01 在真机上走查的结论（此前所有验证都在 412×915 模拟器）：

- 配对 → 桌面确认 → 进 UI：全链路通过；数字键盘、`maxlength` 截断、键盘顶起布局等真机交互均正常
- 发消息 / 流式 / 会话视图 / 右侧栏：与模拟器一致
- **审批卡片真机弹出**，决策回流宿主（agent 侧确认 "there was a real answer"）；超时 fail-closed 与 remote 30s 超时语义均实测生效
- 只读文件策略下，即使升级提权被批准，宿主仍拒绝写入 —— 文件策略是硬边界，审批不越权（宿主安全语义，符合预期）

真机实测揪出并修复的问题（模拟器上全部不可复现）：

1. 华为浏览器聚焦 <16px 输入框时自动放大，整页横向推走、发送按钮出屏 → viewport 加 `maximum-scale=1` + contenteditable 纳入 16px 规则
2. 宿主重启后 owner cookie 失效，手机卡死在 "authentication required" → edge 对已配对设备 401 时自动重登并重放请求（`lib/host-login.js`）
3. 审批卡片被右侧裁出屏幕 → `position:fixed` 被宿主带 transform 的容器劫持，卡片 portal 到 `document.body`
4. 手机缓存旧 client 半身（宿主模块表 rev 不随内容变化）→ edge 对 `/plugins/` 响应强制 no-cache
5. 手机从 home 发消息创建的会话未标记 remote（走的不是 session/create）→ 观察 `session/prompt` 响应 + 扫描设备请求体里的 sessionId

## 故障排查

- **插件升级后界面残缺 / 少控件 / 报 "Failed to load plugins"**：多半是浏览器仍持有旧页面。插件会在 index 注入 `Cache-Control: no-cache` 等 meta 降低概率，但仍建议强制刷新（手机上：下拉刷新或清缓存后重开）。
- **审批卡片不出现**：先确认会话权限档是 `read-only` / `workspace-write`（`danger-full-access` 下宿主在进入 waterfall 前就拒绝，插件收不到请求）；再确认手机在 `设置 → 手机桥接` 里显示"在线"。
- **手机连不上**：确认 `edge` 绑定包含手机可达的地址（`curl http://127.0.0.1:<dshPort>/plugins/dsh-mobile-bridge/status` 的 `edge.bindings`），以及手机与电脑同网段/同 tailnet。

## License

MIT
