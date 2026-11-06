# 开发方案：SakuraFrp 免费穿透 + 密码绑定 + 插件改名「手机分身」

**For agentic workers**: 本文档是唯一实施依据。按任务顺序执行，每个任务先跑测试（红）再实现（绿）。不要偏离「Files/Interfaces」里声明的签名；改签名 = 先停下向用户确认。
**日期**: 2026-11-05 · **工作目录**: `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-mobile-bridge`

## Goal

对 dsh-mobile-bridge v0.5.0 做 5 项改造（用户原话 m00161）：
1. 集成 SakuraFrp（natfrp.com）免费穿透为新的 `tunnelMode: 'sakura'`（frpc 进程托管 + 设置页卡片）；
2. 提供「随机域名」选项（自动解析 frpc 日志中的节点子域）并支持手填自定义域名；
3. 保留 Tailscale 全部能力，界面备注「仅适合国外用户」；
4. 去掉「扫码自动同意」（配对码哈希自动提交 + autoApprovePairing 免确认 + 桌面确认弹窗三件套全拆），改为「密码输入绑定」——绑定密码自动生成随机值、持久化本地 0600、桌面可查看/复制/重生成/改自定义；手机手动输入密码，密码正确即直接绑定（无桌面确认）；
5. 插件在 DSH 插件列表的显示名改为「手机分身」。

## Architecture

现状链路（不变部分）：
- `index.js` apply() → createEdge(127.0.0.1:8787 反代宿主) → createCloudflared(quick/token) → resolvePublicBase 优先级 = config.publicBase → 隧道 URL → Tailscale → LAN → loopback。
- 配对 = 6 位配对码（pairing.js issueCode/verifyCode）+ 二维码内嵌 `#<code>`（pairPage 内联脚本自动填表提交）+ 非 loopback 时 stageConfirm/桌面确认（routes.js /pair/state 轮询、client.js PairCard）。
- 机密只落本地：`<storeDir>/tunnel.json`(0600)、`push.json`(0600)。

改造后链路：
- **隧道**：`tunnel` 变为由 `buildTunnel(config, deps)` 工厂按 `config.tunnelMode` 产出的后端对象（`'quick'|'token'` → createCloudflared；`'sakura'` → createSakuraFrp），对外形状不变（{start,stop,status,url}），index.js 其余代码无感知。`restartTunnel()` 升级为 `rebuildTunnel()`：停旧 → 按 config 重建 → 起新。cloudflare/sakura 两条 setup 路由都调 rebuildTunnel。
- **绑定**：新增 `lib/binding.js`。绑定密码 = 明文存 `<storeDir>/binding.json`(0600)（必须可回显，桌面要「查看/复制」；威胁模型与 tunnel.json 相同）。首次运行懒生成 12 位 URL 安全随机串；verify 用 `crypto.timingSafeEqual`；支持重生成与自定义。QR 只编码纯 URL（无 `#code`），手机手动输密码。
- **配对**：POST /pair 校验密码 → 直接 issueDevice → 303 发 dmb cookie。stageConfirm/resolveConfirm/pollConfirm/pendingConfirm、confirmWaitPage、/pair/state、/devices/confirm、PairCard、pair-request 广播、配对通知 dispatch、autoApprovePairing 全部删除。新增按来源 IP 的失败次数滑动窗口限速。
- **改名**：只改显示名 = locale meta.title + client T.settingsTitle + 文案中「手机桥接」。内部 id/`BASE`/路由前缀/`dmb` cookie 一律不动。

## Tech Stack

Node ≥22 ESM、零新增依赖（现有仅 `qrcode ^1.5.4`）、无 build（源码分发）。frpc 由 SakuraFrp 官方下载页获取，插件只 spawn 不捆绑。

## Spec

### 配置面（index.js）
- DEFAULTS：删除 `autoApprovePairing`、`pairingMaxAttempts`、`pairConfirmTtlMs`；新增 `sakuraToken:''`、`sakuraTunnelId:''`、`sakuraBin:'frpc'`、`sakuraDomain:''`（手填自定义域名，空 = 随机域名）。
- normalize()：`tunnelMode` ∈ `'sakura'|'token'|'quick'`（其余归 'quick'）；`config.tunnelMode = ['sakura','token'].includes(input.tunnelMode) ? input.tunnelMode : 'quick'`；删除 autoApprovePairing 归一化行（旧配置里的未知键被自然忽略，兼容升级）。
- readLocalTunnelConfig/apply()：除现有 `{token,publicBase}` 外，当 `tunnelMode==='sakura'` 且配置里 sakuraToken/sakuraTunnelId 为空时，从 tunnel.json 的 `sakura:{token,tunnelId,domain}` 合并补齐（机密不进配置文件）。

