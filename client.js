/**
 * dsh-mobile-bridge — 浏览器半身。
 *
 * 只做一件事：把宿主推来的审批请求渲染成一张可操作的卡片，并把决策 POST 回去。
 *
 * 为什么用 shell.overlay（帧级底部抽屉）而不是像内置 ui-approval 那样接管
 * composer：接管 composer 会同时吃掉输入框和「停止」按钮，而审批期间用户仍可能
 * 需要停止；浮层不随滚动丢失，也不受会话视图切换影响，断线重连后可按 requestId 重建。
 *
 * 只依赖浏览器模块表里的 react，不引入任何额外运行时。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    // 官方 client-ui-* 包同款：宿主模块表提供 react-dom。
    // 卡片必须 portal 到 body —— position:fixed 在带 transform 的宿主容器里会被
    // 劫持 containing-block，真机（360dp）上卡片右半被裁出屏幕（实测踩过）。
    let reactDom = undefined
    try {
      reactDom = require('react-dom')
    } catch {
      /* 老宿主没有 react-dom 时退化为原位渲染 */
    }

    const BASE = '/plugins/dsh-mobile-bridge'
    const STYLE_ID = 'dsh-mobile-bridge-approval'
    const LANG = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
    const ZH = LANG.indexOf('zh') === 0
    const T = {
      title: ZH ? '工具审批' : 'Tool approval',
      waiting: ZH ? '等待你的决定' : 'Waiting for your decision',
      once: ZH ? '仅本次' : 'Allow once',
      always: ZH ? '始终允许' : 'Always allow',
      reject: ZH ? '拒绝' : 'Reject',
      timeout: ZH ? '已超时 —— 默认拒绝' : 'Timed out — rejected by default',
      remember: ZH ? '将记住：' : 'Will remember:',
      high: ZH ? '高风险' : 'High risk',
      normal: ZH ? '需要确认' : 'Needs confirmation',
      argsUnknown: ZH ? '（参数不可得，仅按工具名记忆）' : '(args unavailable; remembers tool only)',
      seconds: ZH ? '秒' : 's',
      settingsTitle: ZH ? '手机桥接' : 'Mobile Bridge',
      paired: ZH ? '已配对设备' : 'Paired devices',
      online: ZH ? '在线' : 'online',
      pending: ZH ? '待审批' : 'Pending approvals',
      rules: ZH ? 'always 规则' : 'Always rules',
      approvalTimeout: ZH ? '审批超时' : 'Approval timeout',
      address: ZH ? '访问地址' : 'Access URL',
      pairCode: ZH ? '生成配对码' : 'New pairing code',
      pairHint: ZH ? '用手机扫描二维码，或打开地址后输入配对码。' : 'Scan the QR code, or open the URL and enter the code.',
      desktopOnly: ZH ? '仅在桌面端（本机）可生成配对码。' : 'Pairing codes can only be created on the desktop.',
      devicesTitle: ZH ? '设备管理' : 'Device management',
      deviceOnline: ZH ? '在线' : 'Online',
      deviceOffline: ZH ? '离线' : 'Offline',
      deviceRevoked: ZH ? '已撤销' : 'Revoked',
      boundAt: ZH ? '绑定于' : 'Bound',
      lastSeen: ZH ? '最近活跃' : 'Last seen',
      revoke: ZH ? '撤销' : 'Revoke',
      revokeAll: ZH ? '全部撤销' : 'Revoke all',
      purgeRevoked: ZH ? '清除已撤销记录' : 'Clear revoked',
      confirmRevoke: ZH
        ? '确认撤销该设备？撤销后该手机需要重新配对才能接入。'
        : 'Revoke this device? It must re-pair to connect again.',
      confirmRevokeAll: ZH
        ? '确认撤销全部设备？所有已配对的手机都会立即断开。'
        : 'Revoke all devices? Every paired phone disconnects immediately.',
      confirmPurge: ZH
        ? '清除全部已撤销记录？此操作不可撤销（不影响当前在用设备）。'
        : 'Clear all revoked records? This cannot be undone (active devices unaffected).',
      noDevices: ZH ? '暂无已绑定设备。' : 'No bound devices yet.',
      deviceDesktopOnly: ZH
        ? '设备管理仅可在桌面端（本机）操作。'
        : 'Device management is only available on the desktop.',
      devicesLoadError: ZH
        ? '设备列表加载失败：请刷新页面；若仍失败，说明桌面插件未加载最新版本，请重启 DSH Desktop 后再试。'
        : 'Failed to load devices. Refresh; if it persists, restart DSH Desktop so the plugin loads the latest version.',
      clientLoaded: ZH ? '手机端已加载' : 'Client half loaded',
      refresh: ZH ? '刷新' : 'Refresh',
      tunnel: ZH ? '公网隧道' : 'Tunnel',
      tunnelStarting: ZH ? '启动中…' : 'starting…',
      tunnelDown: ZH ? '未运行' : 'not running',
      addressFixed: ZH
        ? '固定地址：重启/掉线后不变，可保存二维码长期使用。'
        : 'Fixed address: stable across restarts — safe to save this QR.',
      addressTemporary: ZH
        ? '临时地址：每次重启会变，换地址后需重新扫码。建议改用固定域名隧道。'
        : 'Temporary address: changes on restart — re-scan needed. A fixed-domain tunnel is recommended.',
      tsTitle: ZH ? 'Tailscale 一键接入' : 'Tailscale setup',
      tsLoading: ZH ? '检测中…' : 'Detecting…',
      tsNotInstalled: ZH ? '未检测到 Tailscale' : 'Tailscale not installed',
      tsNotLogged: ZH ? 'Tailscale 已安装，未登录' : 'Tailscale installed, not signed in',
      tsIpLabel: ZH ? '本机 Tailscale IP' : 'Tailscale IP',
      tsNameLabel: ZH ? '固定域名' : 'Name',
      tsFunnelLabel: ZH ? '公网 Funnel' : 'Funnel',
      tsInstall: ZH ? '一键安装 Tailscale' : 'Install Tailscale',
      tsLogin: ZH ? '登录 Tailscale' : 'Sign in Tailscale',
      tsEnableFunnel: ZH ? '开启公网 Funnel' : 'Enable Funnel',
      tsDisableFunnel: ZH ? '关闭 Funnel' : 'Disable Funnel',
      tsPin: ZH ? '设为固定地址' : 'Use as fixed address',
      tsEnableHint: ZH
        ? '请在浏览器打开下面链接，启用 Funnel 后回来点「刷新」：'
        : 'Open the link below to enable Funnel, then tap Refresh:',
      tsLoginHint: ZH ? '请在浏览器打开下面链接完成登录：' : 'Open the link below to sign in:',
      tsPending: ZH ? '已发起，请在打开的页面完成操作，然后点「刷新」。' : 'Started — finish in the opened page, then Refresh.',
      tsDone: ZH ? '操作完成。' : 'Done.',
      tsFail: ZH ? '操作失败，请稍后重试。' : 'Action failed, try again later.',
      tsPinned: ZH ? '已设为固定地址，二维码已更新。' : 'Fixed address set; QR updated.',
      tsFallbackHint: ZH
        ? '连不通时请退回「公网隧道(cloudflared)」或局域网（同 WiFi 直连）。'
        : 'If unreachable, fall back to the cloudflared tunnel or LAN (same Wi-Fi).',
      cfTitle: ZH ? 'Cloudflare 固定域名（命名隧道）' : 'Cloudflare fixed domain (named tunnel)',
      cfLoading: ZH ? '检测中…' : 'Detecting…',
      cfNoBin: ZH ? '未检测到 cloudflared，请先安装' : 'cloudflared not installed',
      cfMode: ZH ? '模式' : 'Mode',
      cfAddr: ZH ? '当前地址' : 'Address',
      cfTokenSaved: ZH ? '已保存 token' : 'token saved',
      cfTokenPh: ZH ? '连接器 token（cloudflared tunnel token）' : 'Connector token',
      cfDomainPh: ZH ? '固定域名，如 https://dsh.example.com' : 'Fixed domain e.g. https://dsh.example.com',
      cfSave: ZH ? '保存并启用固定域名' : 'Save & enable',
      cfClear: ZH ? '清除（回到临时隧道）' : 'Clear (back to quick)',
      cfOk: ZH ? '已启用，约几十秒生效后点「刷新」验证。' : 'Enabled — wait ~30s then Refresh.',
      cfBadToken: ZH ? 'token 为空或太短' : 'token empty/too short',
      cfBadDomain: ZH ? '域名必须以 https:// 开头' : 'Domain must start with https://',
      cfReachable: ZH ? '公网可达' : 'Public reachable',
      cfHelp: ZH
        ? '在 Cloudflare Zero Trust → Networks → Tunnels 新建命名隧道并复制连接器 token；给隧道加 Public Hostname 指向 http://127.0.0.1:8787；把该域名填到下面。免费域名可用 EU.org / us.kg（把 NS 指到 Cloudflare）。'
        : 'Create a named tunnel in Cloudflare Zero Trust → Networks → Tunnels, copy the connector token, add a Public Hostname to http://127.0.0.1:8787, and put that domain below. Free domains: EU.org / us.kg (point NS to Cloudflare).',
      cfSvcLabel: ZH ? '系统服务（开机常驻）' : 'System service (always on)',
      cfSvcInstall: ZH ? '注册为系统服务（开机常驻）' : 'Install as system service',
      cfSvcUninstall: ZH ? '卸载系统服务' : 'Uninstall system service',
      cfSvcRunning: ZH ? '系统服务：运行中' : 'System service: running',
      cfSvcInstalled: ZH ? '系统服务：已安装' : 'System service: installed',
      cfSvcOff: ZH ? '系统服务：未注册' : 'System service: not installed',
      cfNeedsAdmin: ZH
        ? '需要管理员权限：请以管理员身份运行 DSH 后重试；或在管理员 PowerShell 执行 cloudflared service install <token>。'
        : 'Needs admin: run DSH as administrator and retry, or run `cloudflared service install <token>` in an admin PowerShell.',
      cfSvcNote: ZH ? '已交由系统服务托管：开机自启，DSH/Desktop 重启不影响连接。' : 'Tunnel is hosted by the OS service: auto-start on boot, independent of DSH/Desktop restarts.',
      pairRequestTitle: ZH ? '配对请求' : 'Pairing request',
      pairRequestBody: ZH ? '有一台设备通过配对码请求接入。' : 'A device is asking to pair with a valid code.',
      pairFrom: ZH ? '来源' : 'from',
      allow: ZH ? '允许' : 'Allow',
      allowedText: ZH ? '已允许，等待手机进入…' : 'Allowed — waiting for the phone…',
      deniedText: ZH ? '已拒绝。' : 'Denied.',
      back: ZH ? '返回设置列表' : 'Back to settings list',
      linkLost: ZH
        ? '连接已中断：隧道地址可能已更换。请刷新页面；仍失败就回电脑上重新生成配对码并扫码。'
        : 'Connection lost: the tunnel address may have changed. Refresh; if it persists, re-pair from the desktop.',
    }

    const CSS = `
.dmb-overlay{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;
  padding:0 10px calc(10px + env(safe-area-inset-bottom)) 10px;pointer-events:none}
.dmb-card{pointer-events:auto;width:100%;max-width:560px;background:var(--dsw-specific-input-major,#fff);
  color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-state-warn-secondary,#e0b44a);
  border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.dmb-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--dsw-alias-state-warn-tertiary,#fff7e6);
  color:var(--dsw-alias-state-warn-primary,#8a5a00);font-size:13px}
.dmb-dot{width:8px;height:8px;border-radius:50%;background:#e0a526}
.dmb-body{padding:12px 14px 0;max-height:42vh;overflow:auto}
.dmb-tool{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmb-badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:#fff1f2;color:#be123c;border:1px solid #fecdd3}
.dmb-badge.normal{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
.dmb-sum{margin-top:8px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
  color:var(--dsw-alias-label-tertiary,#555);background:rgba(127,127,127,.08);border-radius:8px;padding:8px 10px;max-height:22vh;overflow:auto}
.dmb-pattern{margin-top:8px;font-size:12px;color:#0f766e;background:rgba(13,148,136,.1);border-radius:8px;padding:6px 10px;word-break:break-all}
.dmb-foot{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-wrap:wrap}
.dmb-timer{margin-right:auto;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-tertiary,#666)}
.dmb-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:10px;
  padding:9px 14px;font-size:14px;font-weight:600;min-height:40px;cursor:pointer}
.dmb-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.dmb-btn.danger{color:#b91c1c;border-color:#fca5a5}
.dmb-btn[disabled]{opacity:.5;cursor:default}
.dmb-settings{padding:16px;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;width:100%;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;overflow:auto;max-height:100%;-webkit-overflow-scrolling:touch}
.dmb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,120px),1fr));gap:10px;margin:12px 0}
.dmb-cell{border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:10px 12px;background:rgba(127,127,127,.05);min-width:0;overflow-wrap:anywhere}
.dmb-cell b{display:block;font-size:19px;line-height:1.2;margin-top:2px;word-break:break-word}
.dmb-muted{color:var(--dsw-alias-label-tertiary,#666);font-size:12px;overflow-wrap:anywhere}
.dmb-addr{word-break:break-all;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,Consolas,monospace;background:rgba(127,127,127,.08);padding:8px 10px;border-radius:8px;margin:8px 0;max-width:100%;box-sizing:border-box}
.dmb-qr{display:block;width:100%;max-width:220px;margin:10px auto;border-radius:10px;background:#fff;padding:6px;box-sizing:border-box}
.dmb-settings .dmb-btn{margin-top:8px;width:100%;max-width:100%;box-sizing:border-box}
.dmb-devices{margin-top:16px;border-top:1px solid rgba(127,127,127,.25);padding-top:14px}
.dmb-ts{margin-top:16px;border-top:1px solid rgba(127,127,127,.25);padding-top:14px}
.dmb-ts .dmb-device-actions{margin-top:8px;justify-content:flex-start}
.dmb-cf{margin-top:16px;border-top:1px solid rgba(127,127,127,.25);padding-top:14px}
.dmb-cf input{width:100%;box-sizing:border-box;margin-top:6px;padding:8px 10px;border:1px solid rgba(127,127,127,.35);
  border-radius:8px;font:inherit;font-size:13px;background:var(--dsw-specific-input-major,#fff);color:inherit}
.dmb-cf .dmb-device-actions{margin-top:8px;justify-content:flex-start}
.dmb-devices-title{font-weight:600;font-size:13px;margin-bottom:8px}
.dmb-device{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;border:1px solid rgba(127,127,127,.25);
  border-radius:12px;padding:10px 12px;background:rgba(127,127,127,.05);min-width:0;overflow-wrap:anywhere;margin-bottom:8px}
.dmb-device-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 160px}
.dmb-device-name{font-weight:600;overflow-wrap:anywhere}
.dmb-device-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#666);overflow-wrap:anywhere}
.dmb-device-status{display:inline-block;font-size:11px;font-weight:600;line-height:1.5;padding:1px 8px;
  border-radius:999px;border:1px solid rgba(127,127,127,.35);color:var(--dsw-alias-label-tertiary,#666);white-space:nowrap}
.dmb-device-status.on,.dmb-device-status--on{color:#047857;border-color:#a7f3d0;background:#ecfdf5}
.dmb-device-status.off,.dmb-device-status--off{color:#6b7280;border-color:#d1d5db;background:#f3f4f6}
.dmb-device-status.revoked,.dmb-device-status--revoked{color:#b91c1c;border-color:#fecdd3;background:#fff1f2}
.dmb-device-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-left:auto}
.dmb-device-actions .dmb-btn,.dmb-settings .dmb-device-actions .dmb-btn{width:auto;max-width:none;margin-top:0;padding:6px 10px;min-height:32px;font-size:13px}
@media (max-width:420px){.dmb-device-actions{margin-left:0;width:100%}}
/* 窄屏设置抽屉：改成「列表 → 详情」两级导航（逻辑见 installSettingsNav）。
   宿主的设置抽屉是「左导航 + 右内容」双栏固定布局，360dp 下导航吃掉大半宽度、
   内容只剩一点点，文字叠在一起。窄屏下这里改为：
     列表态：只显示导航，导航占满抽屉；
     详情态：抽屉铺满视口、内容占满宽度、导航隐藏，左上角出现返回箭头。
   注意：不用 @media 判宽，而是由 JS 打 data-dmb-narrow。
   原因（真机实测）：华为浏览器开「桌面版网站」时 UA 是桌面 UA、viewport meta 被忽略，
   布局宽度固定 980px 再整体缩放，max-width 媒体查询全部不生效。
   JS 用 screen.width 判设备宽度，比媒体查询可靠。
   其余选择器基于 CSS-module 语义后缀（_nav/_content/_options），跨构建稳定。 */
[data-dmb-settings][data-dmb-narrow="1"][data-dmb-mode="list"] [data-dmb-content]{display:none !important}
[data-dmb-settings][data-dmb-narrow="1"][data-dmb-mode="list"] [data-dmb-nav]{
  width:100% !important;max-width:none !important;flex:1 1 auto !important}
[data-dmb-settings][data-dmb-narrow="1"][data-dmb-mode="detail"]{
  width:100vw !important;max-width:100vw !important}
[data-dmb-settings][data-dmb-narrow="1"][data-dmb-mode="detail"] [data-dmb-nav]{display:none !important}
[data-dmb-settings][data-dmb-narrow="1"][data-dmb-mode="detail"] [data-dmb-content]{
  width:100% !important;max-width:none !important;flex:1 1 auto !important}
[data-dmb-settings] [data-dmb-content] [class*="_options"]{overflow-x:hidden !important}
.dmb-nav-back{position:fixed;z-index:2147482140;display:flex;align-items:center;justify-content:center;
  width:40px;height:40px;border-radius:50%;border:1px solid rgba(127,127,127,.35);
  background:rgba(127,127,127,.14);color:inherit;font-size:22px;line-height:1;cursor:pointer;
  -webkit-tap-highlight-color:transparent;backdrop-filter:blur(6px)}
.dmb-nav-back:active{background:rgba(127,127,127,.28)}
/* 图标按钮保圆：宿主注入的全局 button{min-height:40px} 会把 36x36 的图标按钮
   撑成 36x40、28x28 撑成 28x40，视觉上就是椭圆。这里只对运行时标记过的按钮
   取消 min-height 并强制正方形（见 installIconButtonFix），文字按钮不受影响。 */
button[data-dmb-icon]{min-height:0 !important;aspect-ratio:1 / 1 !important}
button[data-dmb-icon][data-dmb-tiny]{min-width:24px !important;min-height:24px !important}
/* 隧道断开提示条 */
.dmb-banner{position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:2147482500;
  display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;
  background:#7f1d1d;color:#fee2e2;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  box-shadow:0 8px 24px rgba(0,0,0,.35)}
.dmb-banner span{flex:1 1 auto;min-width:0}
.dmb-banner-btn{flex:0 0 auto;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,.4);
  background:rgba(255,255,255,.14);color:inherit;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
/* 窄屏侧栏：宿主是桌面双栏布局，侧栏展开时占 ~280px，360dp 下主内容只剩几十像素。
   收起态（默认态）是 56px 细条，留在宿主 grid 流里即可，不能 fixed 也不能带
   全屏 scrim（否则右侧主会话窗口永远蒙灰）；只有展开态才改成浮层 + 全屏遮罩。
   展开态打在宿主侧栏根上的 data-dmb-overlay 由 installSidebarState 维护：
   宿主新版把展开根的 _quietBars/_collapsed 类都摘掉了，旧的类名选择器打不到展开态。 */
html[data-dmb-narrow="1"] [class*="_root"][class*="_quietBars"]{
  overflow-y:auto;overscroll-behavior:contain}
html[data-dmb-narrow="1"] [data-dmb-overlay]{
  position:fixed !important;left:0;top:0;bottom:0;z-index:1050 !important;
  box-shadow:0 0 0 100vmax rgba(0,0,0,.42), 0 18px 40px rgba(0,0,0,.3);
  overflow-y:auto;overscroll-behavior:contain}
html[data-dmb-narrow="1"][data-dmb-sidebar-open="1"] [class*="_frame"]{
  grid-template-columns:0px minmax(0,1fr) 0px !important}
/* 侧栏展开时盖在内容上的一层透明点击层：灰色来自上面的 box-shadow，
   本层只负责接住「点灰色区域」的点击 → 收起侧栏（并阻止穿透到被遮住的内容）。 */
.dmb-scrim{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1049;background:transparent;display:none;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation}
/* 宿主「提问卡片」（dsh-client-ui-user-questions，类前缀 wnLwla_）：窄屏下会被挤在
   会话列里、标题/选项不换行导致变形。这里在窄屏把它铺满视口并强制换行，
   底部按钮完整可点。选择器只命中该组件类，不影响其它 UI。 */
html[data-dmb-narrow="1"] .wnLwla_frame{
  box-sizing:border-box!important;width:100vw!important;max-width:100vw!important;
  margin-left:calc(50% - 50vw)!important;margin-right:calc(50% - 50vw)!important;
  padding-left:10px!important;padding-right:10px!important}
html[data-dmb-narrow="1"] .wnLwla_card{width:100%!important;max-width:100%!important;max-height:100dvh!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior:contain!important}
html[data-dmb-narrow="1"] .wnLwla_header{padding:16px 12px 0 16px!important;gap:8px!important}
html[data-dmb-narrow="1"] .wnLwla_headingBlock{flex:1 1 auto!important;min-width:0!important}
html[data-dmb-narrow="1"] .wnLwla_title{white-space:normal!important;overflow:visible!important;text-overflow:clip!important;overflow-wrap:anywhere!important}
html[data-dmb-narrow="1"] .wnLwla_detail{overflow-wrap:anywhere!important}
html[data-dmb-narrow="1"] .wnLwla_options{padding-left:8px!important;padding-right:8px!important}
html[data-dmb-narrow="1"] .wnLwla_option{padding:8px 10px!important}
html[data-dmb-narrow="1"] .wnLwla_optionLine,
html[data-dmb-narrow="1"] .wnLwla_optionLabel,
html[data-dmb-narrow="1"] .wnLwla_optionCopy{display:block!important;white-space:normal!important;overflow:visible!important;
  overflow-wrap:anywhere!important;word-break:break-word!important;-webkit-line-clamp:unset!important}
html[data-dmb-narrow="1"] .wnLwla_footer,
html[data-dmb-narrow="1"] .wnLwla_footerActions{flex-wrap:wrap!important;gap:8px!important}
html[data-dmb-narrow="1"] .wnLwla_progress,
html[data-dmb-narrow="1"] .wnLwla_waitStatus,
html[data-dmb-narrow="1"] .wnLwla_waitButton{white-space:normal!important}
/* 窄屏收起态 rail 空白处的「› 展开」提示：放在左下角头像正上方，点击该空白区域即展开侧栏。 */
.dmb-rail-hint{position:fixed;z-index:1040;left:8px;bottom:calc(74px + env(safe-area-inset-bottom,0px));width:40px;display:none;
  flex-direction:column;align-items:center;gap:2px;color:var(--dsw-alias-label-tertiary,#8a8f98);
  font-size:10px;line-height:1.2;pointer-events:none;user-select:none}
.dmb-rail-hint .chev{font-size:20px;line-height:1}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-mobile-bridge="' + STYLE_ID + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.dshMobileBridge = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function postDecision(requestId, decision) {
      try {
        return fetch(BASE + '/decision', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, decision }),
        })
      } catch (error) {
        return Promise.reject(error)
      }
    }

    function useApprovalFeed() {
      const [items, setItems] = react.useState([])
      const [pairRequests, setPairRequests] = react.useState([])
      react.useEffect(() => {
        if (typeof EventSource === 'undefined') return undefined
        let source
        let closed = false
        let retry

        const connect = () => {
          if (closed) return
          try {
            source = new EventSource(BASE + '/events', { withCredentials: true })
          } catch {
            retry = setTimeout(connect, 3000)
            return
          }
          source.onmessage = (event) => {
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message.type === 'approval' && message.request) {
              const request = message.request
              setItems((previous) =>
                previous.some((entry) => entry.requestId === request.requestId) ? previous : [...previous, request],
              )
            } else if (message.type === 'approval-resolved') {
              setItems((previous) => previous.filter((entry) => entry.requestId !== message.requestId))
            } else if (message.type === 'pair-request' && message.confirmId) {
              // broadcastLoopback 只发桌面；手机不会收到配对请求卡片
              setPairRequests((previous) =>
                previous.some((entry) => entry.confirmId === message.confirmId)
                  ? previous
                  : [...previous, message],
              )
            } else if (message.type === 'pair-request-resolved') {
              setPairRequests((previous) => previous.filter((entry) => entry.confirmId !== message.confirmId))
            }
          }
          source.onerror = () => {
            try {
              source.close()
            } catch {
              /* ignore */
            }
            if (!closed) retry = setTimeout(connect, 3000)
          }
        }

        connect()
        return () => {
          closed = true
          if (retry !== undefined) clearTimeout(retry)
          try {
            source?.close()
          } catch {
            /* ignore */
          }
        }
      }, [])
      return [items, setItems, pairRequests]
    }

    function useCountdown(expiresAt) {
      const [left, setLeft] = react.useState(() => Math.max(0, Number(expiresAt ?? 0) - Date.now()))
      react.useEffect(() => {
        const tick = () => setLeft(Math.max(0, Number(expiresAt ?? 0) - Date.now()))
        tick()
        const timer = setInterval(tick, 500)
        return () => clearInterval(timer)
      }, [expiresAt])
      return left
    }

    function Card(props) {
      const { request, onDecide } = props
      const [busy, setBusy] = react.useState(false)
      const remaining = useCountdown(request.expiresAt)
      const expired = remaining <= 0
      const seconds = Math.ceil(remaining / 1000)
      const high = request.risk === 'high'

      const decide = (decision) => {
        if (busy || expired) return
        setBusy(true)
        onDecide(request.requestId, decision).finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'dmb-overlay' },
        h(
          'div',
          { className: 'dmb-card', role: 'dialog', 'aria-label': T.title },
          h(
            'div',
            { className: 'dmb-head' },
            h('span', { className: 'dmb-dot' }),
            expired ? T.timeout : T.waiting,
          ),
          h(
            'div',
            { className: 'dmb-body' },
            h(
              'div',
              { className: 'dmb-tool' },
              request.toolName || 'tool',
              h('span', { className: 'dmb-badge' + (high ? '' : ' normal') }, high ? T.high : T.normal),
            ),
            request.summary ? h('div', { className: 'dmb-sum' }, request.summary) : null,
            request.pattern
              ? h('div', { className: 'dmb-pattern' }, T.remember + ' ' + request.pattern.label)
              : null,
            request.argsRecognized === false
              ? h('div', { className: 'dmb-pattern' }, T.argsUnknown)
              : null,
          ),
          h(
            'div',
            { className: 'dmb-foot' },
            h('span', { className: 'dmb-timer' }, expired ? T.timeout : seconds + T.seconds),
            h(
              'button',
              { className: 'dmb-btn danger', disabled: busy || expired, onClick: () => decide('reject'), type: 'button' },
              T.reject,
            ),
            h(
              'button',
              { className: 'dmb-btn', disabled: busy || expired, onClick: () => decide('always'), type: 'button' },
              T.always,
            ),
            h(
              'button',
              { className: 'dmb-btn primary', disabled: busy || expired, onClick: () => decide('once'), type: 'button' },
              T.once,
            ),
          ),
        ),
      )
    }

    /** 桌面确认卡：非 loopback 来源的手机配对需要人在电脑前点允许（/devices/confirm 仅 loopback 可达）。 */
    function PairCard(props) {
      const { request } = props
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(undefined)

      const resolve = (decision) => {
        if (busy) return
        setBusy(true)
        fetch(BASE + '/devices/confirm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmId: request.confirmId, decision }),
        })
          .then((response) => response.json().catch(() => ({})))
          .then((json) => {
            if (decision === 'allow') setNote(json?.ok === true ? T.allowedText : `${T.pairRequestTitle}: limit`)
            else setNote(T.deniedText)
          })
          .catch(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'dmb-overlay' },
        h(
          'div',
          { className: 'dmb-card', role: 'dialog', 'aria-label': T.pairRequestTitle },
          h(
            'div',
            { className: 'dmb-head' },
            h('span', { className: 'dmb-dot' }),
            T.pairRequestTitle,
          ),
          h(
            'div',
            { className: 'dmb-body' },
            h('div', { className: 'dmb-tool' }, request.name || 'phone'),
            h('div', { className: 'dmb-sum' }, `${T.pairRequestBody}\n${T.pairFrom}: ${request.source || '—'}`),
            note ? h('div', { className: 'dmb-pattern' }, note) : null,
          ),
          h(
            'div',
            { className: 'dmb-foot' },
            h('span', { className: 'dmb-timer' }),
            h(
              'button',
              { className: 'dmb-btn danger', disabled: busy, onClick: () => resolve('deny'), type: 'button' },
              T.reject,
            ),
            h(
              'button',
              { className: 'dmb-btn primary', disabled: busy, onClick: () => resolve('allow'), type: 'button' },
              T.allow,
            ),
          ),
        ),
      )
    }

    function ApprovalOverlay() {
      ensureStyle()
      const [items, setItems, pairRequests] = useApprovalFeed()
      let tree = null
      if (items.length > 0) {
        const request = items[0]
        const onDecide = (requestId, decision) => {
          setItems((previous) => previous.filter((entry) => entry.requestId !== requestId))
          return postDecision(requestId, decision).catch(() => undefined)
        }
        tree = h(Card, { request, onDecide })
      } else if (pairRequests.length > 0) {
        tree = h(PairCard, { request: pairRequests[0] })
      }
      if (tree === null) return null
      return reactDom ? reactDom.createPortal(tree, document.body) : tree
    }

    function sendHello(note) {
      try {
        fetch(BASE + '/client-hello', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note, href: String(location.href).slice(0, 200) }),
        }).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }

    function useOverview() {
      const [data, setData] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(BASE + '/overview', { credentials: 'same-origin' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((json) => {
              if (alive && json) setData(json)
            })
            .catch(() => undefined)
        }
        load()
        const timer = setInterval(load, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return data
    }

    function useDevices(enabled) {
      const [data, setData] = react.useState({ devices: [], online: [], maxDevices: undefined })
      const [error, setError] = react.useState(false)
      const [nonce, setNonce] = react.useState(0)
      const reload = () => setNonce((value) => value + 1)
      react.useEffect(() => {
        if (enabled !== true) return undefined
        let alive = true
        const load = () => {
          fetch(BASE + '/devices.json', { credentials: 'same-origin' })
            .then((response) => {
              if (response.ok !== true) {
                // 宿主未加载最新路由（旧进程）或网络异常时，明确报错而不是静默显示「暂无设备」。
                if (alive) setError(true)
                return undefined
              }
              return response.json()
            })
            .then((json) => {
              if (alive && json?.ok === true) {
                setError(false)
                setData({
                  devices: Array.isArray(json.devices) ? json.devices : [],
                  online: Array.isArray(json.online) ? json.online : [],
                  maxDevices: json.maxDevices,
                })
              }
            })
            .catch(() => {
              if (alive) setError(true)
            })
        }
        load()
        const timer = setInterval(load, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [enabled, nonce])
      return { ...data, error, reload }
    }

    const pad2 = (value) => String(value).padStart(2, '0')
    const shortTime = (ms) => {
      const date = new Date(ms)
      if (!Number.isFinite(Number(ms)) || Number.isNaN(date.getTime())) return '—'
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** 设备列表与撤销操作：仅桌面端渲染。 */
    function DeviceManager() {
      const { devices, online, error, reload } = useDevices(true)
      const [busy, setBusy] = react.useState('')

      const act = (key, path, body, question) => {
        if (busy !== '') return
        if (window.confirm(question) !== true) return
        setBusy(key)
        fetch(BASE + path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((response) => {
            if (response.ok) reload()
          })
          .catch(() => undefined)
          .finally(() => setBusy(''))
      }

      const active = devices.filter((device) => device.revoked !== true)
      const revoked = devices.filter((device) => device.revoked === true)

      return h(
        'div',
        { className: 'dmb-devices' },
        h('div', { className: 'dmb-devices-title' }, T.devicesTitle),
        error ? h('div', { className: 'dmb-muted' }, T.devicesLoadError) : null,
        devices.length === 0 && error !== true
          ? h('div', { className: 'dmb-muted' }, T.noDevices)
          : devices.map((device) => {
              const isRevoked = device.revoked === true
              const status = isRevoked
                ? { className: 'revoked', label: T.deviceRevoked }
                : online.includes(device.deviceId)
                  ? { className: 'on', label: T.deviceOnline }
                  : { className: 'off', label: T.deviceOffline }
              const id = String(device.deviceId ?? '')
              return h(
                'div',
                { className: 'dmb-device', key: id },
                h(
                  'div',
                  { className: 'dmb-device-main' },
                  h('div', { className: 'dmb-device-name' }, device.name || 'phone'),
                  h('div', { className: 'dmb-device-meta' }, id.length > 10 ? `${id.slice(0, 10)}…` : id),
                  h('div', { className: 'dmb-device-meta' }, `${T.boundAt} ${shortTime(device.createdAt)}`),
                  h('div', { className: 'dmb-device-meta' }, `${T.lastSeen} ${shortTime(device.lastSeen)}`),
                ),
                h(
                  'span',
                  { className: `dmb-device-status dmb-device-status--${status.className}` },
                  status.label,
                ),
                isRevoked
                  ? null
                  : h(
                      'div',
                      { className: 'dmb-device-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dmb-btn danger',
                          disabled: busy !== '',
                          onClick: () =>
                            act(`revoke:${id}`, '/devices/revoke', { deviceId: id }, T.confirmRevoke),
                        },
                        T.revoke,
                      ),
                    ),
              )
            }),
        active.length > 0
          ? h(
              'div',
              { className: 'dmb-device-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmb-btn danger',
                  disabled: busy !== '',
                  onClick: () => act('revoke-all', '/devices/revoke-all', {}, T.confirmRevokeAll),
                },
                T.revokeAll,
              ),
            )
          : null,
        revoked.length > 0
          ? h(
              'div',
              { className: 'dmb-device-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmb-btn',
                  disabled: busy !== '',
                  onClick: () => act('purge', '/devices/purge', {}, T.confirmPurge),
                },
                T.purgeRevoked,
              ),
            )
          : null,
      )
    }

    /** Tailscale 一键接入卡片（仅桌面 loopback）：检测状态 + 一键登录/开 Funnel + 固定地址。 */
    function TailscaleCard() {
      ensureStyle()
      const [st, setSt] = react.useState(undefined)
      const [busy, setBusy] = react.useState('')
      const [msg, setMsg] = react.useState(undefined)
      const load = () => {
        fetch(BASE + '/tailscale.json', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : undefined))
          .then((j) => {
            if (j && j.ok === true) setSt(j)
          })
          .catch(() => undefined)
      }
      react.useEffect(() => {
        load()
      }, [])
      const act = (action) => {
        if (busy !== '') return
        setBusy(action)
        setMsg(undefined)
        fetch(BASE + '/tailscale/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
          .then((r) => r.json())
          .then((j) => {
            setBusy('')
            if (j && j.needEnable && j.enableUrl) setMsg({ text: T.tsEnableHint, url: j.enableUrl })
            else if (j && j.needLogin && j.url) setMsg({ text: T.tsLoginHint, url: j.url })
            else if (j && j.pending) setMsg({ text: T.tsPending })
            else if (j && j.ok === false && j.error) setMsg({ text: T.tsFail + ' (' + j.error + ')' })
            else {
              setMsg({ text: j && j.output ? T.tsDone + ' ' + String(j.output).slice(0, 160) : T.tsDone })
              load()
            }
          })
          .catch(() => {
            setBusy('')
            setMsg({ text: T.tsFail })
          })
      }
      const pin = () => {
        if (!st || !st.dnsName) return
        setBusy('pin')
        setMsg(undefined)
        fetch(BASE + '/tailscale/pin', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publicBase: 'https://' + st.dnsName }),
        })
          .then((r) => r.json())
          .then((j) => {
            setBusy('')
            if (j && j.ok) {
              setMsg({ text: T.tsPinned })
              load()
            } else setMsg({ text: T.tsFail })
          })
          .catch(() => {
            setBusy('')
            setMsg({ text: T.tsFail })
          })
      }
      const installed = st !== undefined && st.installed === true
      const loggedIn = installed && st.loggedIn === true
      const funnelOn = installed && st.funnel !== undefined && st.funnel.on === true
      const statusText =
        st === undefined
          ? T.tsLoading
          : installed !== true
            ? T.tsNotInstalled
            : loggedIn !== true
              ? T.tsNotLogged
              : `${T.tsIpLabel}: ${st.ip || '—'} · ${T.tsNameLabel}: ${st.dnsName || '—'}`
      return h(
        'div',
        { className: 'dmb-ts' },
        h('div', { className: 'dmb-devices-title' }, T.tsTitle),
        h('div', { className: 'dmb-muted' }, statusText),
        installed === true
          ? h('div', { className: 'dmb-muted' }, `${T.tsFunnelLabel}: ${funnelOn ? st.funnel.url || 'on' : 'off'}`)
          : null,
        st && st.publicBase ? h('div', { className: 'dmb-addr' }, st.publicBase) : null,
        h(
          'div',
          { className: 'dmb-device-actions' },
          h('button', { type: 'button', className: 'dmb-btn', onClick: load, disabled: busy !== '' }, T.refresh),
          installed !== true
            ? h('button', { type: 'button', className: 'dmb-btn primary', onClick: () => act('install'), disabled: busy !== '' }, T.tsInstall)
            : null,
          installed === true && loggedIn !== true
            ? h('button', { type: 'button', className: 'dmb-btn primary', onClick: () => act('login'), disabled: busy !== '' }, T.tsLogin)
            : null,
          loggedIn === true && funnelOn !== true
            ? h('button', { type: 'button', className: 'dmb-btn primary', onClick: () => act('funnel'), disabled: busy !== '' }, T.tsEnableFunnel)
            : null,
          loggedIn === true && funnelOn === true
            ? h('button', { type: 'button', className: 'dmb-btn', onClick: () => act('funnel-off'), disabled: busy !== '' }, T.tsDisableFunnel)
            : null,
          loggedIn === true && funnelOn === true && st.dnsName
            ? h('button', { type: 'button', className: 'dmb-btn', onClick: pin, disabled: busy !== '' }, T.tsPin)
            : null,
        ),
        msg
          ? h(
              'div',
              null,
              h('div', { className: 'dmb-muted' }, msg.text),
              msg.url ? h('div', { className: 'dmb-addr' }, msg.url) : null,
            )
          : null,
        h('div', { className: 'dmb-muted' }, T.tsFallbackHint),
      )
    }

    /** Cloudflare 固定域名（命名隧道）一键接入：填 token+域名 → 写本地文件、切 token 模式、重启隧道、验证。 */
    function CloudflareCard() {
      ensureStyle()
      const [st, setSt] = react.useState(undefined)
      const [token, setToken] = react.useState('')
      const [domain, setDomain] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [msg, setMsg] = react.useState(undefined)
      const load = () => {
        fetch(BASE + '/cloudflare.json', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : undefined))
          .then((j) => {
            if (j && j.ok === true) {
              setSt(j)
              if (j.configuredPublicBase && domain === '') setDomain(j.configuredPublicBase)
            }
          })
          .catch(() => undefined)
      }
      react.useEffect(() => {
        load()
      }, [])
      const save = () => {
        if (busy !== '') return
        if (token.trim().length < 20) {
          setMsg(T.cfBadToken)
          return
        }
        if (/^https:\/\//i.test(domain.trim()) !== true) {
          setMsg(T.cfBadDomain)
          return
        }
        setBusy('save')
        setMsg(undefined)
        fetch(BASE + '/cloudflare/setup', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: token.trim(), publicBase: domain.trim() }),
        })
          .then((r) => r.json())
          .then((j) => {
            setBusy('')
            if (j && j.ok) {
              setMsg(T.cfOk)
              setToken('')
              load()
            } else if (j && j.error === 'publicBase-must-be-https') setMsg(T.cfBadDomain)
            else if (j && j.error === 'token-too-short') setMsg(T.cfBadToken)
            else setMsg(T.tsFail + (j && j.error ? ' ' + j.error : ''))
          })
          .catch(() => {
            setBusy('')
            setMsg(T.tsFail)
          })
      }
      const clear = () => {
        if (busy !== '') return
        if (window.confirm(T.cfClear) !== true) return
        setBusy('clear')
        setMsg(undefined)
        fetch(BASE + '/cloudflare/clear', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then((r) => r.json())
          .then((j) => {
            setBusy('')
            setMsg(j && j.ok ? T.tsDone : T.tsFail)
            load()
          })
          .catch(() => {
            setBusy('')
            setMsg(T.tsFail)
          })
      }
      const installed = st !== undefined && st.cloudflaredInstalled === true
      const statusText =
        st === undefined ? T.cfLoading : installed !== true ? T.cfNoBin : `${T.cfMode}: ${st.mode || '—'}`
      const svcText =
        st === undefined
          ? null
          : st.serviceRunning === true
            ? T.cfSvcRunning
            : st.serviceInstalled === true
              ? T.cfSvcInstalled
              : T.cfSvcOff
      const act = (name, body) => {
        if (busy !== '') return
        setBusy(name)
        setMsg(undefined)
        fetch(`${BASE}/cloudflare/${name}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((r) => r.json())
          .then((j) => {
            setBusy('')
            if (j && j.ok) setMsg(name === 'service-install' ? T.cfSvcNote : T.tsDone)
            else if (j && j.error === 'needs-admin') setMsg(T.cfNeedsAdmin)
            else if (j && j.error === 'publicBase-must-be-https') setMsg(T.cfBadDomain)
            else if (j && j.error === 'token-too-short') setMsg(T.cfBadToken)
            else setMsg(T.tsFail + (j && j.error ? ' ' + j.error : ''))
            load()
          })
          .catch(() => {
            setBusy('')
            setMsg(T.tsFail)
          })
      }
      return h(
        'div',
        { className: 'dmb-cf' },
        h('div', { className: 'dmb-devices-title' }, T.cfTitle),
        h('div', { className: 'dmb-muted' }, statusText),
        st && st.publicBase ? h('div', { className: 'dmb-addr' }, st.publicBase) : null,
        st && st.hasToken
          ? h('div', { className: 'dmb-muted' }, T.cfTokenSaved + (st.configuredPublicBase ? ' · ' + st.configuredPublicBase : ''))
          : null,
        st && st.reachable !== undefined
          ? h('div', { className: 'dmb-muted' }, `${T.cfReachable}: ${st.reachable ? '✓' : '✗'}`)
          : null,
        svcText ? h('div', { className: 'dmb-muted' }, svcText) : null,
        h('input', {
          type: 'password',
          placeholder: T.cfTokenPh,
          value: token,
          onChange: (e) => setToken(e.target.value),
          autoComplete: 'off',
        }),
        h('input', {
          type: 'url',
          placeholder: T.cfDomainPh,
          value: domain,
          onChange: (e) => setDomain(e.target.value),
          autoComplete: 'off',
        }),
        h(
          'div',
          { className: 'dmb-device-actions' },
          h('button', { type: 'button', className: 'dmb-btn', onClick: load, disabled: busy !== '' }, T.refresh),
          h('button', { type: 'button', className: 'dmb-btn primary', onClick: save, disabled: busy !== '' }, T.cfSave),
          h('button', { type: 'button', className: 'dmb-btn', onClick: clear, disabled: busy !== '' }, T.cfClear),
          st && st.serviceInstalled !== true
            ? h('button', {
                type: 'button',
                className: 'dmb-btn',
                onClick: () => act('service-install', { token: token.trim(), publicBase: domain.trim() }),
                disabled: busy !== '',
              }, T.cfSvcInstall)
            : h('button', {
                type: 'button',
                className: 'dmb-btn',
                onClick: () => act('service-uninstall'),
                disabled: busy !== '',
              }, T.cfSvcUninstall),
        ),
        msg ? h('div', { className: 'dmb-muted' }, msg) : null,
        h('div', { className: 'dmb-muted' }, T.cfHelp),
        h('div', { className: 'dmb-muted' }, T.cfSvcNote),
      )
    }

    function Cell(props) {
      return h('div', { className: 'dmb-cell' }, props.label, h('b', null, props.value))
    }

    /** 插件详情里的设置页：回答「手机桥接现在是什么状态、怎么再配一台」。 */
    function SettingsPanel() {
      ensureStyle()
      const data = useOverview()
      const [pairing, setPairing] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)

      const requestCode = () => {
        if (busy) return
        setBusy(true)
        fetch(BASE + '/pairing.json', { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((json) => setPairing(json))
          .catch(() => undefined)
          .finally(() => setBusy(false))
      }

      const desktop = data?.loopback === true
      const timeoutText =
        data?.timeout === undefined
          ? '—'
          : `${Math.round(data.timeout.local / 1000)}s / ${Math.round(data.timeout.remote / 1000)}s`

      return h(
        'div',
        { className: 'dmb-settings' },
        h('div', { className: 'dmb-muted' }, T.address),
        h('div', { className: 'dmb-addr' }, data?.publicBase ?? '—'),
        data?.tunnel?.enabled === true
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dmb-muted' },
                `${T.tunnel} · ${
                  data.tunnel.running === true ? data.tunnel.url || T.tunnelStarting : T.tunnelDown
                }`,
              ),
              data?.tunnel?.mode === 'token' || !/trycloudflare\.com/i.test(String(data?.publicBase ?? ''))
                ? h('div', { className: 'dmb-muted' }, T.addressFixed)
                : h('div', { className: 'dmb-muted' }, T.addressTemporary),
            )
          : null,
        h(
          'div',
          { className: 'dmb-grid' },
          h(Cell, { label: T.paired, value: data === undefined ? '—' : `${data.devices.total}/${data.maxDevices}` }),
          h(Cell, { label: T.online, value: data === undefined ? '—' : String(data.devices.online) }),
          h(Cell, { label: T.pending, value: data === undefined ? '—' : String(data.pendingApprovals) }),
          h(Cell, { label: T.rules, value: data === undefined ? '—' : String(data.alwaysRules) }),
          h(Cell, { label: T.approvalTimeout, value: timeoutText }),
          h(Cell, { label: T.clientLoaded, value: data === undefined ? '—' : String(data.clientHalf) }),
        ),
        desktop
          ? h(
              'div',
              null,
              h(
                'button',
                { type: 'button', className: 'dmb-btn primary', onClick: requestCode, disabled: busy },
                T.pairCode,
              ),
              pairing?.code
                ? h(
                    'div',
                    null,
                    h('div', { className: 'dmb-muted' }, T.pairHint),
                    pairing.qrDataUrl
                      ? h('img', { className: 'dmb-qr', src: pairing.qrDataUrl, alt: T.pairCode })
                      : null,
                    h('div', { className: 'dmb-addr' }, `${pairing.publicBase ?? ''}`),
                    h('div', { className: 'dmb-addr' }, pairing.code),
                  )
                : null,
              h(DeviceManager, null),
              h(TailscaleCard, null),
              h(CloudflareCard, null),
            )
          : h(
              'div',
              null,
              h('div', { className: 'dmb-muted' }, T.desktopOnly),
              h('div', { className: 'dmb-muted' }, T.deviceDesktopOnly),
            ),
      )
    }

    /**
     * 窄屏设置抽屉的两级导航。
     *
     * 宿主设置抽屉是「左导航 + 右内容」双栏固定布局；360dp 手机上导航吃掉约 60%
     * 宽度，内容只剩 ~124px（实测），所有文字挤成一列互相重叠 —— 这是「设置页卡死」
     * 的真正观感来源，而且它影响宿主自己的分区（账号与余额等），不只是本插件。
     *
     * 这里在窄屏下把它改成两级导航：
     *   列表态：只显示导航，导航占满抽屉；
     *   详情态：抽屉铺满视口、内容占满宽度、导航隐藏，左上角出现返回箭头。
     * 定位全部用 CSS-module 语义后缀（_options/_panel/_nav/_content）匹配，
     * 宿主换 hash 前缀不影响；换语义名则规则自动失效，不会误伤其他面板。
     */
    function installSettingsNav() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      if (typeof document.body === 'undefined') return
      // 真机实测：华为浏览器开「桌面版网站」时 UA 为桌面、viewport meta 被忽略，
      // 布局宽度固定 980 再缩放，media query 判不出来。改用 screen.width 判设备宽度。
      const isNarrow = () => {
        const screenWidth = typeof window.screen === 'object' ? Number(window.screen.width) || 0 : 0
        return screenWidth > 0 && screenWidth <= 600 ? true : window.innerWidth <= 520
      }
      let root
      let back
      let frame = 0

      const tokensOf = (el) => {
        const cls = el === null || el === undefined ? undefined : el.className
        return typeof cls === 'string' && cls.trim() !== '' ? cls.trim().split(/\s+/) : []
      }
      const hasSuffix = (el, suffix) =>
        tokensOf(el).some((token) => token.length > suffix.length && token.slice(-suffix.length) === suffix)
      const climb = (el, suffix, depth) => {
        let node = el
        for (let index = 0; index < depth && node !== null && node !== undefined; index += 1) {
          if (hasSuffix(node, suffix)) return node
          node = node.parentElement
        }
        return undefined
      }
      const childWith = (parent, suffix) => {
        if (parent === null || parent === undefined) return undefined
        return [...parent.children].find((child) => hasSuffix(child, suffix))
      }

      function placeBack() {
        if (root === undefined || back === undefined) return
        const content = root.querySelector('[data-dmb-content]')
        const rect = (content ?? root).getBoundingClientRect()
        back.style.top = `${Math.max(8, Math.round(rect.top + 8))}px`
        back.style.left = `${Math.max(8, Math.round(rect.left + 8))}px`
        back.style.display = root.getAttribute('data-dmb-mode') === 'detail' ? 'flex' : 'none'
      }

      function setMode(mode) {
        if (root === undefined) return
        root.setAttribute('data-dmb-mode', mode)
        placeBack()
      }

      function cleanup() {
        if (root !== undefined) {
          const nav = childWith(root, '_nav')
          const content = childWith(root, '_content')
          root.removeAttribute('data-dmb-settings')
          root.removeAttribute('data-dmb-narrow')
          root.removeAttribute('data-dmb-mode')
          if (nav !== undefined) nav.removeAttribute('data-dmb-nav')
          if (content !== undefined) content.removeAttribute('data-dmb-content')
        }
        root = undefined
        if (back !== undefined) back.style.display = 'none'
      }

      function bind() {
        if (!isNarrow()) {
          cleanup()
          return
        }
        const options = [...document.querySelectorAll('[class*="_options"]')].find((el) => hasSuffix(el, '_options'))
        if (options === undefined) {
          cleanup()
          return
        }
        const panel = climb(options, '_panel', 6)
        if (panel === undefined) {
          cleanup()
          return
        }
        const nav = childWith(panel, '_nav')
        const content = childWith(panel, '_content')
        if (nav === undefined || content === undefined) {
          cleanup()
          return
        }
        if (root === panel) {
          placeBack()
          return
        }
        cleanup()
        root = panel
        root.setAttribute('data-dmb-settings', '')
        root.setAttribute('data-dmb-narrow', '1')
        root.setAttribute('data-dmb-mode', 'list')
        nav.setAttribute('data-dmb-nav', '')
        content.setAttribute('data-dmb-content', '')
        // 设置抽屉打开时自动收起侧栏浮层：不做 z-index 硬压，直接关掉侧栏，
        // 让抽屉右侧只剩主会话窗口、不残留全屏 scrim。抽屉关闭时不重新展开。
        if (document.documentElement.getAttribute('data-dmb-sidebar-open') === '1') {
          const sidebarRoot = document.querySelector('[data-dmb-overlay]')
          const toggle =
            (sidebarRoot && sidebarRoot.querySelector('[class*="_iconButton"][class*="_toggle"]')) ||
            (sidebarRoot && sidebarRoot.querySelector('button[aria-label*="收起"]'))
          if (toggle) toggle.click()
        }
        if (back === undefined) {
          back = document.createElement('button')
          back.type = 'button'
          back.className = 'dmb-nav-back'
          back.setAttribute('aria-label', T.back)
          back.textContent = '\u2039'
          back.addEventListener(
            'click',
            (event) => {
              event.preventDefault()
              event.stopPropagation()
              setMode('list')
            },
            true,
          )
          document.body.appendChild(back)
        }
        placeBack()
      }

      function schedule() {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          bind()
        })
      }

      // 点导航项 → 进详情态。用捕获阶段，保证在宿主自己的选中逻辑之前/之后都能生效。
      document.addEventListener(
        'click',
        (event) => {
          if (root === undefined) return
          const target = event.target
          if (target === null || target === undefined || typeof target.closest !== 'function') return
          if (target.closest('.dmb-nav-back') !== null) return
          const nav = root.querySelector('[data-dmb-nav]')
          if (nav !== null && nav.contains(target)) setMode('detail')
        },
        true,
      )
      window.addEventListener('resize', schedule, { passive: true })
      window.addEventListener('orientationchange', schedule, { passive: true })
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
      bind()
    }

    /**
     * 图标按钮保圆。
     *
     * 注入的 `button{min-height:40px}` 本意是保证触控高度，但它会命中宿主的
     * 图标按钮（原生 36x36 / 28x28），把高度撑到 40 → 变成椭圆或被拉长。
     * 这里运行期给「小尺寸 + 含 svg」的按钮打标记，CSS 只对它们取消 min-height
     * 并强制 aspect-ratio:1，宽按钮（带文字）仍保留 40px 触控高度。
     */
    function installIconButtonFix() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      // 同 installSettingsNav：桌面版网站模式下列局宽 980，media query 不可靠。
      const isNarrow = () => {
        const screenWidth = typeof window.screen === 'object' ? Number(window.screen.width) || 0 : 0
        return screenWidth > 0 && screenWidth <= 600 ? true : window.innerWidth <= 900
      }
      let frame = 0
      // 分裂按钮组的半边（如插件页「添加插件」的下拉触发钮）：宿主给一侧
      // 圆角置 0（如 12px 0 0 12px / 0 12px 12px 0），与另一半拼成一个整体，
      // 高度必须跟主按钮走（40px）。这类按钮即使小而含 svg 也不能强制
      // aspect-ratio:1 —— 否则缩成 32×32 小黑块，与主按钮高度错位。
      const isSplitSegment = (button) => {
        const corners = getComputedStyle(button).borderRadius.split(/\s+/).filter((token) => token !== '')
        // 四角既有直角又有圆角 → 这是分裂按钮组的半边（与另一半拼成完整圆角）
        const hasSquare = corners.some((token) => parseFloat(token) === 0)
        const hasRound = corners.some((token) => parseFloat(token) > 0)
        return hasSquare && hasRound
      }
      const mark = () => {
        // 双向再评估：已打标的按钮宽度变化（如收起 rail 36px 的按钮被展开的
        // 侧栏撑到 252px）后必须撤销标记，否则 aspect-ratio:1 把文字按钮
        // 撑成正方形巨块、把会话列表挤出视口。
        for (const button of document.querySelectorAll('button[data-dmb-icon]')) {
          const rect = button.getBoundingClientRect()
          if (rect.width > 48 || isSplitSegment(button)) {
            button.removeAttribute('data-dmb-icon')
            button.removeAttribute('data-dmb-tiny')
          } else if (rect.width >= 24 && button.hasAttribute('data-dmb-tiny')) {
            button.removeAttribute('data-dmb-tiny')
          }
        }
        if (!isNarrow()) return
        const candidates = document.querySelectorAll('button:not([data-dmb-icon])')
        for (const button of candidates) {
          const rect = button.getBoundingClientRect()
          // 图标按钮：小尺寸 + 含 svg；超窄按钮（如 toast 关闭）即使没 svg 也要保方。
          const iconLike = button.querySelector('svg') !== null && rect.width <= 48
          const tiny = rect.width > 0 && rect.width < 24
          if ((!iconLike && !tiny) || isSplitSegment(button)) continue
          button.setAttribute('data-dmb-icon', '')
          if (tiny) button.setAttribute('data-dmb-tiny', '')
        }
      }
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          mark()
        })
      }
      // 侧栏展开/收起是 CSS 过渡，MutationObserver 只能看到 DOM 变更，
      // 点击后再补两次延迟复查，确保最终宽度对应的标记被写入/撤销。
      const scheduleSettled = () => {
        schedule()
        window.setTimeout(mark, 120)
        window.setTimeout(mark, 520)
      }
      document.addEventListener('click', scheduleSettled, true)
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
      schedule()
    }

    /**
     * 移动网络 / 隧道抖动兜底。
     *
     * 真机实测：cloudflared quick tunnel 重启后地址会变，已经打开的手机页面还在用旧域名，
     * 所有 API 调用都被 Cloudflare 边缘回 530（gateway/internal，回源不可达），表现为
     * 「消息发不出去」。这里做两件事：
     *   1. 对 /api/ 的 502/503/504/529/530 做有限重试（body 可重放的请求才重试）；
     *   2. 连续失败后给一条明确提示，告诉用户刷新/重新扫码，而不是静默失败。
     */
    function installTransportResilience() {
      if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
      if (window.__dmbTransportPatched === true) return
      const original = window.fetch.bind(window)
      window.__dmbTransportPatched = true
      const RETRY_STATUS = [502, 503, 504, 529, 530]
      const MAX_RETRY = 2
      let bannerShownAt = 0

      const showBanner = () => {
        const now = Date.now()
        if (now - bannerShownAt < 20000) return
        bannerShownAt = now
        try {
          let banner = document.getElementById('dmb-transport-banner')
          if (banner === null) {
            banner = document.createElement('div')
            banner.id = 'dmb-transport-banner'
            banner.className = 'dmb-banner'
            const text = document.createElement('span')
            text.textContent = T.linkLost
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'dmb-banner-btn'
            button.textContent = T.reload
            button.addEventListener('click', () => window.location.reload())
            banner.appendChild(text)
            banner.appendChild(button)
            document.body.appendChild(banner)
          }
          banner.style.display = 'flex'
          setTimeout(() => {
            if (banner !== null) banner.style.display = 'none'
          }, 12000)
        } catch {
          /* ignore */
        }
      }

      const replayable = (init) => {
        if (init === undefined || init === null) return true
        const body = init.body
        if (body === undefined || body === null) return true
        return typeof body === 'string' || body instanceof ArrayBuffer || (typeof Blob !== 'undefined' && body instanceof Blob)
      }

      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input !== null && input !== undefined ? String(input.url ?? '') : ''
        const method = String((init !== undefined && init !== null && init.method) || (input !== null && input !== undefined && input.method) || 'GET').toUpperCase()
        const watched = url.indexOf('/api/') !== -1 || url.indexOf(BASE) !== -1
        if (!watched || (method !== 'GET' && !replayable(init))) return original(input, init)
        let attempt = 0
        for (;;) {
          try {
            const response = await original(input, init)
            if (RETRY_STATUS.indexOf(response.status) === -1) return response
            if (attempt >= MAX_RETRY) {
              showBanner()
              return response
            }
          } catch (error) {
            if (attempt >= MAX_RETRY) {
              showBanner()
              throw error
            }
          }
          attempt += 1
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt))
        }
      }
    }

    /**
     * 窄屏标记。
     *
     * 真机实测：华为浏览器开「桌面版网站」时 UA 是桌面、viewport meta 被忽略，
     * 布局宽度固定 980 再缩放，media query 判不出来；改用 screen.width 判设备宽度。
     * 结果写到 <html data-dmb-narrow="1">，CSS 用它切换窄屏布局补丁
     * （设置抽屉两级导航、侧栏浮层、图标按钮保圆）。
     */
    function installNarrowFlag() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      const isNarrow = () => {
        const screenWidth = typeof window.screen === 'object' ? Number(window.screen.width) || 0 : 0
        return screenWidth > 0 && screenWidth <= 600 ? true : window.innerWidth <= 520
      }
      let frame = 0
      const apply = () => {
        const html = document.documentElement
        if (html === null) return
        if (isNarrow()) html.setAttribute('data-dmb-narrow', '1')
        else html.removeAttribute('data-dmb-narrow')
        // 侧栏是否展开：宿主用 grid 的第一列给侧栏留宽，展开时手机上会挤掉主内容。
        const sidebar = document.querySelector('[class*="_root"][class*="_quietBars"]')
        const expanded = sidebar !== null && sidebar.getBoundingClientRect().width > 150
        if (expanded) html.setAttribute('data-dmb-sidebar', 'expanded')
        else html.removeAttribute('data-dmb-sidebar')
      }
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          apply()
        })
      }
      // 侧栏展开/收起有动画，MutationObserver 可能只捕捉到中间态；
      // 点击后再补两次延迟测量，确保最终状态被正确写入。
      const scheduleSettled = () => {
        schedule()
        window.setTimeout(apply, 120)
        window.setTimeout(apply, 520)
      }
      document.addEventListener('click', scheduleSettled, true)
      window.addEventListener('resize', schedule, { passive: true })
      window.addEventListener('orientationchange', schedule, { passive: true })
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
      apply()
    }

    /**
     * 侧栏展开态信号。
     *
     * 宿主新版在展开态把侧栏根上的 _quietBars/_collapsed 类都摘掉，只剩 _root，
     * installNarrowFlag 的「_quietBars 根宽度 > 150」判定因此永远看不到展开态。
     * 这里独立维护同一份信号：html[data-dmb-sidebar-open] 供 CSS 使用，
     * 展开根上的 data-dmb-overlay 让浮层/scrim 规则精确命中展开根。
     * 不改 installNarrowFlag 的判定逻辑，两边互不干扰。
     */
    function installSidebarState() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      let frame = 0
      let scrim
      // 触发宿主自己的折叠按钮（收起侧边栏），让收起走宿主状态机。
      const collapseSidebar = () => {
        const logo = document.querySelector('[class*="_logoRow"]')
        const local = logo === null || logo === undefined ? null : logo.querySelector('button[class*="_toggle"]')
        const toggle =
          local !== null
            ? local
            : [...document.querySelectorAll('button[aria-label]')].find((button) => {
                const label = button.getAttribute('aria-label') ?? ''
                return /收起侧边栏|收起侧栏|collapse sidebar/i.test(label) === true && /右侧/.test(label) === false
              })
        if (toggle !== null && toggle !== undefined) toggle.click()
      }
      // 灰色区域点击层：懒建、复用一个；点它只收起侧栏，不把点击穿透给被遮住的内容。
      const ensureScrim = () => {
        if (scrim !== undefined && scrim.isConnected === true) return scrim
        scrim = document.createElement('div')
        scrim.className = 'dmb-scrim'
        scrim.setAttribute('aria-hidden', 'true')
        scrim.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          collapseSidebar()
        })
        document.body.appendChild(scrim)
        return scrim
      }
      const apply = () => {
        const html = document.documentElement
        if (html === null) return
        const column = document.querySelector('[class*="_sidebarCol"]')
        const roots = column === null ? [] : [...column.querySelectorAll('[class*="_root"]')]
        // 侧栏面板内部还有嵌套的 _root，取不被其他 _root 包含的最外层那个。
        const outer = roots.find((node) => !roots.some((other) => other !== node && other.contains(node)))
        const expanded = outer !== undefined && outer.getBoundingClientRect().width > 150
        if (expanded) {
          outer.setAttribute('data-dmb-overlay', '')
          html.setAttribute('data-dmb-sidebar-open', '1')
        } else {
          document.querySelectorAll('[data-dmb-overlay]').forEach((node) => node.removeAttribute('data-dmb-overlay'))
          html.removeAttribute('data-dmb-sidebar-open')
        }
        // 只有「窄屏 + 展开」才显示可点击的灰色遮罩层。
        const narrow = html.getAttribute('data-dmb-narrow') === '1'
        const mask = ensureScrim()
        if (mask !== undefined) mask.style.display = expanded && narrow ? 'block' : 'none'
      }
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          apply()
        })
      }
      // 展开/收起是 CSS 过渡，点击后补两次延迟复查，覆盖 MutationObserver
      // 只看到中间态的情况（同 installNarrowFlag 的做法）。
      const scheduleSettled = () => {
        schedule()
        window.setTimeout(apply, 120)
        window.setTimeout(apply, 520)
      }
      document.addEventListener('click', scheduleSettled, true)
      window.addEventListener('resize', schedule, { passive: true })
      window.addEventListener('orientationchange', schedule, { passive: true })
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
      apply()
    }

    /**
     * 窄屏点会话后自动收起左侧功能栏。
     *
     * 窄屏（data-dmb-narrow=1）下侧栏展开时是覆盖层；点某个会话进入对话后宿主
     * 不会收起侧栏，280px 的列表一直盖着主会话窗口，用户必须再点一次才能看到
     * 会话全景。这里在文档捕获阶段识别「点在会话行上」，短延迟后触发宿主自己的
     * 折叠按钮 —— 收起交给宿主状态机，而不是用样式硬顶，行为与手动点击一致。
     * 仅窄屏生效：桌面宽屏侧栏是常驻列，收起反而碍事。
     */
    function installAutoCollapseOnSessionPick() {
      if (typeof document === 'undefined') return
      let timer
      const toggleOf = () => {
        const logo = document.querySelector('[class*="_logoRow"]')
        const local = logo === null || logo === undefined ? null : logo.querySelector('button[class*="_toggle"]')
        if (local !== null) return local
        // 宿主改类名时的兜底：按 aria-label 找左侧栏开关（避开「右侧边栏」）。
        return [...document.querySelectorAll('button[aria-label]')].find((button) => {
          const label = button.getAttribute('aria-label') ?? ''
          return /收起侧边栏|收起侧栏|collapse sidebar/i.test(label) === true && /右侧/.test(label) === false
        })
      }
      document.addEventListener(
        'click',
        (event) => {
          if (timer !== undefined) return
          const html = document.documentElement
          if (html.getAttribute('data-dmb-narrow') !== '1') return
          const target = event.target instanceof Element ? event.target : null
          if (target === null || typeof target.closest !== 'function') return
          const row = target.closest('[class*="_sessionRow"]')
          if (row === null) return
          // 侧栏尚未展开（或刚收起）就不必动作；sessionRow 只在展开态存在，可作兜底信号。
          const expanded =
            html.getAttribute('data-dmb-sidebar-open') === '1' ||
            document.querySelector('[class*="_sidebarCol"] [class*="_sessionRow"]') !== null
          if (expanded !== true) return
          // 点在行内次级控件（「会话操作」/重命名等）上时不抢收起，把点击还给控件；
          // 点在行主体（标题/时间）上才收起。注意每行常驻一个图标按钮，不能按
          // 「行里有没有 button」判断，必须看点击落点。
          const control = target.closest('button, a, input, [role="menuitem"], [role="checkbox"]')
          if (control !== null && row.contains(control)) return
          // 略等宿主完成会话切换再收起，避免动画期间布局抖动。
          timer = window.setTimeout(() => {
            timer = undefined
            const toggle = toggleOf()
            if (toggle !== undefined) toggle.click()
          }, 160)
        },
        true,
      )
    }

    /**
     * 窄屏打开会话时不自动唤起输入法。
     *
     * 宿主打开会话后会把 composer（contenteditable 的 [data-composer-input]）自动聚焦，
     * 移动端浏览器随之弹出软键盘，遮住刚打开的会话，用户还没看清内容就被挡住。
     * 这里只在「刚点开某个会话」后的短窗口内，把「非用户主动点输入框」而产生的 composer
     * 聚焦立即失焦；用户主动点输入框（指针落在 composer 内）则照常放行 —— 想打字时键盘即到。
     * 桌面宽屏不受影响。
     */
    function installNoAutoKeyboardOnOpen() {
      if (typeof document === 'undefined') return
      const COMPOSER = '[data-composer-input="true"]'
      let suppressUntil = 0
      let pointerTarget = null
      let pointerAt = 0
      const markPointer = (event) => {
        pointerTarget = event.target
        pointerAt = Date.now()
        const target = event.target instanceof Element ? event.target : null
        if (target !== null && target.closest(COMPOSER) !== null) suppressUntil = 0 // 用户主动点输入框，撤销抑制
      }
      const blurComposer = () => {
        const el = document.activeElement
        if (el instanceof Element && el.matches(COMPOSER)) {
          try {
            el.blur()
          } catch {
            /* ignore */
          }
        }
      }
      document.addEventListener('pointerdown', markPointer, true)
      document.addEventListener('touchstart', markPointer, true)
      document.addEventListener('mousedown', markPointer, true)
      document.addEventListener(
        'focusin',
        (event) => {
          if (document.documentElement.getAttribute('data-dmb-narrow') !== '1') return
          if (Date.now() >= suppressUntil) return
          const el = event.target
          if (!(el instanceof Element) || !el.matches(COMPOSER)) return
          const fromComposer =
            pointerTarget instanceof Element &&
            (el === pointerTarget || el.contains(pointerTarget)) &&
            Date.now() - pointerAt < 1500
          if (fromComposer) return
          try {
            el.blur()
          } catch {
            /* ignore */
          }
        },
        true,
      )
      document.addEventListener(
        'click',
        (event) => {
          if (document.documentElement.getAttribute('data-dmb-narrow') !== '1') return
          const target = event.target instanceof Element ? event.target : null
          if (target === null || typeof target.closest !== 'function') return
          const row = target.closest('[class*="_sessionRow"]')
          if (row === null) return
          const control = target.closest('button, a, input, [role="menuitem"], [role="checkbox"]')
          if (control !== null && row.contains(control)) return
          // 打开会话这段时间宿主会自动聚焦 composer，在若干时间点逐个清掉。
          suppressUntil = Date.now() + 2000
          window.setTimeout(blurComposer, 0)
          window.setTimeout(blurComposer, 120)
          window.setTimeout(blurComposer, 350)
          window.setTimeout(blurComposer, 800)
        },
        true,
      )
    }

    /**
     * 窄屏快捷展开左侧功能栏。
     * 收起态是 56px 图标 rail，空白区域（regionArea 等）原本点不动，只能点顶部鲸鱼开关。
     * 这里让 rail 的空白区域可点即展开（真实按钮/会话项保持各自行为），并在空白处显示
     * 一个「› 展开」提示，降低发现成本。
     */
    function installRailOpenShortcut() {
      if (typeof document === 'undefined') return
      let hint
      const ensureHint = () => {
        if (hint !== undefined && hint.isConnected === true) return hint
        hint = document.createElement('div')
        hint.className = 'dmb-rail-hint'
        hint.setAttribute('aria-hidden', 'true')
        hint.innerHTML = '<span class="chev">\u203a</span><span>\u5c55\u5f00</span>'
        document.body.appendChild(hint)
        return hint
      }
      const current = () => {
        const html = document.documentElement
        if (html.getAttribute('data-dmb-narrow') !== '1') return { show: false }
        const col = document.querySelector('[class*="_sidebarCol"]')
        if (col === null) return { show: false }
        const roots = [...col.querySelectorAll('[class*="_root"]')]
        const outer = roots.find((node) => !roots.some((other) => other !== node && other.contains(node)))
        const width = outer === undefined ? 0 : outer.getBoundingClientRect().width
        return { show: width > 0 && width <= 90, col }
      }
      // 软键盘/输入法半屏升起：可视视口被顶起（offsetTop>0）或高度明显缩小。
      // 此时左下角「› 展开」提示会压在键盘区上，需要藏起来、键盘收起后再恢复。
      const keyboardUp = () => {
        const vv = window.visualViewport
        if (!vv) return false
        return vv.offsetTop > 8 || vv.height < window.innerHeight * 0.75
      }
      const update = () => {
        const state = current()
        const node = ensureHint()
        node.style.display = state.show === true && keyboardUp() === false ? 'flex' : 'none'
      }
      const openSidebar = () => {
        const logo = document.querySelector('[class*="_logoRow"]')
        const local = logo === null || logo === undefined ? null : logo.querySelector('button[class*="_toggle"]')
        const toggle =
          local !== null
            ? local
            : [...document.querySelectorAll('button[aria-label]')].find((button) =>
                /打开侧边栏|open sidebar/i.test(button.getAttribute('aria-label') ?? ''),
              )
        if (toggle !== null && toggle !== undefined) toggle.click()
      }
      document.addEventListener(
        'click',
        (event) => {
          const state = current()
          if (state.show !== true) return
          const target = event.target instanceof Element ? event.target : null
          if (target === null || state.col === undefined || state.col.contains(target) !== true) return
          // 真实控件（图标按钮 / 会话项 / 输入等）保持各自行为，不抢点击。
          if (
            target.closest('button, a, input, [role="button"], [role="treeitem"], [role="menuitem"], [tabindex]') !==
            null
          ) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          openSidebar()
        },
        true,
      )
      window.addEventListener('resize', update, { passive: true })
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', update, { passive: true })
        window.visualViewport.addEventListener('scroll', update, { passive: true })
      }
      new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true })
      update()
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return
      ensureStyle()
      installNarrowFlag()
      installSidebarState()
      installRailOpenShortcut()
      installAutoCollapseOnSessionPick()
      installNoAutoKeyboardOnOpen()
      installTransportResilience()
      installSettingsNav()
      installIconButtonFix()
      // 先回执再注册：这样即使 slot 注册失败，宿主也能观测到「半身确实执行到了哪一步」。
      const slots = ctx?.slots ?? (typeof ctx?.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || slots === null) {
        sendHello('no-slots-service')
        return
      }
      const registrations = [
        ['shell.overlay', { name: 'shell.overlay', id: 'dsh-mobile-bridge-approval', order: 900, label: () => T.title }, ApprovalOverlay],
        ['settings.section', { name: 'settings.section', id: 'dsh-mobile-bridge', order: 120, label: () => T.settingsTitle }, SettingsPanel],
      ]
      const failed = []
      for (const [slotName, options, Component] of registrations) {
        try {
          slots.inject(slotName, () => slots.register(options, Component))
        } catch (error) {
          failed.push(`${slotName}:${String(error?.message ?? error).slice(0, 60)}`)
        }
      }
      sendHello(failed.length === 0 ? 'registered' : `partial:${failed.join(';')}`)
    }

    exports.apply = apply
    // 模块级 inject 是**服务键**（不是包名）：loader 据此在 activate 前把服务准备好。
    // 缺了它会表现为「entry did not activate」并阻塞整页 —— 这是实测踩过的坑。
    exports.inject = ['slots']
    exports.name = 'dsh-mobile-bridge'
    return module.exports
  },
})