### 隧道后端（lib/sakurafrp.js，新文件，仿 lib/cloudflared.js）
- `parseFrpcUrl(text)`：从 frpc 输出提取访问地址。策略：正则 `/(?:访问地址|访问|URL|url|domain)[^\r\n]*?(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)\s*$/m` 逐行匹配 + 兜底 `/(https?:\/\/[a-z0-9][a-z0-9.-]*\.(?:natfrp\.cloud|frp[a-z0-9-]*\.top))[^\s"']*/i`；解析到即缓存，`onUrl(url)` 回调。
- `createSakuraFrp({config, targetPort, log, onUrl, healthUrl, probe=probeUrl})` → `{start,stop,status,url}`，与 createCloudflared 同形状同纪律：spawn(`frpc`, ['-f', `${token}:${tunnelId}`], {windowsHide:true, stdio:['ignore','pipe','pipe']})（绝不经 shell、token 不进日志）；意外退出指数退避重启（沿用 RESTART_CAP_MS=30_000 / STABLE_MS=5*60_000）；健康探测失败 3 次杀进程交给退避重启；stop() Windows taskkill /T /F 兜底。
- start() 校验：`sakuraToken===''` 或 `sakuraTunnelId===''` → 抛 `'tunnelMode=sakura requires sakuraToken and sakuraTunnelId'`。
- status() 返回 `{enabled,mode:'sakura',running,url,binary,pid,startedAt,lastError,restarts}`。
- 不带参数运行会进 TUI——永远显式传 `-f`。

### publicBase 解析（lib/tunnel.js）
- `resolvePublicBase` 第 2 优先级 `lib/tunnel.js:101` 由 `tunnelUrl.startsWith('https://')` 放宽为 `tunnelUrl.startsWith('http://')`（cloudflared 产 https，frpc 产 http 的 `*.natfrp.cloud` 随机域；这是我们自己 spawn 的进程吐出的值，信任级别同 cloudflared）。SakuraFrp 免费档 HTTP 隧道无 TLS：README 记录「手机→节点为明文 HTTP，敏感环境请用自定义域名+自备 SSL 或 Tailscale/命名隧道」。

### 配对与绑定（lib/binding.js 新文件；lib/pairing.js 瘦身）
- `createBindingManager({dir, log, now=Date.now, randomPassword})` → `{ensure(), verify(input), regenerate(custom?), describe()}`。
  - `ensure()`：binding.json 不存在则生成 12 位 base64url 随机密码写入 `{password, custom:false, createdAt}`（0600，chmod 兜底）；已存在直接返回。
  - `verify(input)`：`typeof input==='string'`、trim 后非空、与存储值做 `timingSafeEqual`（先比长度，不等直接 false）；成功 true。
  - `regenerate(custom?)`：custom 为非空字符串 → 存 trim 值并标 `custom:true`（长度 6–64 校验，不合格抛 `'binding-password-length'`）；否则生成新随机值、`custom:false`。
  - `describe()` → `{hasCustom, createdAt}`（不含密码本体）；密码回显走 /pairing.json（仅 loopback）。
- lib/pairing.js：删除 `issueCode/current/verifyCode/stageConfirm/resolveConfirm/pollConfirm/pendingConfirm`；保留 `issueDevice/authenticate/listDevices/revoke/revokeAll/purgeRevoked/sha256`。createPairing 签名 `{config,store,log}` 不变。
- 失败限速：routes.js 新增 `createPairAttemptLimiter({perMinute=10})`（滑动窗口，复用 createPollLimiter 的 Map 模式，key 复用 `pollKeyOf(req)`）；密码错 403 前 `if (!pairLimiter(key)) → 429 'too-many-attempts'`。

### 路由（lib/routes.js）
- pairPage()：删除内联 `<script>` 哈希自动提交块（lib/routes.js:200-206）；表单 input 改为 `name="password"`（type=password、autocomplete=off、maxlength=64）+ `name="name"`；错误文案新增 wrong-password/too-many；标题副标去「配对码」改「绑定密码」。QR 内容改 `${publicBase}${BASE}/pair`（GET /pair 与 /pairing.json 两处，lib/routes.js:358、:496）。
- GET /pair：不再 issueCode/current；直接渲染页面（loopback 提示当前绑定密码是否已生成无必要——页面不给密码）。
- POST /pair（lib/routes.js:373-458 重写）：`pairLimiter(pollKeyOf(req))` 不过 → 429；`binding.verify(payload.password)` 失败 → 403 pairPage(wrong-password)；成功 → `pairing.issueDevice(payload.name)` → undefined 时 429 limit 文案 → cookies/secure 逻辑原样 → 303 '/'。删除 stageConfirm 分支、confirmWaitPage 渲染、`hub.broadcastLoopback({type:'pair-request'…})`、`notify.dispatch({title:'配对请求'…})`、autoApprove 日志（:446-448）。
- 删除路由：GET /pair/state（:461-485）、POST /devices/confirm（:640-650）；confirmWaitPage() 与 createPollLimiter 中仅 pollLimiter 使用的部分随迁（pollLimiter 保留给新 pairLimiter 复用；/pair/state 专用逻辑删除）。注意保留 `pollKeyOf`（pairLimiter 用）。
- GET /pairing.json（:488-508，仍 loopback-only）：返回 `{ok, publicBase, pairUrl, qrDataUrl, password, hasCustomBinding, createdAt}`；删除 code/expiresAt/remainingMs/pendingConfirm。
- 新增 Sakura 路由（全部 `requireLoopback`，仿 Cloudflare 段 :750-906）：
  - GET /sakura.json → `{ok, frpcInstalled, version, mode, publicBase, hasKey, hasTunnelId, customDomain, running, url, lastError, reachable}`；`frpcInstalled` 用 `detectBinary(config.sakuraBin, ['-v'])`（新增到 sakurafrp.js 导出）。
  - POST /sakura/setup：payload `{token, tunnelId, domainChoice:'auto'|'custom', domain}`；校验 token 非空、tunnelId 非空、custom 时 domain 为合法 `https?://` 前缀 URL（错误码 'sakura-token-required' / 'sakura-tunnelid-required' / 'sakura-domain-invalid'）；写 tunnel.json `sakura:{token,tunnelId,domain}`（**保留文件里既有 token/publicBase/serviceManaged 等其他键**）；config.sakuraToken/sakuraTunnelId/sakuraDomain 更新、tunnelMode='sakura'、tunnelEnabled=true；custom 时 setPublicBase(domain)，auto 时 setPublicBase('')；`await rebuildTunnel()`；返回 `{ok, publicBase: await getPublicBase(), reachable}`。
  - POST /sakura/clear：删 tunnel.json 的 sakura 键 → config 清 sakura 字段 → tunnelMode='quick'、tunnelEnabled=true → setPublicBase('') → rebuildTunnel。
- GET /overview 与 /status：`tunnel:tunnelSummary()` 不变（status() 形状一致即兼容）。

### index.js 装配
- `const binding = createBindingManager({dir: storeDir, log}); binding.ensure()`。
- `buildTunnel()`：`config.tunnelMode==='sakura' ? createSakuraFrp({config, targetPort: config.edgePort, log, healthUrl: ()=>config.publicBase || tunnel?.url?.(), onUrl}) : createCloudflared({…原参数})`；onUrl 逻辑共用（清 publicBaseCache → getPublicBase()）。
- `restartTunnel()` 改为 `rebuildTunnel()`：stop 旧实例 → 等退出（沿用 20×150ms）→ `tunnel = buildTunnel()` → start → 清缓存。deps 里 `restartTunnel` 改传 `rebuildTunnel`（routes 内 cloudflare/setup、sakura/setup、sakura/clear 使用）。

### client.js
- T 文案：`settingsTitle` → '手机分身'/'Phone Mirror'；新增 `bindTitle:'绑定密码'`、`bindHint:'手机打开地址后输入本密码完成绑定。二维码只含地址（不含密码）。'`、`bindCopy/bindCopied/bindRegen/bindRegened/bindCustom/bindCustomPh/bindSaved`、`sfTitle:'SakuraFrp 免费穿透（国内推荐）'`、`sfKeyPh:'访问密钥（用户信息页）'`、`sfTunnelIdPh:'隧道 ID'`、`sfRandom:'随机域名（自动识别，推荐）'`、`sfCustom:'自定义域名（需 CNAME 到节点）'`、`sfDomainPh:'如 http://dsh.example.com'`、`sfDownload:'未检测到 frpc？从这里下载'`、`sfSave/sfClear/sfOk` 等错误/状态文案；`tsNote:'⚠ 仅适合国外用户：国内网络登录与中继不稳定。'`；`pairCode/pairHint` 改为绑定语义或删除（引用点同步）。
- 删除 PairCard()（client.js:536-594）；useApprovalFeed 不再消费 `pair-request`/`pair-request-resolved`（client.js:422-431 删两分支，返回值改为 [items,setItems]；ApprovalOverlay 删 pairRequests 分支）。
- SettingsPanel()（:1241-1327）desktop 分支：「生成配对码」→「查看绑定密码」BindingCard：显示 password（等宽字体）+ 复制 + 重新生成 + 自定义密码输入 + QR + 地址。
- 新增 SakuraCard()（仿 CloudflareCard :928-1092）：状态行 + 密钥/隧道ID/域名三输入 + 随机|自定义 单选 + 保存/停用 按钮 + 下载链接 https://www.natfrp.com/tunnel/download；`h(SakuraCard)` 插在 CloudflareCard 前（:1315-1318 区域）。
- TailscaleCard：末尾 `h('div',{className:'dmb-muted'},T.tsNote)`（保留 tsFallbackHint）。
- **不得改动**：qcard-css.test.mjs 锁定的 CSS（`html[data-dmb-narrow="1"] .wnLwla_*`、`.dmb-rail-hint`、`installRailOpenShortcut`）与 device-management.test.mjs 锁定的 `devicesTitle/devicesLoadError/devices.json/revoke-all/purge` 引用。

### locale（zh.json / en.json）
- `meta.title`: "手机分身" / "Phone Mirror"；`meta.description` 同步为密码绑定语义。
- `pair.*`：h1 "绑定手机"；hint 改「输入电脑上显示的绑定密码」；`code`→`password`("绑定密码")；删 `wait.*` 整组；错误文案补 `wrongPassword/tooMany(沿用)/limit(沿用)`；`title` 去 "DSH Mobile Bridge" 改 "手机分身"。

### cordis.patch.yml / package.json
- patch：删 `autoApprovePairing: true` 块与 `pairConfirmTtlMs`；tunnelMode 注释补 'sakura'；新增 `sakuraToken:''/sakuraTunnelId:''/sakuraBin:'frpc'/sakuraDomain:''` 带注释（默认不启用，tunnelMode 保持 'quick'）。
- package.json：description 改「密码配对」语义；`scripts.check` 增加 `lib/binding.js`、`lib/sakurafrp.js`；`scripts.test` 中 `pairing-confirm.test.mjs` 替换为 `binding.test.mjs`，追加 `sakurafrp.test.mjs`、`pair-password.test.mjs`。

### README.md / README.en.md
- 「扫码即用」→「输密码即绑」；配对章节改为绑定密码流程；删除免确认模式段落；接入表加 SakuraFrp 行 + 固定地址章节加 SakuraFrp 小节（随机子域 vs 自定义域 CNAME、免费档限制 2 隧道/5GiB/10Mbps、HTTP 明文提示、下载地址）；Tailscale 标注「仅适合国外用户」；「手机桥接」→「手机分身」；配置示例同步。

## Global Constraints

1. Node ≥22 ESM；零新增依赖；无 build 脚本。
2. 内部 id `dsh-mobile-bridge`、`BASE`、路由前缀、`dmb` cookie、PWA manifest、`/plugins/` 资源路径一律不改。
3. 机密（绑定密码、SakuraFrp 访问密钥）只落 `<storeDir>/*.json`(0600)，绝不进仓库/配置/日志。
4. `lib/edge.js` 一行不动（routes-security.test.mjs 断言其 302 与 x-dmb-forwarded-for 注入）。
5. 每任务结束 `node --check` 相关文件 + 对应测试绿；全部完成后 `npm run check && npm test` 全绿。
6. 老 tunnel.json（cloudflare {token,publicBase,serviceManaged}）必须向后兼容：sakura 写入只增删 `sakura` 键，不动其他键。

## Review Focus（spec 之外会咬人的输入，每个都在对应任务里有测试）

1. **frpc 日志 URL 格式漂移**（多语言/改版）：parseFrpcUrl 用 ≥4 组 fixture（访问地址行、裸 natfrp.cloud、frp-*.top、无 URL）测试；解析失败时 status.lastError 提示手填自定义域名兜底。
2. **http 明文 publicBase**：resolvePublicBase 放宽后，配对 cookie Secure 判定走 x-dmb-proto（edge 透传真实协议）；测试断言 http publicBase 时 set-cookie 无 `; Secure`（merge-cookie/既有行为回归）。
3. **空/空白 token 与 tunnelId**：createSakuraFrp.start() 校验 + /sakura/setup 400 错误码单测。
4. **密码输入的 unicode/空白**：verify 前统一 trim；长度不等直接 false（timingSafeEqual 前置长度比较）；空密码恒 false。
5. **legacy 配置升级**：normalize 不再认识 autoApprovePairing/pairConfirmTtlMs → 旧 patch.yml 用户加载不崩（未知键忽略）；pairing-limits/auto-approve 旧测试被替换而非残留。

## Tasks

### Task 1 — 绑定密码管理器
**Files**: Create `lib/binding.js`, `test/binding.test.mjs`
**Interfaces**: Consumes `node:crypto`, `node:fs`；Produces `createBindingManager({dir,log,now?,randomPassword?}) → {ensure,verify,regenerate,describe}`（见 Spec）。
- [ ] 写 `test/binding.test.mjs`（失败测试）：首跑生成 12 位密码并落盘 0600；重复 ensure 幂等；verify 正确/错误/空/带空白；regenerate() 新随机值生效、regenerate('自定义密码') 落盘且 hasCustom=true、短密码抛 'binding-password-length'；文件权限 0600（mode 断言放宽为「不含 group/other 读位」以兼容 Windows）。
- [ ] 运行测试确认失败；实现 `lib/binding.js`；运行通过；`node --check lib/binding.js`。

### Task 2 — pairing 瘦身 + 旧测试迁移
**Files**: Modify `lib/pairing.js`；Delete logic in `test/pairing-confirm.test.mjs`（改写为 `test/binding-flow.test.mjs` 或并入 Task 6 路由测试）；Update `test/pairing-limits.test.mjs`、`test/auto-approve.test.mjs` → 删除
**Interfaces**: Produces `createPairing({config,store,log}) → {issueDevice,authenticate,listDevices,revoke,revokeAll,purgeRevoked,sha256}`。
- [ ] 删除 issueCode/current/verifyCode/stageConfirm/resolveConfirm/pollConfirm/pendingConfirm 及其内部状态。
- [ ] 删除 `test/auto-approve.test.mjs`、`test/pairing-limits.test.mjs`；`scripts.test` 去掉 `pairing-confirm.test.mjs`（Task 6 用 `pair-password.test.mjs` 顶上）。
- [ ] 跑 `node test/device-management.test.mjs` 确认 devices 相关路径未破坏。

### Task 3 — SakuraFrp 隧道后端
**Files**: Create `lib/sakurafrp.js`, `test/sakurafrp.test.mjs`
**Interfaces**: Produces `parseFrpcUrl(text)`, `detectSakuraBin(bin)`, `createSakuraFrp({config,targetPort,log,onUrl,healthUrl,probe?}) → {start,stop,status,url}`。
- [ ] 写 `test/sakurafrp.test.mjs`：parseFrpcUrl 对 4 组 fixture（见 Review Focus 1）；空 token/tunnelId start() 抛错；`tunnelMode!=='sakura'` 时 start() no-op（status.enabled=false）；假 binary（node 脚本假扮 frpc 输出 URL）下 start → onUrl 收到解析地址 → status.running=true → stop 后 running=false（inject probe stub 避免真探测）。
- [ ] 实现（从 lib/cloudflared.js 复制骨架改 spawn 参数与解析）；`node --check` + 测试绿。

### Task 4 — resolvePublicBase 放宽 http
**Files**: Modify `lib/tunnel.js`；Modify `test/tunnel-resolve.test.mjs`
- [ ] 测试追加：`resolvePublicBase(config={publicBase:''}, 8787, [], log, 'http://frp-x.natfrp.cloud')` → 返回该 http 地址。
- [ ] 实现 `lib/tunnel.js:101` 放宽；既有 https 用例不回归。

### Task 5 — index.js 配置/工厂/合并
**Files**: Modify `index.js`
**Interfaces**: 内部 `buildTunnel()`, `rebuildTunnel()`；deps 传给 registerRoutes 增加 `binding`、`rebuildTunnel`（替换 `restartTunnel`）。
- [ ] DEFAULTS/normalize/apply 按 Spec 修改（含 tunnel.json `sakura{}` 合并）。
- [ ] binding 装配 + ensure()。
- [ ] buildTunnel/rebuildTunnel；`tunnelEnabled` 为 true 时启动逻辑不变（sakura 也走 `if (config.tunnelEnabled) void tunnel.start()`）。
- [ ] `node --check index.js`；`node test/cloudflared.test.mjs` 不回归。

### Task 6 — routes 重写配对 + Sakura 路由
**Files**: Modify `lib/routes.js`；Create `test/pair-password.test.mjs`、`test/sakura-routes.test.mjs`（可并入 pair-password）
**Interfaces**: registerRoutes deps 增 `binding`、`rebuildTunnel`（均需容错 undefined → 相关路由 503，仿 notify 段 :915-918）。
- [ ] 写 `test/pair-password.test.mjs`（失败测试）：正确密码（非 loopback 头）→ 303 + dmb cookie + **无 pair-request 广播**；错误密码 → 403 页面含错误文案；连续 11 次错 → 429；loopback 提交同样直发；/pairing.json 返回 password 且非 loopback 403；GET /pair 页面无 `requestSubmit` 内联脚本、QR src 的 URL 不含 `#`。
- [ ] 写 sakura 路由测试：/sakura/setup 校验错误码、写 tunnel.json 保留旧键、config 变更；/sakura/clear 复位；非 loopback 403。
- [ ] 实现 routes 改动（Spec 全量）；`node --check lib/routes.js`；`node test/routes-security.test.mjs` 不回归。
- [ ] 全部测试脚本归位：更新 `package.json` scripts（check/test 列表）。

### Task 7 — client.js 设置页
**Files**: Modify `client.js`
- [ ] 文案 T 增删（Spec 清单）；settingsTitle 改「手机分身」。
- [ ] 删 PairCard + pair-request 分支；ApprovalOverlay 只剩审批卡。
- [ ] BindingCard（密码显示/复制/重生成/自定义）+ SakuraCard；SettingsPanel 挂载顺序 BindingCard → SakuraCard → TailscaleCard（含 tsNote）→ CloudflareCard → ChannelCard。
- [ ] `node --check client.js`；`node test/device-management.test.mjs`、`node test/qcard-css.test.mjs` 不回归。

### Task 8 — locale 改名与文案
**Files**: Modify `locale/zh.json`, `locale/en.json`
- [ ] meta.title="手机分身"/"Phone Mirror"；pair.* 按 Spec 重写；删 wait.*。
- [ ] JSON.parse 校验两文件（脚本或 node -e）。

### Task 9 — patch/package/README
**Files**: Modify `cordis.patch.yml`, `package.json`, `README.md`, `README.en.md`
- [ ] 按 Spec 修改（README 两语言同步，Tailscale 备注与 SakuraFrp 章节齐全，HTTP 明文披露）。

### Task 10 — 全量验证
- [ ] `npm run check` 全绿。
- [ ] `npm test` 全绿。
- [ ] 手动冒烟（本机）：`plugin_manager` 重装 bundle → Desktop 设置页出现「手机分身」→ BindingCard 显示密码 → SakuraCard 填假密钥报 required → frpc 真实密钥连通后地址出现、手机输密码绑定成功（此步需用户提供 frpc 密钥/隧道 ID，无法自动化则如实报告）。

## Self-Review

- 5 项需求覆盖：Task 1/2/6（④密码绑定+去自动同意）、Task 3/5/6（①SakuraFrp）、Task 3/6/7（②随机域名+手填域名）、Task 7（③Tailscale 备注）、Task 7/8/9（⑤改名）——全覆盖。
- 每个任务步骤单一可执行、测试先行；签名集中在 Interfaces，无函数体内联。
- Review Focus 5 项均落到具体测试（Task 3、4、6 的用例名）。
- 删除面确认：confirmWaitPage、/pair/state、/devices/confirm、PairCard、pair-request 通知、autoApprovePairing、pairingMaxAttempts、pairConfirmTtlMs、旧三测试文件——无半删残留。

## Execution Handoff

两份方案（本文档 + [测试方案](./2026-11-05-sakurafrp-password-binding.test-plan.md)）已保存，等用户评审。执行方式二选一：
- **Native（推荐）**：单人按 Task 1→10 顺序在本会话内联执行。理由：client.js/routes.js/index.js 三处契约强耦合（deps 新增 binding/rebuildTunnel、tunnel 工厂、T 键增删互相引用），拆给子代理会产生接口漂移与合并成本；任务总量约 10 步，内联更可控。
- Subagent-driven：仅在希望并行（如 README/locale 与核心代码并行）时选用，需先冻结 Interfaces 再派发。
